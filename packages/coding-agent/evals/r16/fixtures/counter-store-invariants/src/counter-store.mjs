export function createCounterStore(initialValue = 0) {
	let value = initialValue;
	const subscribers = new Set();

	return {
		get value() {
			return value;
		},
		subscribe(listener) {
			subscribers.add(listener);
			return () => subscribers.delete(listener);
		},
		decrement(amount) {
			value -= amount;
			for (const listener of subscribers) listener(value);
			if (value < 0) throw new Error("Counter cannot be negative");
			return value;
		},
	};
}
