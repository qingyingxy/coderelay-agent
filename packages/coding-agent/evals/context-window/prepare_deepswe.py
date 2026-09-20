"""Export pinned Git blobs, never platform-converted checkout bytes or solutions."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess


def select_task(manifest_path, task_id=None):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    matches = [task for task in manifest["tasks"] if task_id is None or task.get("id") == task_id]
    if len(matches) != 1:
        raise ValueError("Select exactly one task using --task and its pinned manifest")
    task = matches[0]
    path = PurePosixPath(task["taskPath"])
    if path.is_absolute() or ".." in path.parts or "\\" in str(path) or ":" in str(path) or path.parts[:1] != ("tasks",):
        raise ValueError("Unsafe task path")
    return task


def prepare(manifest_path, source, output, task_id=None):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if task_id is not None:
        manifest["tasks"] = [select_task(manifest_path, task_id)]
    output = Path(output)
    if output.exists():
        raise ValueError("Output must be a fresh directory")
    blobs = []
    for task in manifest["tasks"]:
        for asset in task["assets"]:
            path = PurePosixPath(task["taskPath"]) / asset["path"]
            if path.is_absolute() or ".." in path.parts or "solution" in path.parts:
                raise ValueError(f"Unsafe asset: {path}")
            content = subprocess.check_output([
                "git", "-c", f"safe.directory={Path(source).resolve().as_posix()}",
                "-C", str(source), "show", f'{manifest["source"]["revision"]}:{path}',
            ])
            if len(content) != asset["bytes"] or hashlib.sha256(content).hexdigest() != asset["sha256"]:
                raise ValueError(f"Pinned blob mismatch: {path}")
            blobs.append((path, content))
    for path, content in blobs:
        destination = output / str(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        if path.suffix == ".sh":
            destination.chmod(0o755)
    (output / "provenance.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return len(blobs)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps({"exported": prepare(args.manifest, args.source, args.output)}))
