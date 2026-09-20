"""Pinned, zero-model FeatureBench task preparation and oracle environment check."""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys
import time

import pandas as pd
import pyarrow.parquet as pq
from featurebench.harness.constants import KEY_INSTANCE_ID, KEY_PREDICTION
from featurebench.harness.run_evaluation import run_instance
from featurebench.harness.utils import preprocess_hf_patch

TASK = "pandas-dev__pandas.82fa2715.test_all_methods.c74b49a1.lv1"
DATA_SHA256 = "e8a704f83d673e1cc78086eefb76bd56461ead8a65ca06fd6972f7363be8a775"


def prepare(parquet, output):
    if output.exists():
        raise ValueError("Output must be fresh")
    if hashlib.sha256(parquet.read_bytes()).hexdigest() != DATA_SHA256:
        raise ValueError("Expected pinned FeatureBench v1.0 fast parquet")
    rows = pq.read_table(parquet, filters=[("instance_id", "=", TASK)]).to_pylist()
    if len(rows) != 1:
        raise ValueError("Expected exactly one pinned task")
    row = rows[0]
    row["level"] = 1
    (output / "agent-input").mkdir(parents=True)
    (output / "verifier-private").mkdir()
    (output / "agent-input/instruction.md").write_text(row["problem_statement"], encoding="utf-8")
    (output / "verifier-private/instance.json").write_text(json.dumps(row, indent=2), encoding="utf-8")
    metadata = {key: row[key] for key in ["instance_id", "repo", "base_commit", "image_name", "FAIL_TO_PASS", "PASS_TO_PASS", "repo_settings"]}
    metadata.update(dataset="LiberCoders/FeatureBench", datasetVersion="v1.0", split="fast",
                    parquetSha256=DATA_SHA256, featurebenchVersion=importlib.metadata.version("featurebench"),
                    paidCalls=0, qualityEvaluation=False,
                    instructionSha256=hashlib.sha256(row["problem_statement"].encode()).hexdigest())
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    (output / "requirements.freeze.txt").write_text(subprocess.check_output([sys.executable, "-m", "pip", "freeze"], text=True))
    return row, metadata


def oracle_accepted(result, counts, test_files_complete=True):
    return bool(test_files_complete and result.get("completed") and result.get("resolved") and not result.get("error")
                and counts["FAIL_TO_PASS"]["success"] > 0 and counts["FAIL_TO_PASS"]["failure"] == 0
                and counts["PASS_TO_PASS"]["success"] > 0 and counts["PASS_TO_PASS"]["failure"] == 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--execute-smoke", action="store_true")
    parser.add_argument("--mode", choices=["oracle", "masked"], default="oracle")
    args = parser.parse_args()
    if importlib.metadata.version("featurebench") != "0.2.3":
        raise ValueError("Expected featurebench==0.2.3")
    row, _metadata = prepare(args.parquet, args.output)
    print(json.dumps({"prepared": str(args.output), "task": TASK, "base": row["base_commit"],
                      "image": row["image_name"], "f2pFiles": len(row["FAIL_TO_PASS"]),
                      "p2pFiles": len(row["PASS_TO_PASS"]), "paidCalls": 0}), flush=True)
    if not args.execute_smoke:
        return
    # Oracle restores the hidden reference only inside the separate verifier.
    patch = preprocess_hf_patch(row["patch"], row["FAIL_TO_PASS"]) if args.mode == "oracle" else (
        "diff --git a/PI_FEATUREBENCH_SMOKE.txt b/PI_FEATUREBENCH_SMOKE.txt\n"
        "new file mode 100644\n--- /dev/null\n+++ b/PI_FEATUREBENCH_SMOKE.txt\n"
        "@@ -0,0 +1 @@\n+Environment smoke; no implementation.\n")
    attempt = int(time.time())
    result = run_instance(pd.Series(row), {KEY_INSTANCE_ID: TASK, KEY_PREDICTION: patch, "n_attempt": attempt},
                          args.output)
    log_dir = args.output / "eval_outputs" / TASK / f"attempt-{attempt}"
    expected_logs = [log_dir / "test_output.txt", *[
        log_dir / f"test_output_p2p_{Path(path).stem}.txt" for path in row["PASS_TO_PASS"]]]
    logs_complete = all(path.exists() and path.stat().st_size > 0 for path in expected_logs)
    report = result.get("report", {}).get(TASK, {})
    statuses = report.get("tests_status", {})
    counts = {kind: {status: len(statuses.get(kind, {}).get(status, [])) for status in ["success", "failure"]}
              for kind in ["FAIL_TO_PASS", "PASS_TO_PASS"]}
    oracle_passed = oracle_accepted(result, counts, logs_complete)
    summary = {"mode": args.mode, "paidCalls": 0, "costUsd": 0, "qualityEvaluation": False,
               "oraclePassed": oracle_passed if args.mode == "oracle" else None,
               "testLogsComplete": logs_complete,
               "counts": counts, "result": result}
    (args.output / "environment-report.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in summary.items() if key != "result"}, indent=2), flush=True)
    if args.mode == "oracle" and not oracle_passed:
        sys.exit(1)


if __name__ == "__main__":
    main()
