import assert from "node:assert/strict";
import test from "node:test";
import { slugify } from "../src/slug.mjs";

test("normalizes repeated whitespace", () => {
	assert.equal(slugify("  Durable   Agent Runtime  "), "durable-agent-runtime");
});

test("preserves the existing public behavior", () => {
	assert.equal(slugify("Pi CLI"), "pi-cli");
});
