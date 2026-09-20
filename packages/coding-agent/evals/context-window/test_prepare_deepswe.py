import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from prepare_deepswe import prepare, select_task


class ExportTests(unittest.TestCase):
    def test_task_selection_rejects_ambiguity_unknown_and_unsafe_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "manifest.json"
            tasks = [{"id": "a", "taskPath": "tasks/a"}, {"id": "b", "taskPath": "tasks/b"}]
            path.write_text(json.dumps({"tasks": tasks}))
            self.assertEqual(select_task(path, "b"), tasks[1])
            for task_id in [None, "missing"]:
                with self.assertRaises(ValueError):
                    select_task(path, task_id)
            for unsafe in ["../escape", "/absolute", "tasks/../escape", "tasks\\escape", "C:/escape"]:
                path.write_text(json.dumps({"tasks": [{"id": "a", "taskPath": unsafe}]}))
                with self.assertRaises(ValueError):
                    select_task(path, "a")

    def test_git_bytes_survive_crlf_checkout_and_mismatch_fails_before_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.mkdir()
            subprocess.run(["git", "init", str(source)], check=True, capture_output=True)
            task = source / "tasks" / "smoke"
            task.mkdir(parents=True)
            content = b"#!/bin/sh\nexit 0\n"
            script = task / "test.sh"
            script.write_bytes(content)
            subprocess.run(["git", "-C", str(source), "add", "."], check=True)
            subprocess.run(["git", "-C", str(source), "-c", "user.name=Test", "-c",
                            "user.email=test@example.invalid", "commit", "-m", "fixture"],
                           check=True, capture_output=True)
            revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
            script.write_bytes(content.replace(b"\n", b"\r\n"))
            asset = {"path": "test.sh", "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            manifest = {"source": {"revision": revision}, "tasks": [{"taskPath": "tasks/smoke", "assets": [asset]}]}
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            output = root / "output"
            self.assertEqual(prepare(manifest_path, source, output), 1)
            self.assertEqual((output / "tasks/smoke/test.sh").read_bytes(), content)
            manifest["tasks"][0]["id"] = "smoke"
            manifest["tasks"].append({"id": "other", "taskPath": "tasks/other", "assets": [asset]})
            manifest_path.write_text(json.dumps(manifest))
            selected = root / "selected"
            self.assertEqual(prepare(manifest_path, source, selected, "smoke"), 1)
            self.assertFalse((selected / "tasks/other").exists())
            self.assertEqual(len(json.loads((selected / "provenance.json").read_text())["tasks"]), 1)
            manifest["tasks"].pop()
            with self.assertRaises(ValueError):
                prepare(manifest_path, source, output)
            asset["sha256"] = "0" * 64
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "mismatch"):
                prepare(manifest_path, source, root / "bad")
            self.assertFalse((root / "bad").exists())
            asset["path"] = "../escape"
            manifest_path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                prepare(manifest_path, source, root / "unsafe")


if __name__ == "__main__":
    unittest.main()
