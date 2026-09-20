import json
import hashlib
from pathlib import Path
import tempfile
import unittest

from pi_pier_agent import PiControlledSmokeAgent, PiRealAgent
from run_pier_real import freeze_checkpoint, inspect_memory_continuation, inspect_trial


class TrialReportTests(unittest.TestCase):
    @staticmethod
    def write_session(root, entries):
        directory = root / "agent/sessions"
        directory.mkdir(exist_ok=True, parents=True)
        (directory / "session.jsonl").write_text("\n".join(json.dumps(entry) for entry in entries))

    def test_empty_patch_wait_and_official_reward_are_independent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "agent").mkdir()
            (root / "artifacts").mkdir()
            (root / "artifacts/model.patch").write_text("")
            (root / "result.json").write_text(json.dumps({"verifier_result": {"rewards": {"reward": 0}}}))
            sdk = {"status": "waiting_for_approval", "group": "C", "containerCalls": 0, "containerReplies": 0}
            (root / "agent/sdk-result.json").write_text(json.dumps(sdk))
            report = inspect_trial(root)
            self.assertFalse(report["patchPresent"])
            self.assertFalse(report["executionComplete"])
            self.assertFalse(report["officialTaskSuccess"])
            self.assertFalse(report["memoryQualityEligible"])
            sdk.update(status="runtime_completed", containerCalls=1, containerReplies=1, snapshotWindows=1)
            (root / "agent/sdk-result.json").write_text(json.dumps(sdk))
            report = inspect_trial(root)
            self.assertTrue(report["executionComplete"])
            self.assertFalse(report["memoryQualityEligible"])
            self.write_session(root, [
                {"id": "cut", "type": "context_window"},
                {"id": "call", "parentId": "cut", "type": "message", "message": {
                    "role": "assistant", "content": [{"type": "toolCall", "name": "container_exec", "id": "tool"}]}},
                {"id": "result", "parentId": "call", "type": "message", "message": {
                    "role": "toolResult", "toolCallId": "tool"}},
            ])
            report = inspect_trial(root)
            self.assertTrue(report["memoryQualityEligible"])
            self.assertFalse(report["officialTaskSuccess"])
            (root / "result.json").write_text(json.dumps({"exception_info": {"error": "grader failed"}}))
            report = inspect_trial(root)
            self.assertIsNone(report["officialTaskSuccess"])
            self.assertFalse(report["memoryQualityEligible"])

    def test_end_of_task_summary_and_final_text_do_not_qualify(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [{"id": "summary", "type": "compaction"}]
            self.write_session(root, entries)
            self.assertEqual(inspect_memory_continuation(root, "A")["continuedBoundaries"], 0)
            entries.append({"id": "final", "parentId": "summary", "type": "message",
                            "message": {"role": "assistant", "content": [{"type": "text", "text": "Done"}]}})
            self.write_session(root, entries)
            evidence = inspect_memory_continuation(root, "A")
            self.assertEqual(evidence["continuedBoundaries"], 0)
            self.assertEqual(evidence["boundaries"][0]["assistantTurns"], 1)

    def test_matching_execution_results_and_separate_boundaries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            entries = [
                {"id": "cut", "type": "context_window"},
                {"id": "call", "parentId": "cut", "type": "message", "message": {
                    "role": "assistant", "content": [{"type": "toolCall", "name": "container_exec", "id": "tool"}]}},
                {"id": "wrong", "parentId": "call", "type": "message", "message": {
                    "role": "toolResult", "toolCallId": "other"}},
            ]
            self.write_session(root, entries)
            self.assertEqual(inspect_memory_continuation(root, "C")["continuedBoundaries"], 0)
            entries.extend([
                {"id": "result", "parentId": "wrong", "type": "message", "message": {
                    "role": "toolResult", "toolCallId": "tool", "isError": True}},
                {"id": "cut2", "parentId": "result", "type": "context_window"},
            ])
            self.write_session(root, entries)
            evidence = inspect_memory_continuation(root, "C")
            self.assertEqual(evidence["continuedBoundaries"], 1)
            self.assertEqual([item["executionResults"] for item in evidence["boundaries"]], [1, 0])
            # Failed commands are execution evidence, not successful recovery.
            entries.append({"id": "fork", "parentId": "cut", "type": "message",
                            "message": {"role": "assistant", "content": []}})
            self.write_session(root, entries)
            self.assertEqual(inspect_memory_continuation(root, "C")["continuedBoundaries"], 0)

    def test_submission_only_and_old_tool_result_do_not_qualify(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_session(root, [
                {"id": "cut", "type": "compaction"},
                {"id": "old", "parentId": "cut", "type": "message", "message": {
                    "role": "toolResult", "toolCallId": "pre-cut-tool"}},
                {"id": "submit", "parentId": "old", "type": "message", "message": {
                    "role": "assistant", "content": [{"type": "toolCall", "name": "container_submit", "id": "tool"}]}},
                {"id": "result", "parentId": "submit", "type": "message", "message": {
                    "role": "toolResult", "toolCallId": "tool"}},
            ])
            self.assertEqual(inspect_memory_continuation(root, "A")["continuedBoundaries"], 0)

    def test_broken_or_ambiguous_session_is_ineligible(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_session(root, [{"id": "cut", "parentId": "missing", "type": "compaction"}])
            self.assertEqual(inspect_memory_continuation(root, "A")["status"], "invalid_session")
            (root / "agent/sessions/extra.jsonl").write_text("")
            self.assertEqual(inspect_memory_continuation(root, "A")["status"], "missing_or_ambiguous_session")

    def test_historical_normal_reply_is_not_execution_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "agent").mkdir()
            (root / "result.json").write_text("{}")
            (root / "agent/sdk-result.json").write_text(json.dumps({"status": "runtime_completed", "group": "C"}))
            report = inspect_trial(root)
            self.assertFalse(report["executionComplete"])
            self.assertFalse(report["memoryQualityEligible"])
            self.assertIsNone(report["officialTaskSuccess"])


class RealAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_controlled_paths_are_explicit_and_faux_rejects_real_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            agent = PiRealAgent(logs_dir=root, config_path=root / "config.json", checkpoint_path=root / "checkpoint", execute_paid=True)
            self.assertEqual(agent.driver_args(str)[-1], str(root / "checkpoint"))
            smoke = PiControlledSmokeAgent(logs_dir=root, checkpoint_path=root / "checkpoint", group="C", model_name="paid/model")
            with self.assertRaises(ValueError):
                await smoke.setup(None)
            with self.assertRaises(ValueError):
                PiControlledSmokeAgent(logs_dir=root, checkpoint_path=root, group="unknown")

    async def test_explicit_execution_gate_and_matching_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "config.json"
            config.write_text(json.dumps({"provider": "test", "model": "model"}))
            for allowed in [False, "true", None]:
                with self.assertRaises(ValueError):
                    PiRealAgent(logs_dir=root, config_path=config, execute_paid=allowed)
            agent = PiRealAgent(logs_dir=root, config_path=config, execute_paid=True, model_name="test/model")
            await agent.setup(None)
            self.assertEqual(agent.driver_args(str), [str(config), "--execute-paid"])
            agent.model_name = "other/model"
            with self.assertRaises(ValueError):
                await agent.setup(None)


class CheckpointFreezeTests(unittest.TestCase):
    def test_freeze_checks_hash_instruction_and_base(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, task = root / "source", root / "task"
            (source / "A").mkdir(parents=True)
            (task / "tests").mkdir(parents=True)
            raw = json.dumps({"type": "message", "message": {"role": "user", "content": "task\n"}}).encode()
            (source / "A/session.jsonl").write_bytes(raw)
            (source / "checkpoint.json").write_text(json.dumps({"sessionSha256": hashlib.sha256(raw).hexdigest()}))
            (source / "repository.json").write_text(json.dumps({"base": "base"}))
            (task / "tests/config.json").write_text(json.dumps({"base_commit": "base"}))
            (task / "instruction.md").write_text("task\n")
            freeze_checkpoint(source, root / "good", "A", task)
            self.assertEqual((root / "good/A/session.jsonl").read_bytes(), raw)
            (task / "instruction.md").write_text("other")
            with self.assertRaisesRegex(ValueError, "instruction"):
                freeze_checkpoint(source, root / "wrong-instruction", "A", task)
            (task / "tests/config.json").write_text(json.dumps({"base_commit": "other"}))
            with self.assertRaisesRegex(ValueError, "base"):
                freeze_checkpoint(source, root / "wrong-base", "A", task)
            (task / "tests/config.json").write_text(json.dumps({"base_commit": "base"}))
            (source / "A/session.jsonl").write_bytes(raw + b"\n")
            with self.assertRaisesRegex(ValueError, "hash"):
                freeze_checkpoint(source, root / "wrong-hash", "A", task)


if __name__ == "__main__":
    unittest.main()
