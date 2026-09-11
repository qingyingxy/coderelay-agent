import { execute } from "./runner.mjs";
import { TaskStore } from "./store.mjs";

export function createQueue({ concurrency = 1 } = {}) {
	const store = new TaskStore();
	const pending = [];
	const controls = new Map();
	const waiters = [];
	let active = 0;
	let sequence = 0;
	function pump() {
		while (active < concurrency && pending.length) {
			const { id, run } = pending.shift();
			if (store.get(id).status === "cancelled") continue;
			active++;
			const controller = new AbortController();
			controls.set(id, controller);
			store.update(id, { status: "running" });
			execute(() => run(controller.signal),
				(result) => { if (store.get(id).status === "running") store.update(id, { status: "succeeded", result }); },
				(error) => { if (store.get(id).status === "running") store.update(id, { status: "failed", error }); },
				() => { controls.delete(id); active--; pump(); },
			);
		}
		if (!active && !pending.length) for (const resolve of waiters.splice(0)) resolve();
	}
	return {
		enqueue(run) {
			const id = `task-${++sequence}`;
			pending.push({ id, run });
			store.create(id);
			queueMicrotask(pump);
			return id;
		},
		get: (id) => store.get(id),
		subscribe: (listener) => store.subscribe(listener),
		cancel(id) {
			const status = store.get(id)?.status;
			if (status !== "queued" && status !== "running") return false;
			store.update(id, { status: "cancelled" });
			controls.get(id)?.abort();
			queueMicrotask(pump);
			return true;
		},
		onIdle() {
			return !active && !pending.length ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
		},
	};
}
