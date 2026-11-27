# Batching host calls

A Wasm plugin can send a list of host calls in one crossing instead of one call
at a time. The interface is experimental. The SDK and ABI are still
pre-release, and the core plugins do not use it. Start with the scalar
[host API](plugin-development.md#host-api) and reach for a batch only when measuring
shows the crossings cost more than building the plan.

## The general batch contract

`mindstream:plugin/batch.execute` accepts a typed list of commands over 17
operations: logging, UUID/random bytes/permission inspection, clock
reads/add/format, frontmatter, notes all/get, storage read/list/write/delete,
and native tool available/run. `notes.query` and `notes.countByDay` cannot be
batched. Each command behaves exactly like the scalar call, and using a batch
grants no permission. Note writes remain declarative effects outside this host
API.

- Execution is sequential in command order, not parallel.
- Literal text and backward references to earlier text/optional-text results
  can be used as arguments. Missing optional text is an error. References
  cannot point forward, form cycles, select arbitrary fields or invoke code.
- `keep: false` retains an intermediate only inside the host for this batch;
  it avoids copying that result back to the guest. Kept replies contain their
  original command indices.
- The whole plan's reference structure, command count and literal size are
  checked before execution. Argument semantics, permissions and paths are
  checked by the scalar handlers when each command executes.
- The first failure stops later commands and returns its zero-based index,
  phase, completed-command count, earlier kept replies and original error
  kind/detail. Earlier side effects remain, with no rollback. A failing
  operation may itself have produced effects. Recovery is explicit.
- Deadline and cancellation checks run before and after each operation and
  trap the guest. They are not catchable batch error values. Native processes
  use the existing cancellation and shared time-credit/absolute-ceiling logic.
- Limits are 128 commands, 1,024 text arguments, 1 MiB literal request bytes
  and 8 MiB accounted cumulative result data, including unkept results.
  Existing per-operation caps still apply. The result accounting includes
  conservative record overhead; it is not a total host RSS limit.
- These limits are checked after the arguments are copied out of guest memory.
  A request over the per-call
  [9 MiB argument-copy budget](plugin-development.md#runtime-limits) traps the
  invocation before the batch runs, with no failure record; a request within
  it that breaks a batch limit gets the ordinary validation failure.

If the guest must inspect a result to choose its next action, it executes one
plan and then builds another. This API batches known operations; it is not a
second general-purpose interpreter, a transaction system or automatic capture
of arbitrary existing synchronous calls.

The TypeScript SDK exports `batch`, `BatchCommand`/`BatchReply` types and
`HostBatchError`. Rust guests use generated WIT bindings. For example:

```ts
import { batch } from '@mindstream/plugin-sdk';

const replies = batch.execute([
  {
    operation: {
      tag: 'frontmatter',
      val: batch.text(JSON.stringify({ title: 'Example' }))
    },
    keep: false
  },
  {
    operation: {
      tag: 'storage-write',
      val: { path: batch.text('example.txt'), contents: batch.previous(0) }
    },
    keep: false
  },
  {
    operation: { tag: 'storage-read', val: batch.text('example.txt') },
    keep: true
  },
  {
    operation: { tag: 'notes-get', val: batch.text('known-note-id') },
    keep: true
  }
]);
```

This example needs the `pluginStorage.read`, `pluginStorage.write` and
`notes.read` permissions. The frontmatter
result feeds a storage write without a guest round trip; only replies 2 and 3
are returned. Use a separate plan for any guest decision based on those values.

## Recovering after a batch error

TypeScript receives a `HostBatchError`; Rust receives the WIT `failure` record.
Both expose `index`, `phase`, `completed`, `replies` and the original cause.
`completed` counts prefix handlers that returned successfully. It does not
promise durable writes or that the stopping handler had no effects.

- `validation`: no commands ran, `completed` is zero and `replies` is empty.
  `index` identifies the invalid command, or zero for a plan-wide error.
  Fix the plan before retrying.
- `execution`: command `index` returned an error. Commands before it returned
  successfully, so `completed == index`. Their kept replies are available;
  later commands did not run. The stopping command may have partial effects,
  such as a native tool writing a file before an I/O error. Inspect state or
  use an operation with known idempotent behaviour before retrying it.
- `result-limit`: the handler at `index` returned successfully, but its result
  exceeded the cumulative cap. `completed == index + 1`; its effects remain.
  The oversized result is omitted and earlier kept replies are returned.
  Later commands did not run. Repeating the stopping operation just to obtain
  its result may duplicate its effects.

For example, if commands 0 and 1 complete and command 2 is denied:

```ts
import { HostBatchError } from '@mindstream/plugin-sdk';

try {
  batch.execute(commands);
} catch (error) {
  if (!(error instanceof HostBatchError)) throw error;
  // error.index === 2, error.phase === 'execution', error.completed === 2
  // error.replies contains kept outputs from commands 0 and 1, indexed 0/1.
  // Decide recovery using error.kind/detail and the operation's semantics.
}
```

Keep results needed for recovery explicitly. `keep: false` values are discarded
when the call ends, including on failure. A new plan cannot reference a prior
batch's values. Rebuild dependencies using returned values as literals, and
renumber references within the new plan; blindly slicing the old command list
does not preserve reference indices. Recovery uses the same invocation's
remaining budget and permissions, without a fresh deadline.

Deadline/cancellation traps and process termination cannot return this record.
Persistent checkpoints or application-specific idempotency keys would be needed
for recovery across those interruptions; this transport does not provide them.

## Compatibility

A component that imports `batch` needs a host that supplies it; the scalar
APIs being present on an older app is not enough. There is no capability or
version discovery yet, and a later change to a variant shape can break ABI
compatibility. Components built against an earlier batch failure record must
be rebuilt with the current WIT. Scalar-only components are unaffected.

Batch only patterns where measurement shows the crossings cost more than the
plan. Why fewer crossings can still take longer is in the
[host API design notes](internal/plugin-host-api-design.md#why-fewer-crossings-can-take-longer).
