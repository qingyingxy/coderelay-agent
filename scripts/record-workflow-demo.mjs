// Capture real InteractiveMode output for each offline demo.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../.artifacts/github-demo-recording/", import.meta.url);
const scenario = process.argv[2] ?? "config";
if (!["config", "automatic", "planner"].includes(scenario)) throw new Error("Use config, automatic or planner");
const prefix = scenario === "config" ? "interactive" : scenario;
mkdirSync(output, { recursive: true });
const cols = 100;
const rows = 34;
const terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
const env = { ...process.env, COLUMNS: String(cols), LINES: String(rows), FORCE_COLOR: "3", COLORTERM: "truecolor", TERM: "xterm-256color", PI_OFFLINE: "1" };
delete env.NO_COLOR;
const child = spawn(process.execPath, [
	"node_modules/tsx/dist/cli.mjs",
	`packages/coding-agent/examples/sdk/${scenario === "planner" ? "26-planner-executor-demo.ts" : "25-config-workflow-demo.ts"}`,
	"--interactive", ...(scenario === "automatic" ? ["--automatic"] : []),
], {
	cwd: root,
	env,
	stdio: ["pipe", "pipe", "pipe"],
	windowsHide: true,
});
const started = Date.now();
const chunks = [];
const frames = [];
let stderr = "";
let stdout = "";
terminal.onData((data) => { if (!child.stdin.destroyed) child.stdin.write(data); });
terminal.parser.registerOscHandler(11, () => {
	child.stdin.write("\x1b]11;rgb:1010/1414/1c1c\x1b\\");
	return true;
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (data) => {
	stdout += data;
	chunks.push([Date.now() - started, data]);
	terminal.write(data);
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (data) => { stderr += data; });
const interval = setInterval(() => {
	const buffer = terminal.buffer.active;
	const lines = [];
	for (let y = 0; y < rows; y++) {
		const line = buffer.getLine(buffer.viewportY + y);
		const cells = [];
		for (let x = 0; x < cols; x++) {
			const cell = line?.getCell(x);
			if (!cell || cell.getWidth() === 0) continue;
			cells.push([x, cell.getChars(), cell.getWidth(),
				cell.isFgDefault() ? null : [cell.isFgRGB() ? "rgb" : "palette", cell.getFgColor()],
				cell.isBgDefault() ? null : [cell.isBgRGB() ? "rgb" : "palette", cell.getBgColor()],
				Boolean(cell.isBold()), Boolean(cell.isDim()), Boolean(cell.isInverse())]);
		}
		lines.push(cells);
	}
	frames.push({ time: Date.now() - started, lines });
}, 250);
const timeout = setTimeout(() => child.kill(), 90_000);
try {
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
	if (code !== 0 || !stdout.includes("[demo] PASS")) throw new Error(`Demo failed (${code}): ${stderr}`);
	writeFileSync(new URL(`${prefix}-ansi.json`, output), JSON.stringify({ scenario, cols, rows, chunks, stderr }));
	writeFileSync(new URL(`${prefix}-frames.json`, output), JSON.stringify({ scenario, cols, rows, frames }));
	console.log(`Captured ${frames.length} frames from ${scenario} terminal output; demo assertions passed.`);
} finally {
	clearInterval(interval);
	clearTimeout(timeout);
	terminal.dispose();
	if (child.exitCode === null) child.kill();
}
