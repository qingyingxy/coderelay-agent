export class WorkspaceIntegrationQueue {
	readonly #tails = new Map<string, Promise<void>>();

	async run<T>(repositoryIdentity: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(repositoryIdentity) ?? Promise.resolve();
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.#tails.set(repositoryIdentity, current);
		await previous.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release?.();
			if (this.#tails.get(repositoryIdentity) === current) {
				this.#tails.delete(repositoryIdentity);
			}
		}
	}
}

export const DEFAULT_WORKSPACE_INTEGRATION_QUEUE = new WorkspaceIntegrationQueue();
