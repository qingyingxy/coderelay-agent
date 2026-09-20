"""Prepare a single budgeted real-model trial; paid execution is opt-in."""

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys

from prepare_deepswe import prepare, select_task


def freeze_checkpoint(source, output, group, task_path):
    manifest = json.loads((source / "checkpoint.json").read_text())
    repository = json.loads((source / "repository.json").read_text())
    grading = json.loads((task_path / "tests/config.json").read_text())
    if repository["base"] != grading["base_commit"]:
        raise ValueError("Checkpoint base does not match selected task")
    raw = (source / group / "session.jsonl").read_bytes()
    if hashlib.sha256(raw).hexdigest() != manifest["sessionSha256"]:
        raise ValueError("Checkpoint session hash mismatch")
    entries = [json.loads(line) for line in raw.decode().splitlines()]
    users = [entry["message"] for entry in entries if entry.get("type") == "message" and entry["message"].get("role") == "user"]
    if len(users) != 1:
        raise ValueError("Expected one checkpoint instruction")
    content = users[0]["content"]
    instruction = content if isinstance(content, str) else "\n".join(part["text"] for part in content if part["type"] == "text")
    if instruction != (task_path / "instruction.md").read_text():
        raise ValueError("Checkpoint instruction mismatch")
    (output / group).mkdir(parents=True)
    for name in ["checkpoint.json", "repository.json", f"{group}/session.jsonl"]:
        shutil.copyfile(source / name, output / name)
    return {"sessionSha256": manifest["sessionSha256"], "repository": repository}


def inspect_memory_continuation(trial, group):
    sessions = list((trial / "agent/sessions").glob("*.jsonl"))
    evidence = {"status": "missing_or_ambiguous_session", "boundaries": [],
                "continuedBoundaries": 0}
    if len(sessions) != 1:
        return evidence
    try:
        entries = [json.loads(line) for line in sessions[0].read_text(encoding="utf-8").splitlines() if line]
        # Follow the final branch, not abandoned entries earlier in the append-only log.
        indexed = {entry["id"]: entry for entry in entries if "id" in entry}
        branch, seen = [], set()
        current = entries[-1] if entries else None
        while current:
            entry_id = current["id"]
            if entry_id in seen:
                raise ValueError("Session parent cycle")
            seen.add(entry_id)
            branch.append(current)
            parent = current.get("parentId")
            current = indexed[parent] if parent else None
        branch.reverse()
    except (ValueError, KeyError, TypeError):
        evidence["status"] = "invalid_session"
        return evidence
    boundary_type = "context_window" if group == "C" else "compaction"
    active, pending = None, set()
    for entry in branch:
        if entry.get("type") == boundary_type:
            active = {"entryId": entry["id"], "type": boundary_type,
                      "timestamp": entry.get("timestamp"), "assistantTurns": 0,
                      "executionCalls": 0, "executionResults": 0,
                      "executionResultEntryIds": []}
            evidence["boundaries"].append(active)
            pending = set()
        if active is None or entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if message.get("role") == "assistant":
            active["assistantTurns"] += 1
            for content in message.get("content", []):
                if isinstance(content, dict) and content.get("type") == "toolCall" and content.get("name") == "container_exec":
                    pending.add(content["id"])
                    active["executionCalls"] += 1
        elif message.get("role") == "toolResult" and message.get("toolCallId") in pending:
            pending.remove(message["toolCallId"])
            active["executionResults"] += 1
            active["executionResultEntryIds"].append(entry["id"])
    evidence["status"] = "inspected"
    evidence["continuedBoundaries"] = sum(item["executionResults"] > 0 for item in evidence["boundaries"])
    return evidence


def inspect_trial(trial):
    result = json.loads((trial / "result.json").read_text())
    sdk_path = trial / "agent/sdk-result.json"
    sdk = json.loads(sdk_path.read_text()) if sdk_path.exists() else None
    patch = trial / "artifacts/model.patch"
    patch_bytes = patch.stat().st_size if patch.exists() else 0
    verifier = result.get("verifier_result")
    reward = (verifier or {}).get("rewards", {}).get("reward")
    infrastructure_error = result.get("exception_info")
    execution_complete = bool(sdk and sdk.get("status") == "runtime_completed"
                              and sdk.get("containerCalls", 0) > 0
                              and sdk.get("containerReplies") == sdk.get("containerCalls"))
    boundary_exercised = bool(sdk and (sdk.get("snapshotWindows", 0) > 0 if sdk.get("group") == "C"
                                      else sdk.get("compactions", 0) > 0))
    continuation = inspect_memory_continuation(trial, (sdk or {}).get("group"))
    return {"infrastructureError": infrastructure_error, "runtime": sdk,
            "officialVerifier": verifier, "trial": str(trial),
            "patchPresent": patch_bytes > 0, "patchBytes": patch_bytes,
            "executionComplete": execution_complete,
            "officialTaskSuccess": reward == 1 if reward is not None and not infrastructure_error else None,
            "memoryBoundaryExercised": boundary_exercised,
            "memoryContinuation": continuation,
            "memoryQualityEligible": bool(execution_complete and boundary_exercised
                                          and continuation["continuedBoundaries"] > 0
                                          and not infrastructure_error and reward is not None)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--execute-paid", action="store_true")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("deepswe-task-set.json"))
    parser.add_argument("--task", help="Task ID; required when the manifest contains multiple tasks")
    parser.add_argument("--controlled-checkpoint", type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists():
        parser.error("Output must be fresh; paid runs are never resumed or retried automatically")
    directory = Path(__file__).resolve().parent
    root = directory.parents[3]
    task = select_task(args.manifest, args.task)

    def windows(path):
        return subprocess.check_output(["wslpath", "-w", str(path)], text=True).strip()

    validation = json.loads(subprocess.check_output([
        "/mnt/d/compileenv/nodejs/node.exe", "--import", "tsx",
        windows(directory / "pier-validate-config.ts"), windows(args.config.resolve()),
    ], cwd=root, text=True))
    config = validation["config"]
    prepare(args.manifest, root / ".artifacts/deep-swe-source", output / "prepared", task["id"])
    checkpoint = freeze_checkpoint(args.controlled_checkpoint, output / "checkpoint", config["group"],
                                   output / "prepared" / task["taskPath"]) if args.controlled_checkpoint else None
    config_path = output / "run-config.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    hashes = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in
              ["pi_pier_agent.py", "pier-real-driver.ts", "pier-real-session.ts", "pier-controlled-replay.ts", "pier-budget.ts", "deepswe-task-set.json"]}
    (output / "adapter-sha256.json").write_text(json.dumps(hashes, indent=2) + "\n")
    (output / "plan.json").write_text(json.dumps({**validation, "executePaid": args.execute_paid,
        "taskId": task["id"], "manifestSha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
        "controlledCheckpoint": checkpoint,
        "scope": "one trial; maxCostUsd is per trial; estimates are not billing guarantees"}, indent=2) + "\n")
    if not args.execute_paid:
        print(json.dumps({"prepared": str(output), **validation}, indent=2))
        return
    pier = Path(sys.executable).with_name("pier")
    if subprocess.check_output([str(pier), "--version"], text=True).strip() != "0.3.1":
        raise ValueError("Expected Pier 0.3.1")
    subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], check=True)
    subprocess.run([
        str(pier), "run", "-p", str(output / "prepared" / task["taskPath"]),
        "--agent-import-path", "pi_pier_agent:PiRealAgent", "--model", f'{config["provider"]}/{config["model"]}',
        "--agent-kwarg", f"config_path={config_path}", "--agent-kwarg", "execute_paid=true",
        *(["--agent-kwarg", f"checkpoint_path={output / 'checkpoint'}"] if checkpoint else []),
        "--n-concurrent", "1", "--n-attempts", "1", "--max-retries", "0", "--no-delete",
        "--jobs-dir", str(output / "jobs"), "--job-name", "trial",
    ], env={**os.environ, "PYTHONPATH": str(directory)}, check=True)
    trials = list((output / "jobs/trial").glob("*/result.json"))
    if len(trials) != 1:
        raise ValueError("Expected one completed trial")
    trial = trials[0].parent
    report = inspect_trial(trial)
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if report["infrastructureError"] or not report["executionComplete"] or report["officialTaskSuccess"] is None:
        sys.exit(1)


if __name__ == "__main__":
    main()
