import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from run_featurebench_environment import oracle_accepted, prepare


class EnvironmentTests(unittest.TestCase):
    def test_zero_tests_and_failed_tests_cannot_pass_oracle(self):
        result = {"completed": True, "resolved": True}
        counts = {"FAIL_TO_PASS": {"success": 3, "failure": 0}, "PASS_TO_PASS": {"success": 4, "failure": 0}}
        self.assertTrue(oracle_accepted(result, counts))
        self.assertFalse(oracle_accepted(result, counts, False))
        counts["FAIL_TO_PASS"]["success"] = 0
        self.assertFalse(oracle_accepted(result, counts))
        counts["FAIL_TO_PASS"].update(success=3, failure=1)
        self.assertFalse(oracle_accepted(result, counts))
        counts["FAIL_TO_PASS"]["failure"] = 0
        self.assertFalse(oracle_accepted({**result, "error": "setup failed"}, counts))

    def test_prepare_keeps_reference_data_out_of_agent_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            parquet = root / "fixture.parquet"
            parquet.write_bytes(b"fixture")
            row = {"instance_id": "task", "repo": "repo", "base_commit": "base", "image_name": "image",
                   "FAIL_TO_PASS": ["new.py"], "PASS_TO_PASS": ["old.py"], "repo_settings": "{}",
                   "problem_statement": "Exact public instruction", "patch": "PRIVATE_REFERENCE", "test_patch": "PRIVATE_TEST"}
            with patch("run_featurebench_environment.DATA_SHA256", hashlib.sha256(b"fixture").hexdigest()), \
                 patch("run_featurebench_environment.pq.read_table") as table, \
                 patch("run_featurebench_environment.subprocess.check_output", return_value="fixture==1\n"):
                table.return_value.to_pylist.return_value = [row]
                prepare(parquet, root / "out")
                self.assertEqual((root / "out/agent-input/instruction.md").read_text(), "Exact public instruction")
                private = json.loads((root / "out/verifier-private/instance.json").read_text())
                self.assertEqual(private["patch"], "PRIVATE_REFERENCE")
                self.assertNotIn("PRIVATE_REFERENCE", (root / "out/metadata.json").read_text())
                with self.assertRaises(ValueError):
                    prepare(parquet, root / "out")
            with self.assertRaises(ValueError):
                prepare(parquet, root / "bad")


if __name__ == "__main__":
    unittest.main()
