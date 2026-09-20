"""Run one no-model Pier smoke and gate on artifacts, not Pier's exit code."""

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tomllib

from prepare_deepswe import prepare, select_task


def resolve_base(task_path, declared_base):
    if not re.fullmatch(r"[0-9a-f]{7,40}", declared_base):
        raise ValueError("Expected hexadecimal base commit")
    if len(declared_base) == 40:
        return declared_base
    task = tomllib.loads((task_path / "task.toml").read_text())
    resolved = subprocess.check_output([
        "docker", "run", "--rm", "--network", "none", "--entrypoint", "git",
        task["environment"]["docker_image"], "-C", "/app", "rev-parse", "--verify", f"{declared_base}^{{commit}}",
    ], text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", resolved) or not resolved.startswith(declared_base):
        raise ValueError("Base commit did not resolve uniquely to a matching full SHA")
    return resolved


def inspect(job, expected=None):
    expected_path = Path(job).parents[1] / "smoke-expected.json"
    if expected is None:
        expected = json.loads(expected_path.read_text()) if expected_path.exists() else {"f2p": 60, "p2p": 1038}
    trials = list(Path(job).glob("*/result.json"))
    if len(trials) != 1:
        raise ValueError("Expected exactly one completed trial")
    trial = trials[0].parent
    result = json.loads(trials[0].read_text())
    sdk = json.loads((trial / "agent/sdk-result.json").read_text())
    reward = json.loads((trial / "verifier/reward.json").read_text())
    patch = (trial / "artifacts/model.patch").read_bytes()
    verifier = (trial / "verifier/test-stdout.txt").read_text()
    base_matches = True
    if expected.get("base"):
        bridge = [json.loads(line) for line in (trial / "agent/bridge.jsonl").read_text().splitlines()]
        base_matches = bool(bridge and bridge[0]["response"]["return_code"] == 0
                            and bridge[0]["response"]["stdout"].splitlines()[:1] == [expected["base"]])
    passed = (result.get("exception_info") is None and sdk.get("passed") is True
              and sdk.get("costUsd") == 0 and sdk.get("provider") == "faux"
              and base_matches and reward.get("reward") == 0 and reward.get("f2p_total") == expected["f2p"]
              and reward.get("f2p_passed") == 0 and reward.get("p2p_total") == expected["p2p"]
              and reward.get("p2p_passed") == expected["p2p"]
              and b"PI_TRANSPORT_SMOKE.txt" in patch and "model.patch applied" in verifier)
    report = {"passed": passed, "qualityEvaluation": False, "costUsd": 0,
              "trial": str(trial), "sdk": sdk, "reward": reward, "expected": expected, "baseMatches": base_matches,
              "patchSha256": hashlib.sha256(patch).hexdigest()}
    (Path(job) / "smoke-acceptance.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--inspect", type=Path)
    parser.add_argument("--submission", action="store_true", help="Exercise normal repair and submission with Faux")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).with_name("deepswe-task-set.json"))
    parser.add_argument("--task", help="Task ID; required for multi-task manifests")
    parser.add_argument("--controlled-checkpoint", type=Path)
    parser.add_argument("--group", choices=["A", "C"])
    args = parser.parse_args()
    if bool(args.output) == bool(args.inspect):
        parser.error("Pass exactly one of --output or --inspect")
    if bool(args.controlled_checkpoint) != bool(args.group) or (args.controlled_checkpoint and args.submission):
        parser.error("Controlled checkpoint requires group and cannot combine with submission smoke")
    if args.inspect:
        report = inspect(args.inspect)
    else:
        directory = Path(__file__).resolve().parent
        root = directory.parents[3]
        if args.output.exists():
            parser.error("Output must be a fresh directory")
        subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"], check=True)
        subprocess.run(["/mnt/d/compileenv/nodejs/node.exe", "--version"], check=True)
        pier = Path(sys.executable).with_name("pier")
        if subprocess.check_output([str(pier), "--version"], text=True).strip() != "0.3.1":
            raise ValueError("Expected datacurve-pier 0.3.1")
        task = select_task(args.manifest, args.task)
        prepare(args.manifest, root / ".artifacts/deep-swe-source", args.output / "prepared", task["id"])
        task_path = args.output / "prepared" / task["taskPath"]
        grading = json.loads((task_path / "tests/config.json").read_text())
        expected = {"taskId": task["id"], "base": resolve_base(task_path, grading["base_commit"]),
                    "declaredBase": grading["base_commit"],
                    "f2p": len(grading["f2p_node_ids"]), "p2p": len(grading["p2p_node_ids"]),
                    "manifestSha256": hashlib.sha256(args.manifest.read_bytes()).hexdigest()}
        (args.output / "smoke-expected.json").write_text(json.dumps(expected, indent=2) + "\n")
        args.output.mkdir(parents=True, exist_ok=True)
        sources = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in
                   ["pi_pier_agent.py", "pier-faux-driver.ts", "pier-submission-smoke-driver.ts",
                    "pier-controlled-smoke-driver.ts", "pier-controlled-replay.ts", "pier-real-session.ts",
                    "pier-budget.ts", "prepare_deepswe.py", "deepswe-task-set.json"]}
        (args.output / "adapter-sha256.json").write_text(json.dumps(sources, indent=2) + "\n")
        environment = {**os.environ, "PYTHONPATH": str(directory)}
        subprocess.run([
            str(pier), "run", "-p", str(task_path),
            "--agent-import-path", "pi_pier_agent:PiControlledSmokeAgent" if args.controlled_checkpoint else "pi_pier_agent:PiSubmissionSmokeAgent" if args.submission else "pi_pier_agent:PiFauxAgent",
            *(["--agent-kwarg", f"checkpoint_path={args.controlled_checkpoint.resolve()}", "--agent-kwarg", f"group={args.group}"] if args.controlled_checkpoint else []),
            "--n-concurrent", "1", "--n-attempts", "1",
            "--max-retries", "0", "--no-delete", "--jobs-dir", str(args.output / "jobs"), "--job-name", "smoke",
        ], env=environment, check=True)
        report = inspect(args.output / "jobs/smoke")
    print(json.dumps(report, indent=2))
    sys.exit(0 if report["passed"] else 1)
