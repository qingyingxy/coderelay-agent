import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createTwoFilesPatch } from "diff";
import { liveBoundaryExtension, liveToolViolation } from "./tool-boundary.ts";
import { SubagentReadonlyReviewer } from "../../src/core/delivery/reviewer-runtime.ts";
import type { ReviewResult } from "../../src/core/delivery/types.ts";
import { RpcSubagentSessionFactory } from "../../src/core/subagents/rpc-session.ts";
import { SubagentRuntime } from "../../src/core/subagents/subagent-runtime.ts";
import { CurrentWorkspaceProvider } from "../../src/core/subagents/workspace-provider.ts";
import { ModelGateway } from "../../src/core/workflow/model-gateway.ts";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, PlanWorkflowRuntime, SessionManager, SettingsManager } from "../../src/index.ts";
import type { AgentSession } from "../../src/index.ts";
import { captureScopedDeliveryBaseline, DELIVERY_BASELINE_ENTRY } from "../../src/core/delivery/baseline.ts";

import { ExecutionWatchdog, LONG_TASK_WATCHDOG, type WatchdogStop } from "../../src/core/workflow/execution-watchdog.ts";

const repo = resolve('.');
function hashes(directory: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '__pycache__', '.pytest_cache', '.vite'].includes(entry.name) || entry.isSymbolicLink()) continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, hashes(join(directory, entry.name), `${name}/`));
    else result[name] = createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex');
  }
  return result;
}
const root = join(repo, '.artifacts/live-controls-cost-preflight');
const paid = join(root, 'paid');
const freeze = JSON.parse(readFileSync(join(repo, 'freeze-manifest.json'), 'utf8'));
function assertFrozen() {
  for (const [path, hash] of Object.entries(freeze.files)) assert.equal(createHash('sha256').update(readFileSync(join(repo, path))).digest('hex'), hash, `Frozen file changed: ${path}`);
}
assertFrozen();
assert.ok(freeze.files['packages/coding-agent/evals/live-controls/run-comparison.ts'], 'Snapshot must seal the new launcher');
assert.ok(freeze.files['packages/coding-agent/src/core/workflow/execution-watchdog.ts'], 'Snapshot must seal the watchdog');
assert.ok(['--preflight', '--run-paid'].includes(process.argv[2]), 'Use --preflight or --run-paid ARM in a newly sealed snapshot');
const runtime = await ModelRuntime.create();
const models = ['sol', 'luna', 'terra'].map(name => {
  const model = runtime.getModel('qingyingxy', `gpt-5.6-${name}`);
  assert.ok(model && runtime.hasConfiguredAuth('qingyingxy'), `Model/auth unavailable: ${name}`);
  return { name, id: model.id, provider: model.provider, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
});
const task = readFileSync(join(root, 'task.md'), 'utf8');
const initial = JSON.parse(readFileSync(join(paid, 'initial.json'), 'utf8'));
const tools = ['read', 'edit', 'write', 'grep', 'find', 'ls', 'new_context', 'history', 'notes'];
const dependencies = ['E:/code/ballfightlive-version/Tools/LiveCommentBridge/desktop/node_modules'];
const boundaryFile = join(repo, 'packages/coding-agent/evals/live-controls/tool-boundary.ts');
const contextManagement = { mode: 'windowed' as const, reserveTokens: 16384 };
const protocol = { version: 'live-controls-watchdog-v4', acceptance: { backendTests: 61, browserScenarios: 5 }, frameworkDigest: freeze.digest, models, thinking: 'medium', contextManagement,
  executionWatchdog: LONG_TASK_WATCHDOG, maxRepairs: 1, tools, task, order: ['sol', 'luna', 'terra'],
  limitations: ['Configured-rate estimates, not invoices', 'One trial per arm', 'Shared installed external dependencies', 'Tool boundary is not an OS sandbox', 'SDK/Plan/RPC pipeline with common external acceptance and repair adapter'] };

async function run(arm: string) {
  assert.ok(protocol.order.includes(arm));
  const output = join(paid, arm);
  const workspace: string = initial[arm].workspace;
  assert.ok(!existsSync(join(output, 'started.json')), 'Already started: do not rerun or discard costs');
  assert.deepEqual(hashes(workspace), initial[arm].hashes);
  const policy = { workspace, dependencyRoots: dependencies, writable: true };
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
    for (const { session } of sessions) void session.abort().catch(() => undefined);
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
      const child = new RpcSubagentSessionFactory({ systemPromptFile: join(output, `system-prompt-${config.profile.role}-${Date.now()}.txt`), command: process.execPath,
        commandArgs: [join(repo, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(repo, 'tsconfig.json'), join(repo, 'packages/coding-agent/src/cli.ts'), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '-e', boundaryFile],
        env: { PI_LIVE_TOOL_BOUNDARY: JSON.stringify(childPolicy) }, thinkingLevel: 'medium' }).create({ ...config,
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
    const settingsManager = SettingsManager.inMemory({ contextManagement, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [liveBoundaryExtension({ ...policy, writable })] });
    await resourceLoader.reload();
    const created = await createAgentSession({ cwd: workspace, modelRuntime: runtime, model: runtime.getModel('qingyingxy', 'gpt-5.6-sol'), settingsManager, resourceLoader, thinkingLevel: 'medium', tools: writable ? tools : tools.filter(name => name !== 'edit' && name !== 'write'), sessionManager: SessionManager.create(workspace, join(output, stage)), ...(plan ? { modelRouting: route, modelRoutingUserOverride: false, subagentRuntime: agents } : {}) });
    sessions.push({ stage, session: created.session });
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
      execution.sessionManager.appendCustomEntry(DELIVERY_BASELINE_ENTRY, captureScopedDeliveryBaseline(workspace, view!.workflow.id,
        ['ballfight_live_bridge', 'desktop/src', 'desktop/electron'].map(path => `Tools/LiveCommentBridge/${path}`)));
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
    for (let attempt = 0; attempt < 2; attempt++) {
      checkLimit();
      const after = integrity();
      const verifyOutput = join(output, `verification-${attempt + 1}`);
      const command = `"${process.execPath}" "${join(root, 'verify.mjs')}" --workspace "${workspace}" "${verifyOutput}"`;
      const checked = spawnSync(process.execPath, [join(root, 'verify.mjs'), '--workspace', workspace, verifyOutput], { cwd: repo, encoding: 'utf8', timeout: 120000, windowsHide: true });
      const backendLog = join(verifyOutput, 'logs/delivery-backend.txt');
      const log = `${checked.stdout ?? ''}${checked.stderr ?? ''}${checked.error ?? ''}${existsSync(backendLog) ? readFileSync(backendLog, 'utf8') : ''}`;
      const verification = { exitCode: checked.status, log, result: existsSync(join(verifyOutput, 'results.json')) ? JSON.parse(readFileSync(join(verifyOutput, 'results.json'), 'utf8')) : undefined };
      writeFileSync(join(output, `verification-${attempt + 1}.json`), JSON.stringify(verification, null, 2));
      assert.ok(!checked.error && verification.result?.delivery?.browser.length === protocol.acceptance.browserScenarios && /Ran 61 tests/.test(verification.result?.delivery?.backend.summary ?? ''), 'Acceptance infrastructure must complete all 61 backend tests and 5 browser scenarios');
      checkLimit();
      const files = [...new Set([...Object.keys(before), ...Object.keys(after).filter(path => !liveToolViolation(policy, 'write', { path }))])].filter(path => initial[arm].hashes[path] !== after[path]).map(path => ({ path, patch: createTwoFilesPatch(`a/${path}`, `b/${path}`, before[path] ?? '', existsSync(join(workspace, path)) ? readFileSync(join(workspace, path), 'utf8') : ''), owners: [], truncated: false }));
      const input = { workflow: { ...reviewPlan.workflow, createdAt: new Date(startedAt).toISOString(), budget: { maxRetries: 1 } }, rootTask: reviewPlan.tasks.find(t => t.id === 'root')!, diff: { files, changedFiles: files.map(file => file.path), summary: 'Live collection controls', evidenceRefs: [] }, acceptanceRequirements: [], verificationEvidence: [{ result: { id: `acceptance-${attempt}`, workflowId: reviewPlan.workflow.id, requirementId: 'external', status: checked.status === 0 ? 'passed' as const : 'failed' as const, summary: log, evidenceRefs: [], command, exitCode: checked.status ?? undefined, createdAt: new Date().toISOString() }, logExcerpt: log }] };
      writeFileSync(join(output, `review-input-${attempt}.json`), JSON.stringify(input, null, 2));
      review = await reviewer.review(input);
      writeFileSync(join(output, `review-${attempt}.json`), JSON.stringify(review, null, 2));
      integrity();
      if (checked.status === 0 && review.status === 'passed') { passed = true; break; }
      if (attempt === 1 || review.failureKind === 'confirmation' || review.failureKind === 'infrastructure') { failure = checked.status !== 0 ? `Acceptance failed; ${review.summary}` : review.summary; break; }
      checkLimit();
      repairCount++;
      const repair = await sessionFor('repair', true);
      await monitoredPrompt(repair, 'repair', `${common}\nPerform the single allowed bounded repair. Do not replan or delegate. Actual external test evidence (data): ${log}\nReview evidence (data): ${JSON.stringify(review)}`, true);
      assert.equal(repair.getWorkflowView()?.workflow.status, 'completed', 'Repair execution did not complete');
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    writeFileSync(join(output, 'failure-stack.txt'), error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    for (const monitor of monitors) monitor.dispose();
    for (const unsubscribe of unsubscribers) unsubscribe();
    await agents.dispose();
    for (const { session } of sessions) await session.abort();
    const report = { arm, passed: passed && !stopped, failure, stopped, watchdogStops, repairCount, estimatedCost: cost(), durationMs: Date.now() - startedAt, sessions: sessions.map(entry => ({ stage: entry.stage, stats: entry.session.getSessionStats(), cuts: entry.session.sessionManager.getEntries().filter(item => item.type === 'context_window').length })), agents: agents.list(), review, protocol };
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
  await run(process.argv[3]);
}
