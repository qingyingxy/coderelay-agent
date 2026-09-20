from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from transitions_fixture_stage import run_tests, source_hash


class FixtureStageTests(unittest.TestCase):
    def test_hash_tracks_source_but_not_test_logs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "transitions").mkdir()
            source = root / "transitions/core.py"
            source.write_text("value = 1\n")
            first = source_hash(root)
            (root / "transitions/output.log").write_text("test output")
            self.assertEqual(first, source_hash(root))
            source.write_text("value = 2\n")
            self.assertNotEqual(first, source_hash(root))

    def test_real_pytest_failure_is_retained_in_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "probe.xml").write_text('<testsuites><testsuite><testcase name="ok"/>'
                '<testcase name="bad"><failure>failure</failure></testcase></testsuite></testsuites>')
            with patch("transitions_fixture_stage.subprocess.run", return_value=subprocess.CompletedProcess(
                    args=[], returncode=1, stdout="1 failed, 1 passed", stderr="")) as run:
                result = run_tests(root, root, [root / "test.py"], root, "probe")
                self.assertIn("--import-mode=importlib", run.call_args.args[0])
            self.assertEqual(result["returnCode"], 1)
            self.assertEqual((result["passed"], result["failed"], result["errors"]), (1, 1, 0))
            self.assertEqual((root / "probe.log").read_text(), "1 failed, 1 passed")


if __name__ == "__main__":
    unittest.main()
