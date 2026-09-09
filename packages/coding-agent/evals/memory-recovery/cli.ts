import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { audit, type Judgment, type RunRecord } from "./audit.ts";
import { parsePierRunConfig } from "./budget.ts";
import { freeze, verifyFrozen } from "./data.ts";
import { run } from "./runner.ts";
import { sample } from "./sample.ts";

const {positionals: args} = parseArgs({allowPositionals: true, strict: true});
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, {flag: "wx"});
switch (args[0]) {
	case "sample":
		assert.equal(args.length, 2); write(args[1], sample()); break;
	case "freeze":
		assert.equal(args.length, 3); write(args[2], freeze(read(args[1]))); break;
	case "offline":
	case "paid": {
		assert.equal(args.length, args[0] === "offline" ? 4 : 6);
		const group = args[3]; assert.ok(group === "A" || group === "C");
		const paid = args[0] === "paid" ? {config: parsePierRunConfig(read(args[4])), allowedOrigin: args[5]} : undefined;
		const results = await run(verifyFrozen(read(args[1])), {output: args[2], group, paid});
		console.log(JSON.stringify({group, completed: results.filter(r => r.completed).length, attempted: results.length, offline: !paid}));
		if (results.some(r => !r.completed)) process.exitCode = 1;
		break;
	}
	case "audit":
		assert.equal(args.length, 5);
		write(args[4], audit(verifyFrozen(read(args[1])), read(args[2]) as RunRecord, read(args[3]) as Record<string, Record<string, Judgment>>));
		break;
	default:
		throw new Error("Commands: sample FILE | freeze INPUT OUTPUT | offline FROZEN NEW_DIR A|C | paid FROZEN NEW_DIR A|C CONFIG HTTPS_ORIGIN | audit FROZEN RUN JUDGMENTS OUTPUT");
}
