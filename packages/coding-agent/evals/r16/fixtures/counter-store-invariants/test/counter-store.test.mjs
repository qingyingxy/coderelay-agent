import assert from "node:assert/strict";
import test from "node:test";
import { createCounterStore } from "../src/counter-store.mjs";

test("rejects an invalid decrement atomically", () => {
	const store = createCounterStore(2);
	const observed = [];
	store.subscribe((value) => observed.push(value));

	assert.throws(() => store.decrement(3), /negative/);
	assert.equal(store.value, 2);
	assert.deepEqual(observed, []);
});

test("notifies subscribers after a valid commit", () => {
	const store = createCounterStore(3);
	const observed = [];
	store.subscribe((value) => observed.push(value));

	assert.equal(store.decrement(2), 1);
	assert.deepEqual(observed, [1]);
});
