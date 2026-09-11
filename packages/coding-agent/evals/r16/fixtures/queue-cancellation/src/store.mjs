export class TaskStore {
	records = new Map();
	listeners = new Set();

	create(id) {
		const record = { id, status: "queued", result: undefined, error: undefined };
		this.records.set(id, record);
		this.publish(record);
	}

	get(id) {
		const record = this.records.get(id);
		return record ? { ...record } : undefined;
	}

	update(id, changes) {
		const record = this.records.get(id);
		Object.assign(record, changes);
		this.publish(record);
	}

	publish(record) {
		for (const listener of this.listeners) listener({ ...record });
	}

	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
