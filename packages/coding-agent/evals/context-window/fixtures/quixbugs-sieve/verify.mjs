import { spawnSync } from "node:child_process";

const candidates = process.platform === "win32" ? ["py", "python"] : ["python3", "python"];
for (const command of candidates) {
	const result = spawnSync(command, ["-m", "unittest", "discover", "-s", "test"], {
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		stdio: "inherit",
		timeout: 15_000,
	});
	if (result.error?.code === "ENOENT") continue;
	if (result.error?.code === "ETIMEDOUT") {
		console.error("QuixBugs verification exceeded 15 seconds");
		process.exit(124);
	}
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}

throw new Error("Python 3 was not found");
