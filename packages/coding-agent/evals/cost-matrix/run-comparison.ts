import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTwoFilesPatch } from "diff";
import { liveBoundaryExtension, liveToolViolation } from "./tool-boundary.ts";
import { completeDelivery } from "./delivery-cycle.ts";
import { SubagentReadonlyReviewer } from "../../src/core/delivery/reviewer-runtime.ts";
import type { ReviewResult } from "../../src/core/delivery/types.ts";
import { RpcSubagentSessionFactory } from "../../src/core/subagents/rpc-session.ts";
import { SubagentRuntime } from "../../src/core/subagents/subagent-runtime.ts";
import { CurrentWorkspaceProvider } from "../../src/core/subagents/workspace-provider.ts";
import { ModelGateway } from "../../src/core/workflow/model-gateway.ts";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, PlanWorkflowRuntime, SessionManager, SettingsManager } from "../../src/index.ts";
import type { AgentSession } from "../../src/index.ts";
import { DELIVERY_BASELINE_ENTRY } from "../../src/core/delivery/baseline.ts";
import { captureEvaluationBaseline } from "./baseline.ts";
import { boundedText, compactVerification } from "./evidence.ts";
import { thinkingAudit } from "./thinking-audit.ts";
import { WORKFLOW_NETWORK_RETRY } from "../../src/core/workflow/network-policy.ts";

import { ExecutionWatchdog, LONG_TASK_WATCHDOG, type WatchdogStop } from "../../src/core/workflow/execution-watchdog.ts";

const repo = resolve('.');
function hashes(directory: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '__pycache__', '.pytest_cache', '.vite', '.next', 'test-results'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, hashes(join(directory, entry.name), `${name}/`));
    else result[name] = createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex');
  }
  return result;
}
const root = join(repo, 'packages/coding-agent/evals/cost-matrix');
const matrix = JSON.parse(readFileSync(join(repo, 'matrix.json'), 'utf8'));
const taskId = process.argv[3];
const selected = matrix.tasks[taskId];
assert.ok(selected, 'Unknown task; use MODE TASK [ARM]');
const paid = selected.output;
const freeze = JSON.parse(readFileSync(join(repo, 'freeze-manifest.json'), 'utf8'));
function assertFrozen() {
  for (const [path, hash] of Object.entries(freeze.files)) assert.equal(createHash('sha256').update(readFileSync(join(repo, path))).digest('hex'), hash, `Frozen file changed: ${path}`);
}
assertFrozen();
assert.ok(freeze.files['packages/coding-agent/evals/cost-matrix/run-comparison.ts'], 'Snapshot must seal the new launcher');
assert.ok(freeze.files['packages/coding-agent/src/core/workflow/execution-watchdog.ts'], 'Snapshot must seal the watchdog');
assert.ok(['--offline-check', '--preflight', '--run-paid'].includes(process.argv[2]), 'Use --offline-check TASK, --preflight TASK or --run-paid TASK ARM');
if (process.argv[2] === '--offline-check') {
  for (const arm of Object.keys(selected.arms)) assert.deepEqual(hashes(selected.arms[arm].workspace), selected.arms[arm].hashes);
  console.log(JSON.stringify({ taskId, paidCalls: 0, frameworkDigest: freeze.digest, matchedArms: Object.keys(selected.arms).length }));
  process.exit(0);
}
const runtime = await ModelRuntime.create();
const models = [...new Set(['sol', ...Object.keys(selected.arms)])].map(name => {
  const model = runtime.getModel('qingyingxy', `gpt-5.6-${name}`);
  assert.ok(model && runtime.hasConfiguredAuth('qingyingxy'), `Model/auth unavailable: ${name}`);
  return { name, id: model.id, provider: model.provider, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
});
const task: string = selected.objective + '\nRead the common acceptance files in .acceptance and the existing project tests. Implement within the business-source roots; do not modify tests, dependencies or unrelated projects.';
const initial = selected.arms;
const tools = ['read', 'edit', 'write', 'grep', 'find', 'ls', 'new_context', 'history', 'notes'];
const dependencies: string[] = selected.adapter.dependencyRoots;
const boundaryFile = join(root, 'tool-boundary.ts');
const contextManagement = { mode: 'windowed' as const, reserveTokens: 16384 };
const protocol = { version: 'cost-matrix-adapter-v6', taskId, adapter: selected.adapter, frameworkDigest: freeze.digest, models, thinking: { sol: 'xhigh', luna: 'max', terra: 'high' }, contextManagement,
  executionWatchdog: LONG_TASK_WATCHDOG, networkRetry: WORKFLOW_NETWORK_RETRY, maxRepairs: 1, tools, task, order: Object.keys(selected.arms), completionCriterion: selected.completionCriterion ?? 'tests-and-review',
  limitations: ['Configured-rate estimates, not invoices', 'One trial per arm', 'Shared installed external dependencies', 'Tool boundary is not an OS sandbox', 'SDK/Plan/RPC pipeline with common external acceptance and repair adapter'] };

async function run(arm: string) {
  assert.ok(protocol.order.includes(arm));
  const output = join(paid, arm);
  const auditPath = join(output, 'thinking-audit.jsonl');
  const workspace: string = initial[arm].workspace;
  assert.ok(!existsSync(join(output, 'started.json')), 'Already started: do not rerun or discard costs');
  assert.deepEqual(hashes(workspace), initial[arm].hashes);
  const policy = { workspace, dependencyRoots: dependencies, writeRoots: selected.adapter.writeRoots as string[], writable: true };
  const before = Object.fromEntries(Object.keys(initial[arm].hashes).filter(path => !liveToolViolation(policy, 'write', { path })).map(path => [path, readFileSync(join(workspace, path), 'utf8')]));
  const route = { enabled: true, policy: 'planner_executor' as const, fastModel: `qingyingxy/gpt-5.6-${arm}`, balancedModel: 'qingyingxy/gpt-5.6-sol', strongModel: 'qingyingxy/gpt-5.6-sol', respectExplicitModel: true };
  const sessions: { stage: string; session: AgentSession }[] = [];
  let stopped = false;
  const watchdogStops: { stage: string; evidence: WatchdogStop }[] = [];
  const monitors: ExecutionWatchdog[] = [];
  const unsubscribers: (() => void)[] = [];
  function stopForWatchdog(stage: string, evidence: WatchdogStop) {
    if (stopped) return;
    watchdogStops.push({ stage, evidence });
    stopped = true;
    for (const { session } of sessions) {
      session.sessionManager.appendCustomEntry('host_stop', { stage, evidence, stoppedAt: Date.now() });
      void session.abort().catch(() => undefined);
    }
    for (const agent of agents.list()) if (['running', 'starting', 'waiting'].includes(agent.status)) void agents.interrupt(agent.id, `Execution watchdog: ${JSON.stringify(evidence)}`).catch(() => undefined);
  }
  let failure: string | undefined;
  let passed = false;
  let review: ReviewResult | undefined;
  let repairCount = 0;
  const startedAt = Date.now();
  const agents = new SubagentRuntime({ workspaceProvider: new CurrentWorkspaceProvider(), modelGateway: new ModelGateway(runtime, route), maxAgents: 1, executionWatchdog: protocol.executionWatchdog,
    sessionFactory: { create(config) {
      assertFrozen();
      assert.equal(resolve(config.cwd), resolve(workspace), 'Child left assigned workspace');
      const expected = config.profile.role === 'worker' ? `qingyingxy/gpt-5.6-${arm}` : 'qingyingxy/gpt-5.6-sol';
      assert.equal(config.modelName, expected, 'Unexpected model routing');
      const childPolicy = { ...policy, writable: config.profile.role === 'worker' && config.effectivePermissions.write };
      const thinkingLevel = config.profile.role === 'worker' && arm === 'luna' ? 'max' : config.profile.role === 'worker' && arm === 'terra' ? 'high' : 'xhigh';
      const child = new RpcSubagentSessionFactory({ systemPromptFile: join(output, `system-prompt-${config.profile.role}-${Date.now()}.txt`), command: process.execPath,
        commandArgs: [join(repo, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(repo, 'tsconfig.json'), join(repo, 'packages/coding-agent/src/cli.ts'), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '-e', boundaryFile, '-e', join(root, 'thinking-audit.ts')],
        env: { PI_MATRIX_TOOL_BOUNDARY: JSON.stringify(childPolicy), PI_CODING_AGENT_DIR: getAgentDir(), PI_MATRIX_PROVIDER_KEY: process.env.PI_MATRIX_PROVIDER_KEY ?? '', PI_MATRIX_THINKING_AUDIT: auditPath, PI_MATRIX_STAGE: config.profile.role }, thinkingLevel }).create({ ...config, profile: { ...config.profile, thinkingLevel },
          toolNames: config.toolNames.filter(name => tools.includes(name)), ...(config.contextWindow ? { contextWindow: { ...config.contextWindow, sessionDir: join(output, 'worker-sessions') } } : {}) });
      child.onEvent(event => {
        if (typeof event === 'object' && event && 'type' in event && event.type === 'tool_execution_start') {
          const record = event as { toolName?: string; args?: unknown };
          toolEvents.push({ role: config.profile.role, tool: record.toolName, input: record.args });
        }
      });
      return child;
    } },
    verificationRunner: async () => { throw new Error('Worker must not invoke external acceptance'); },
  });
  unsubscribers.push(agents.subscribe(event => {
    if (event.type === 'stopping' && event.message?.startsWith('Execution watchdog: ')) {
      stopForWatchdog(event.agentId, JSON.parse(event.message.slice('Execution watchdog: '.length)));
    }
  }));
  const toolEvents: unknown[] = [];
  const cost = () => sessions.reduce((sum, entry) => sum + entry.session.getSessionStats().cost, 0) + agents.list().reduce((sum, agent) => sum + agent.usage.cost, 0);
  function checkLimit() {
    if (stopped) throw new Error('Execution watchdog stopped the arm');
    assertFrozen();
  }
  async function sessionFor(stage: string, writable: boolean, plan = false) {
    checkLimit();
    const settingsManager = SettingsManager.inMemory({ contextManagement, retry: WORKFLOW_NETWORK_RETRY });
    const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [liveBoundaryExtension({ ...policy, writable }), thinkingAudit(auditPath, stage)] });
    await resourceLoader.reload();
    const created = await createAgentSession({ cwd: workspace, workflowNetworkRetry: true, modelRuntime: runtime, model: runtime.getModel('qingyingxy', 'gpt-5.6-sol'), settingsManager, resourceLoader, thinkingLevel: 'xhigh', tools: writable ? tools : tools.filter(name => name !== 'edit' && name !== 'write'), sessionManager: SessionManager.create(workspace, join(output, stage)), ...(plan ? { modelRouting: route, modelRoutingUserOverride: false, subagentRuntime: agents } : {}) });
    sessions.push({ stage, session: created.session });
    assert.equal(created.session.thinkingLevel, 'xhigh', 'Parent thinking silently clamped');
    created.session.enableWorkflowTracking(plan ? 'plan' : 'direct', plan, undefined, { maxRetries: 0, maxConcurrentAgents: 1, maxConcurrentJobs: 1 });
    return created.session;
  }
  function integrity() {
    const after = hashes(workspace);
    for (const path of new Set([...Object.keys(initial[arm].hashes), ...Object.keys(after)])) if (liveToolViolation(policy, 'write', { path })) assert.equal(after[path], initial[arm].hashes[path], `Protected input modified: ${path}`);
    return after;
  }
  async function monitoredPrompt(session: AgentSession, stage: string, prompt: string, isolated = false) {
    const monitor = new ExecutionWatchdog(protocol.executionWatchdog, evidence => stopForWatchdog(stage, evidence));
    monitors.push(monitor);
    const unsubscribe = session.subscribe(event => monitor.observe(event));
    try {
      await session.prompt(prompt, isolated ? { isolatedDirectExecution: { reason: 'Host-authorized isolated evaluation' } } : undefined);
      checkLimit();
    } finally {
      unsubscribe();
      monitor.dispose();
    }
  }
  writeFileSync(join(output, 'started.json'), JSON.stringify({ arm, startedAt: new Date(startedAt).toISOString(), protocol }, null, 2));
  try {
    const common = `${task}\nExternal host runs identical acceptance and independent sol review; at most one sol repair. Do not force context cuts. No shell calls.`;
    const execution = await sessionFor(arm === 'sol' ? 'execution' : 'planning', arm === 'sol', arm !== 'sol');
    await monitoredPrompt(execution, arm === 'sol' ? 'execution' : 'planning', common + (arm === 'sol' ? '\nImplement directly without delegation. Return when implementation is ready for external acceptance.' : '\nRead relevant code and submit exactly one Worker implementation step. No command or reviewer steps; external host owns tests and review. Use only diff verification requirements. Worker implements and returns, without shell commands.'), arm === 'sol');
    if (arm !== 'sol') {
      const view = execution.getWorkflowView();
      const steps = view?.plan?.steps ?? [];
      assert.equal(steps.length, 1, 'Exactly one Worker is allowed');
      assert.equal(steps[0].kind, 'agent');
      assert.equal(steps[0].requiredAgentRole, 'worker');
      assert.ok(steps[0].fileIntents.every(intent => !liveToolViolation(policy, intent.action === 'inspect' ? 'read' : 'write', { path: intent.path })));
      assert.ok(view?.plan?.verificationRequirements.every(requirement => requirement.kind === 'diff' && !requirement.command));
      execution.sessionManager.appendCustomEntry(DELIVERY_BASELINE_ENTRY, captureEvaluationBaseline(workspace, view!.workflow.id,
        policy.writeRoots.filter(path => existsSync(join(workspace, path))), selected.adapter.frontend));
      execution.decideWorkflowPlan('approve', 'User authorized one Worker within fixed business-source boundaries');
      while (!stopped) {
        const result = await execution.waitForWorkflowAutomation();
        if (result?.terminal) break;
        if (result?.waitingReason && result.waitingReason !== 'active_resources') throw new Error(`Workflow stalled: ${result.waitingReason}`);
        if (['completed', 'failed', 'cancelled'].includes(execution.getWorkflowView()?.workflow.status ?? '')) break;
        await delay(100);
      }
      const final = execution.getWorkflowView();
      writeFileSync(join(output, 'workflow.json'), JSON.stringify(final, null, 2));
      assert.equal(final?.workflow.status, 'completed', `Execution did not complete: ${final?.stopReason ?? final?.workflow.status}`);
      const workers = agents.list().filter(agent => agent.profile?.role === 'worker');
      assert.equal(workers.length, 1);
      assert.ok(workers[0].handoffId && !workers[0].lastError, 'Worker did not return completed handoff');
    } else {
      assert.equal(execution.getWorkflowView()?.workflow.status, 'completed', 'Direct execution failed before acceptance');
    }
    for (const agent of agents.list()) if (agent.status === 'idle') await agents.release(agent.id);
    const reviewPlan = PlanWorkflowRuntime.start(SessionManager.inMemory(), { workflowId: `live-${arm}`, rootTaskId: 'root', planId: 'review', request: { text: task, cwd: workspace, attachments: [] } });
    const reviewer = new SubagentReadonlyReviewer(agents);
    const delivery = await completeDelivery({
      completionCriterion: protocol.completionCriterion,
      async verify(attempt) {
      checkLimit();
      integrity();
      const verifyOutput = join(output, `verification-${attempt + 1}`);
      const command = `"${process.execPath}" "${join(root, 'verify-task.mjs')}" ${taskId} "${workspace}" "${verifyOutput}"`;
      const checked = spawnSync(process.execPath, [join(root, 'verify-task.mjs'), taskId, workspace, verifyOutput], { cwd: repo, encoding: 'utf8', timeout: 600000, windowsHide: true });
      const backendLog = join(verifyOutput, taskId === 'memory-organization' ? 'backend/pytest.txt' : 'live/backend.txt');
      const log = `${checked.stdout ?? ''}${checked.stderr ?? ''}${checked.error ?? ''}${existsSync(backendLog) ? readFileSync(backendLog, 'utf8') : ''}`;
      const verification = { exitCode: checked.status, log, result: existsSync(join(verifyOutput, 'results.json')) ? JSON.parse(readFileSync(join(verifyOutput, 'results.json'), 'utf8')) : undefined };
      writeFileSync(join(output, `verification-${attempt + 1}.json`), JSON.stringify(verification, null, 2));
      writeFileSync(join(output, `cost-at-verification-${attempt + 1}.json`), JSON.stringify({ attempt: attempt + 1, passed: checked.status === 0 && verification.result?.passed === true, recordedCost: cost(), sessions: sessions.map(entry => ({ stage: entry.stage, stats: entry.session.getSessionStats() })), agents: agents.list(), recordedAt: new Date().toISOString() }, null, 2));
      return { passed: checked.status === 0 && verification.result?.passed === true, infrastructureComplete: !checked.error && verification.result?.infrastructureComplete === true, exitCode: checked.status, command, log: compactVerification(verification.result, existsSync(backendLog) ? readFileSync(backendLog, 'utf8') : '', `${checked.stdout ?? ''}${checked.stderr ?? ''}${checked.error ?? ''}`) };
      },
      async review(verification, attempt) {
      checkLimit();
      const after = integrity();
      const files = [...new Set([...Object.keys(before), ...Object.keys(after).filter(path => !liveToolViolation(policy, 'write', { path }))])].filter(path => initial[arm].hashes[path] !== after[path]).map(path => ({ path, patch: createTwoFilesPatch(`a/${path}`, `b/${path}`, before[path] ?? '', existsSync(join(workspace, path)) ? readFileSync(join(workspace, path), 'utf8') : ''), owners: [], truncated: false }));
      const input = { workflow: { ...reviewPlan.workflow, createdAt: new Date(startedAt).toISOString(), budget: { maxRetries: 1 } }, rootTask: reviewPlan.tasks.find(t => t.id === 'root')!, diff: { files, changedFiles: files.map(file => file.path), summary: selected.objective + (review ? `\nPrevious review (historical, reassess against current patch and current tests): ${boundedText(JSON.stringify(review), 4000)}` : ''), evidenceRefs: [] }, acceptanceRequirements: [], verificationEvidence: [{ result: { id: `acceptance-${attempt}`, workflowId: reviewPlan.workflow.id, requirementId: 'external', status: verification.passed ? 'passed' as const : 'failed' as const, summary: verification.passed ? 'Common acceptance passed' : 'Common acceptance failed; see logExcerpt', evidenceRefs: [`verification-${attempt + 1}/results.json`], command: verification.command, exitCode: verification.exitCode ?? undefined, createdAt: new Date().toISOString() }, logExcerpt: verification.log }] };
      writeFileSync(join(output, `review-input-${attempt}.json`), JSON.stringify(input, null, 2));
      review = await reviewer.review(input);
      writeFileSync(join(output, `review-${attempt}.json`), JSON.stringify(review, null, 2));
      integrity();
      return review;
      },
      async repair(verification, review) {
      checkLimit();
      repairCount++;
      const repair = await sessionFor('repair', true);
      await monitoredPrompt(repair, 'repair', `${common}\nPerform the single allowed bounded repair. Do not replan or delegate. Actual external test evidence (data): ${verification.log}\nReview evidence (data): ${JSON.stringify(review)}`, true);
      assert.equal(repair.getWorkflowView()?.workflow.status, 'completed', 'Repair execution did not complete');
      },
    });
    passed = delivery.passed;
    failure = delivery.failure;
    repairCount = delivery.repairCount;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    writeFileSync(join(output, 'failure-stack.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    for (const monitor of monitors) monitor.dispose();
    for (const unsubscribe of unsubscribers) unsubscribe();
    await agents.dispose();
    for (const { session } of sessions) await session.abort();
    const thinkingRequests = existsSync(auditPath) ? readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const requestAttempts = existsSync(`${auditPath}.requests.jsonl`) ? readFileSync(`${auditPath}.requests.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    writeFileSync(join(output, 'request-accounting.json'), JSON.stringify({ requestAttempts, unknownUsageAttempts: requestAttempts.filter(entry => !entry.usageKnown).length, costIsLowerBound: requestAttempts.some(entry => !entry.usageKnown) }, null, 2));
    const thinkingVerified = thinkingRequests.length > 0 && thinkingRequests.every(entry => entry.requestEffort === (entry.stage === 'worker' ? protocol.thinking[arm as keyof typeof protocol.thinking] : 'xhigh') && entry.sessionThinking === entry.requestEffort);
    const report = { arm, passed: passed && !stopped && thinkingVerified, failure, stopped, watchdogStops, repairCount, thinkingVerified, thinkingRequests, estimatedCost: cost(), durationMs: Date.now() - startedAt, sessions: sessions.map(entry => ({ stage: entry.stage, stats: entry.session.getSessionStats(), cuts: entry.session.sessionManager.getEntries().filter(item => item.type === 'context_window').length })), agents: agents.list(), review, protocol };
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(output, 'child-tool-events.json'), JSON.stringify(toolEvents, null, 2));
    for (const { session } of sessions) session.dispose();
    assertFrozen();
    console.log(JSON.stringify({ arm, passed: report.passed, failure, estimatedCost: report.estimatedCost, repairCount }));
  }
}
if (process.argv[2] === '--preflight') {
  assert.ok(!existsSync(join(paid, 'protocol.json')), 'Protocol already frozen');
  writeFileSync(join(paid, 'protocol.json'), JSON.stringify(protocol, null, 2));
  console.log(JSON.stringify({ models, frameworkDigest: freeze.digest, paidCalls: 0, executionWatchdog: protocol.executionWatchdog }));
} else {
  assert.deepEqual(JSON.parse(readFileSync(join(paid, 'protocol.json'), 'utf8')), protocol, 'Protocol changed');
  await run(process.argv[4]);
}
