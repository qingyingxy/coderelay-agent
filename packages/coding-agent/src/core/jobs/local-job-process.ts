import { spawn } from "node:child_process";
import { spawnProcess, waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { JobProcess, JobProcessExit, JobProcessFactory, StartJobProcessInput } from "./types.ts";

function sendGracefulTreeSignal(pid: number): void {
	if (process.platform === "win32") {
		const killer = spawn("taskkill", ["/T", "/PID", String(pid)], {
			stdio: "ignore",
			detached: true,
			windowsHide: true,
		});
		killer.unref();
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// The process already exited.
		}
	}
}

export interface LocalJobProcessFactoryOptions {
	readonly shellPath?: string;
}

export class LocalJobProcessFactory implements JobProcessFactory {
	readonly #shellPath?: string;

	constructor(options: LocalJobProcessFactoryOptions = {}) {
		this.#shellPath = options.shellPath;
	}

	start(input: StartJobProcessInput): JobProcess {
		const shell = getShellConfig(this.#shellPath);
		const args = shell.commandTransport === "stdin" ? shell.args : [...shell.args, input.command];
		const child = spawnProcess(shell.shell, args, {
			cwd: input.cwd,
			env: getShellEnv(),
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		if (!child.pid) {
			child.kill();
			throw new Error("Job process did not expose a PID");
		}
		if (!child.stdout || !child.stderr) {
			child.kill();
			throw new Error("Job process did not expose output streams");
		}
		const pid = child.pid;
		trackDetachedChildPid(pid);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", input.onStdout);
		child.stderr.on("data", input.onStderr);
		if (shell.commandTransport === "stdin") {
			child.stdin?.end(input.command);
		}
		let exited = false;
		const completion: Promise<JobProcessExit> = waitForChildProcess(child)
			.then((exitCode) => {
				exited = true;
				return { exitCode };
			})
			.finally(() => untrackDetachedChildPid(pid));
		return {
			pid,
			wait: () => completion,
			terminate: async (graceMs) => {
				if (exited) {
					return;
				}
				sendGracefulTreeSignal(pid);
				await Promise.race([
					completion.then(() => undefined),
					new Promise<void>((resolve) => {
						setTimeout(resolve, graceMs);
					}),
				]);
				if (!exited) {
					killProcessTree(pid);
					await completion.catch(() => undefined);
				}
			},
		};
	}
}
