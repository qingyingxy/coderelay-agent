import { execute } from "./runner.mjs";
import { TaskStore } from "./store.mjs";

export function createQueue({ concurrency = 1 } = {}) {
	const store = new TaskStore();
	const pending = [];
	const waiters = [];
	let active = 0;
	let sequence = 0;

	function pump() {
		while (active < concurrency && pending.length) {
			const { id, run } = pending.shift();
			active++;
			store.update(id, { status: "running" });
			execute(run,
				(result) => store.update(id, { status: "succeeded", result }),
				(error) => store.update(id, { status: "failed", error }),
				() => { active--; pump(); },
			);
		}
		if (!active && !pending.length) for (const resolve of waiters.splice(0)) resolve();
	}

	return {
		enqueue(run) {
			const id = `task-${++sequence}`;
			store.create(id);
			pending.push({ id, run });
			queueMicrotask(pump);
			return id;
		},
		get: (id) => store.get(id),
		subscribe: (listener) => store.subscribe(listener),
		cancel() { return false; },
		onIdle() {
			return !active && !pending.length ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
		},
	};
}
