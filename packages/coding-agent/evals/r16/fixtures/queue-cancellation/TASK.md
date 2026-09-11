# Queue Cancellation

Implement cancellation in the existing in-memory task queue. Preserve FIFO order,
the existing exports, result values, and failure handling. Only modify the three
existing files under src. Tests, package.json, and this contract are immutable.

## Acceptance

- enqueue(run) returns an ID. run receives an AbortSignal. get(id) returns a
  detached snapshot, or undefined for an unknown ID.
- cancel(id) returns true only on the first cancellation of a queued or running
  task. Unknown IDs and succeeded, failed, or cancelled tasks return false.
- Queued cancellation immediately sets cancelled, never invokes run, and emits
  one cancelled snapshot to subscribers.
- Running cancellation sets cancelled before aborting its signal. Abort handlers
  must observe cancelled. Emit one cancelled snapshot. Repeated cancellation does
  not abort or emit again. Late resolve/reject cannot change cancelled or publish
  another terminal event, and must not produce an unhandled rejection.
- Running cancellation does not free a concurrency slot until run actually
  settles. After settlement, pending tasks continue in FIFO order. Skip cancelled
  queued tasks without consuming slots or blocking subsequent tasks.
- subscribe(listener) returns an unsubscribe function. Listeners receive detached
  snapshots for queued, running, and terminal transitions, with state committed
  before notification. Mutating a snapshot cannot mutate internal task state.
- onIdle() resolves when no queued or physically running work remains. Cancelled
  but still executing work is not idle. Multiple waiters must all resolve. An
  already idle queue resolves immediately.

Inputs are valid: positive integer concurrency, callable tasks and non-throwing
listeners. Tasks may throw synchronously, resolve/reject asynchronously, or ignore
abort until they settle. IDs are unique strings. Snapshot isolation is shallow;
deep cloning result/error objects is not required. No retries, persistence,
networking, timeouts, forced termination, or general input hardening is requested.

Run node --test. Do not force a context cut solely for this evaluation.
