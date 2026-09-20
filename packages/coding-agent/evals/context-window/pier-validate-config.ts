import { readFileSync } from "node:fs";
import { parsePierRunConfig, PierBudget } from "./pier-budget.ts";

const path = process.argv[2];
if (!path) throw new Error("Configuration path required");
const config = parsePierRunConfig(JSON.parse(readFileSync(path, "utf8")));
const budget = new PierBudget(config, () => {});
console.log(JSON.stringify({ config, perRequestReservationUsd: budget.requestReservationUsd,
	minimumInitialBudgetUsd: budget.requestReservationUsd, paidCalls: 0 }));
