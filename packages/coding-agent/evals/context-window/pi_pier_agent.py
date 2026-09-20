"""Pier host adapter for the no-paid-model Pi SDK transport smoke."""

import asyncio
import json
from pathlib import Path
import subprocess

from pier.agents.base import BaseAgent


class PiFauxAgent(BaseAgent):
    driver_name = "pier-faux-driver.ts"
    bridge_timeout = 180

    def driver_args(self, windows):
        return []

    @staticmethod
    def name():
        return "pi-faux-smoke"

    def version(self):
        return "1"

    async def setup(self, environment):
        if self.model_name is not None:
            raise ValueError("This adapter accepts no paid model")

    async def run(self, instruction, environment, context):
        root = Path(__file__).resolve().parents[4]
        node = "/mnt/d/compileenv/nodejs/node.exe"

        def windows(path):
            return subprocess.check_output(["wslpath", "-w", str(path)], text=True).strip()

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / "instruction.txt").write_text(instruction, encoding="utf-8")
        freeze = subprocess.check_output(["/home/qingying/.local/share/pi-deepswe/venv/bin/pip", "freeze"], text=True)
        (self.logs_dir / "requirements.freeze.txt").write_text(freeze, encoding="utf-8")
        with (self.logs_dir / "node-stderr.txt").open("wb") as errors:
            process = await asyncio.create_subprocess_exec(
                node, "--import", "tsx", windows(Path(__file__).with_name(self.driver_name)),
                windows(self.logs_dir), *self.driver_args(windows), cwd=root, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=errors, limit=131072,
            )
            complete = False
            try:
                process.stdin.write((json.dumps({"instruction": instruction}) + "\n").encode())
                await process.stdin.drain()
                with (self.logs_dir / "bridge.jsonl").open("w", encoding="utf-8") as trace:
                    while line := await asyncio.wait_for(process.stdout.readline(), self.bridge_timeout):
                        request = json.loads(line)
                        if request.get("type") == "complete":
                            complete = True
                            process.stdin.close()
                            break
                        if request.get("type") != "exec" or not isinstance(request.get("command"), str):
                            raise ValueError("Invalid bridge request")
                        if len(request["command"]) > 16384:
                            raise ValueError("Command too large")
                        result = await environment.exec(request["command"], cwd="/app", timeout_sec=60)
                        response = {"stdout": (result.stdout or "")[:32000],
                                    "stderr": (result.stderr or "")[:32000], "return_code": result.return_code}
                        trace.write(json.dumps({"request": request, "response": response}) + "\n")
                        trace.flush()
                        process.stdin.write((json.dumps(response) + "\n").encode())
                        await process.stdin.drain()
                code = await asyncio.wait_for(process.wait(), 30)
                if code != 0 or not complete:
                    raise RuntimeError(f"Pi SDK transport failed: exit={code}, complete={complete}")
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
        self.populate_context(context)

    def populate_context(self, context):
        context.cost_usd = 0
        context.metadata = {"provider": "faux", "quality_evaluation": False, "transport_complete": True}


class PiSubmissionSmokeAgent(PiFauxAgent):
    driver_name = "pier-submission-smoke-driver.ts"

    @staticmethod
    def name():
        return "pi-submission-smoke"


class PiControlledSmokeAgent(PiFauxAgent):
    driver_name = "pier-controlled-smoke-driver.ts"

    def __init__(self, *args, checkpoint_path=None, group=None, **kwargs):
        super().__init__(*args, **kwargs)
        if not checkpoint_path or group not in ("A", "C"):
            raise ValueError("Controlled smoke requires checkpoint_path and group A/C")
        self.checkpoint_path = Path(checkpoint_path).resolve()
        self.group = group

    def driver_args(self, windows):
        return [windows(self.checkpoint_path), self.group]


class PiRealAgent(PiFauxAgent):
    driver_name = "pier-real-driver.ts"
    bridge_timeout = 10860

    def __init__(self, *args, config_path=None, execute_paid=False, checkpoint_path=None, **kwargs):
        super().__init__(*args, **kwargs)
        if execute_paid is not True or not config_path:
            raise ValueError("Explicit execute_paid=true and config_path required")
        self.config_path = Path(config_path).resolve()
        self.checkpoint_path = Path(checkpoint_path).resolve() if checkpoint_path else None

    @staticmethod
    def name():
        return "pi-real-budgeted"

    async def setup(self, environment):
        config = json.loads(self.config_path.read_text())
        if self.model_name != f'{config["provider"]}/{config["model"]}':
            raise ValueError("Pier model must match run configuration")

    def driver_args(self, windows):
        return [windows(self.config_path), "--execute-paid", *([windows(self.checkpoint_path)] if self.checkpoint_path else [])]

    def populate_context(self, context):
        result = json.loads((self.logs_dir / "sdk-result.json").read_text())
        context.cost_usd = result["accountedUsd"]
        context.n_input_tokens = result["inputTokens"]
        context.n_output_tokens = result["outputTokens"]
        context.n_agent_steps = result["requests"]
        context.metadata = result
