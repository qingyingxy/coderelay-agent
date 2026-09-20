import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from run_pier_smoke import inspect, resolve_base


class AcceptanceTests(unittest.TestCase):
    def test_short_base_is_resolved_by_git_not_accepted_by_prefix_alone(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "task.toml").write_text('[environment]\ndocker_image="fixture-image"\n')
            full = "abcdef0" + "1" * 33
            with patch("run_pier_smoke.subprocess.check_output", return_value=full + "\n") as resolve:
                self.assertEqual(resolve_base(root, "abcdef0"), full)
                self.assertIn("abcdef0^{commit}", resolve.call_args.args[0])
                self.assertIn("none", resolve.call_args.args[0])
            with patch("run_pier_smoke.subprocess.check_output", return_value="0" * 40):
                with self.assertRaises(ValueError):
                    resolve_base(root, "abcdef0")
            with patch("run_pier_smoke.subprocess.check_output") as resolve:
                self.assertEqual(resolve_base(root, full), full)
                resolve.assert_not_called()
            with self.assertRaises(ValueError):
                resolve_base(root, "main")

    def test_exception_cannot_pass_even_when_reward_exists(self):
        with tempfile.TemporaryDirectory() as temporary:
            job = Path(temporary)
            trial = job / "trial"
            for directory in ["agent", "verifier", "artifacts"]:
                (trial / directory).mkdir(parents=True)
            (trial / "result.json").write_text(json.dumps({"exception_info": None}))
            (trial / "agent/sdk-result.json").write_text(json.dumps({"passed": True, "costUsd": 0, "provider": "faux"}))
            (trial / "verifier/reward.json").write_text(json.dumps({
                "reward": 0, "f2p_total": 60, "f2p_passed": 0, "p2p_total": 1038, "p2p_passed": 1038,
            }))
            (trial / "artifacts/model.patch").write_bytes(b"PI_TRANSPORT_SMOKE.txt")
            (trial / "verifier/test-stdout.txt").write_text("model.patch applied")
            self.assertTrue(inspect(job)["passed"])
            (trial / "agent/bridge.jsonl").write_text(json.dumps({
                "response": {"return_code": 0, "stdout": "base-sha\n"}}) + "\n")
            expected = {"base": "base-sha", "f2p": 103, "p2p": 10093}
            self.assertFalse(inspect(job, expected)["passed"])
            (trial / "verifier/reward.json").write_text(json.dumps({
                "reward": 0, "f2p_total": 103, "f2p_passed": 0, "p2p_total": 10093, "p2p_passed": 10093,
            }))
            self.assertTrue(inspect(job, expected)["passed"])
            self.assertFalse(inspect(job, {**expected, "base": "wrong-sha"})["passed"])
            (trial / "result.json").write_text(json.dumps({"exception_info": {"exception_type": "Timeout"}}))
            self.assertFalse(inspect(job, expected)["passed"])
            (trial / "result.json").write_text(json.dumps({"exception_info": None}))
            (trial / "verifier/test-stdout.txt").write_text("patch failed")
            self.assertFalse(inspect(job, expected)["passed"])


if __name__ == "__main__":
    unittest.main()
