export function execute(run, onSuccess, onFailure, onSettled) {
	Promise.resolve().then(() => run()).then(onSuccess, onFailure).finally(onSettled);
}
