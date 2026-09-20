"""Apply one scripted reference stage and run real tests; never calls a model."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET


def source_hash(root):
    digest = hashlib.sha256()
    for path in sorted((root / "transitions").rglob("*")):
        if path.is_file() and path.suffix in (".py", ".pyi"):
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()


def run_tests(work, baseline, paths, output, name, expression=None):
    xml = output / f"{name}.xml"
    command = [sys.executable, "-P", "-m", "pytest", "--import-mode=importlib", *map(str, paths),
               "-q", "--tb=short", "--disable-warnings", f"--junitxml={xml}"]
    if expression:
        command.extend(["-k", expression])
    result = subprocess.run(command, cwd=work, env={**os.environ,
        "PYTHONPATH": os.pathsep.join([str(work), str(baseline)]), "TRANSITIONS_TARGET": str(work)},
        capture_output=True, text=True, timeout=180)
    (output / f"{name}.log").write_text(result.stdout + result.stderr)
    cases = list(ET.parse(xml).iter("testcase"))
    counts = {"tests": len(cases), "failed": sum(case.find("failure") is not None for case in cases),
              "errors": sum(case.find("error") is not None for case in cases),
              "skipped": sum(case.find("skipped") is not None for case in cases)}
    counts["passed"] = counts["tests"] - counts["failed"] - counts["errors"] - counts["skipped"]
    return {"returnCode": result.returncode, **counts, "log": str(output / f"{name}.log"), "xml": str(xml)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--feature", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stage", type=int, choices=range(1, 6), required=True)
    args = parser.parse_args()
    baseline, feature, reference, output = map(Path.resolve, [args.baseline, args.feature, args.reference, args.output])
    work = output / "work"
    state_path = output / "fixture-state.json"
    if args.stage == 1:
        if work.exists() or state_path.exists():
            raise ValueError("Stage one requires fresh fixture state")
        output.mkdir(parents=True, exist_ok=True)
        shutil.copytree(baseline, work, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", ".git"))
    else:
        previous = json.loads(state_path.read_text())
        if previous["stage"] != args.stage - 1 or previous["sourceHash"] != source_hash(work):
            raise ValueError("Out-of-order stage or unexpected source changes")
    before = source_hash(work)
    stage_files = {1: ["core.py", "core.pyi"], 2: ["extensions/nesting.py", "extensions/nesting.pyi"],
                   3: [], 4: ["extensions/asyncio.py", "extensions/asyncio.pyi"]}
    if args.stage < 5:
        for name in stage_files[args.stage]:
            shutil.copy2(feature / "transitions" / name, work / "transitions" / name)
    else:
        # Deliberate oracle replacement for free plumbing validation, not an Agent repair.
        shutil.copytree(reference / "transitions", work / "transitions", dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__"))
    contract = Path(__file__).parent / "fixtures/transitions-final/test_final_contract.py"
    expressions = {1: "final_flag or sync_terminal or failed_condition",
                   2: "nested_parent or HierarchicalMachine", 3: "parallel_all_regions_required_in_either_order",
                   4: "async_callback or async_parallel", 5: None}
    expected = {1: (3, 2), 2: (3, 0), 3: (1, 1), 4: (3, 1), 5: (13, 0)}
    result = run_tests(work, baseline, [contract], output, f"stage-{args.stage}", expressions[args.stage])
    if (result["passed"], result["failed"]) != expected[args.stage] or result["errors"] or result["skipped"]:
        raise ValueError(f"Unexpected fixture outcome: {result}")
    regression = None
    if args.stage == 5:
        paths = [baseline / "tests" / f"test_{name}.py" for name in ["core", "states", "nesting", "async", "threading", "parallel"]]
        regression = run_tests(work, baseline, paths, output, "final-regression")
        if regression["returnCode"] != 0 or regression["passed"] != 1104 or regression["skipped"] != 556:
            raise ValueError(f"Unexpected regression outcome: {regression}")
    state = {"stage": args.stage, "sourceHash": source_hash(work)}
    state_path.write_text(json.dumps(state))
    report = {**state, "sourceHashBefore": before, "contract": result, "regression": regression,
              "scriptedReferenceChanges": True, "paidCalls": 0}
    (output / f"stage-{args.stage}.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == "__main__":
    main()
