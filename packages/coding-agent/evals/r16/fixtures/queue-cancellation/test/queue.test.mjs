import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createQueue } from "../src/queue.mjs";

function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

test("preserves success, sync throw, async rejection, and idle waiters", async () => {
	const q = createQueue();
	const error = new Error("expected");
	const a = q.enqueue(() => 42);
	const b = q.enqueue(() => { throw error; });
	const c = q.enqueue(() => Promise.reject(error));
	await Promise.all([q.onIdle(), q.onIdle()]);
	assert.equal(q.get(a).result, 42);
	assert.equal(q.get(b).status, "failed");
	assert.equal(q.get(c).error, error);
	assert.equal(q.cancel(a), false);
	assert.equal(q.cancel(b), false);
	assert.equal(q.cancel("unknown"), false);
	assert.equal(q.get("unknown"), undefined);
});

test("queued cancellation never starts and publishes once", async () => {
	const q = createQueue();
	const events = [];
	q.subscribe((s) => events.push(s));
	let calls = 0;
	const id = q.enqueue(() => calls++);
	assert.equal(q.cancel(id), true);
	assert.equal(q.cancel(id), false);
	await q.onIdle();
	assert.equal(calls, 0);
	assert.equal(q.get(id).status, "cancelled");
	assert.deepEqual(events.map((e) => e.status), ["queued", "cancelled"]);
});

for (const outcome of ["resolve", "reject"]) {
	test(`running cancellation retains its slot and ignores late ${outcome}`, async () => {
		const q = createQueue();
		const gate = deferred();
		const events = [];
		let signal, observed, aborts = 0, nextStarted = false;
		q.subscribe((s) => events.push(s));
		const id = q.enqueue((s) => {
			signal = s;
			s?.addEventListener("abort", () => { aborts++; observed = q.get(id).status; });
			return gate.promise;
		});
		const next = q.enqueue(() => { nextStarted = true; return "next"; });
		await setImmediate();
		try {
			assert.ok(signal instanceof AbortSignal);
			assert.equal(q.cancel(id), true);
			assert.equal(q.cancel(id), false);
			assert.equal(signal.aborted, true);
			assert.equal(observed, "cancelled");
			assert.equal(aborts, 1);
			let idle = false;
			q.onIdle().then(() => { idle = true; });
			await setImmediate();
			assert.equal(idle, false);
			assert.equal(nextStarted, false);
		} finally {
			if (outcome === "resolve") gate.resolve("late");
			else gate.reject(new Error("late"));
			await q.onIdle();
		}
		assert.equal(q.get(id).status, "cancelled");
		assert.equal(q.get(id).result, undefined);
		assert.equal(q.get(id).error, undefined);
		assert.equal(q.get(next).result, "next");
		assert.deepEqual(events.filter((e) => e.id === id).map((e) => e.status), ["queued", "running", "cancelled"]);
	});
}

test("skips cancelled pending tasks, preserves FIFO and concurrency", async () => {
	const q = createQueue({ concurrency: 2 });
	const first = deferred(), second = deferred();
	const started = [];
	q.enqueue(() => { started.push(1); return first.promise; });
	q.enqueue(() => { started.push(2); return second.promise; });
	const cancelled = q.enqueue(() => started.push(3));
	q.enqueue(() => started.push(4));
	q.enqueue(() => started.push(5));
	await setImmediate();
	try {
		assert.deepEqual(started, [1, 2]);
		assert.equal(q.cancel(cancelled), true);
		first.resolve();
		await setImmediate();
		assert.deepEqual(started, [1, 2, 4, 5]);
	} finally {
		first.resolve(); second.resolve(); await q.onIdle();
	}
});

test("snapshots are detached and unsubscribe works", async () => {
	const q = createQueue();
	const seen = [];
	q.subscribe((s) => { assert.equal(q.get(s.id).status, s.status); s.status = "corrupted"; });
	const unsubscribe = q.subscribe((s) => seen.push(s.status));
	const id = q.enqueue(() => 7);
	q.get(id).status = "corrupted";
	await q.onIdle();
	assert.deepEqual(seen, ["queued", "running", "succeeded"]);
	assert.equal(q.get(id).status, "succeeded");
	unsubscribe();
	q.enqueue(() => 8);
	await q.onIdle();
	assert.equal(seen.length, 3);
});

test("already idle resolves and cancelling all pending work releases all waiters", async () => {
	const q = createQueue();
	await q.onIdle();
	const a = q.enqueue(() => assert.fail("cancelled task started"));
	const b = q.enqueue(() => assert.fail("cancelled task started"));
	const idle = Promise.all([q.onIdle(), q.onIdle()]);
	assert.equal(q.cancel(a), true);
	assert.equal(q.cancel(b), true);
	await idle;
});

test("onIdle called from a queued subscriber waits for physical settlement", { timeout: 5000 }, async () => {
	const q = createQueue();
	const gate = deferred();
	let idleResolved = false;
	let idleFromSubscriber;
	q.subscribe((snapshot) => {
		if (snapshot.status === "queued") {
			idleFromSubscriber = q.onIdle().then(() => { idleResolved = true; });
		}
	});
	const id = q.enqueue(() => gate.promise);
	await setImmediate();
	try {
		assert.ok(idleFromSubscriber);
		assert.equal(q.get(id).status, "running");
		assert.equal(idleResolved, false, "queued notification must not expose an idle queue");
	} finally {
		gate.resolve("done");
		await q.onIdle();
	}
	await idleFromSubscriber;
	assert.equal(idleResolved, true);
	assert.equal(q.get(id).status, "succeeded");
});

test("cancellation from a running subscriber aborts the task signal", { timeout: 5000 }, async () => {
	const q = createQueue();
	let accepted, signalAborted;
	q.subscribe((snapshot) => {
		if (snapshot.status === "running") accepted = q.cancel(snapshot.id);
	});
	const id = q.enqueue((signal) => { signalAborted = signal?.aborted; });
	await q.onIdle();
	assert.equal(accepted, true);
	assert.equal(q.get(id).status, "cancelled");
	assert.equal(signalAborted, true);
});
