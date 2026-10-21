# Plugin host API design and general batching

This is the design guidance for the experimental Wasm batch interface. The
measured comparison is in [the physical Android report](benchmarks/wasm-host-batch-2026-10-21/README.md).
It covers all current host capabilities, not only dates. The production
Templates component remains TypeScript, and Luau is retained.

## Decide by ownership and measured total cost

The host API is a capability and application contract. It need not implement
every operation a guest can compute. Boundary count is one performance input;
marshalling, bytes copied, plan construction, guest execution, host work,
startup, package size and retained memory also matter.

| Layer                        | Keep in the host                                                                                                      | Keep in the guest                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Authority and platform facts | Vault access, plugin storage roots, secure randomness, system clock, declared native tools, approval and cancellation | Plugin policy deciding when to request these capabilities                               |
| Application semantics        | Validated note effects, stable IDs, editor/vault consistency and permission enforcement                               | Template selection, filters, sorting, interpolation and effect selection                |
| Optional shared utilities    | Calendar/locale policy or expensive shared implementation when measured value justifies its API/size/maintenance cost | Pure parsing, transforms, algorithms and libraries that fit the guest's resource budget |

Calendar arithmetic is computable in a guest. OS timezone rules and the current
clock are host facts; a guest can instead ship its own timezone database and
receive a zone ID/time in its input. Our local-calendar experiment exposes the
resulting package/memory, update and interpreter costs. Frontmatter formatting
is also a utility, not an essential authority boundary. Its current presence
in the host is a design choice, not a universal rule for future helpers.
Keep those utilities optional and separate from privileged capabilities.

Prefer domain-sized operations where they fit: one metadata snapshot or a
bounded query is better than fetching the same note fields individually.
Return only the data the plugin needs. An opaque resource handle can be useful
for large host-owned state, but its lifetime, ownership, permissions and
cancellation contract must be explicit. A general batch does not eliminate
payload copying or replace a good bulk/query API.

## What other systems do

These sources were checked on 2026-10-21. They illustrate different choices;
they are not evidence that the same performance tradeoff applies to our host.

- [Extism host functions](https://extism.org/docs/concepts/host-functions/)
  describes the usual plugin as input, guest logic and output. Custom host
  functions add access such as database queries when the application needs it.
  This supports keeping plugin logic in the guest and exposing specific host
  capabilities as needed.
- [Wasmtime's introduction](https://docs.wasmtime.dev/introduction.html) lists
  WASI interfaces for filesystems, networking, clocks and randomness. Its
  [security documentation](https://docs.wasmtime.dev/security.html) describes
  capability-based filesystem access. The lesson for us is explicit scoped
  authority, not giving a plugin an unchecked path or database connection.
- [Figma's plugin environment](https://developers.figma.com/docs/plugins/how-plugins-run/)
  provides ordinary language built-ins, including JSON, Math, Date and RegExp,
  while access to the document goes through the editor API. Browser APIs are
  restricted and UI is separated through messaging. Its main-thread sandbox
  is a different execution model from our background Wasm worker; copy the
  ownership distinction rather than assume equivalent boundary costs.
- [VS Code WorkspaceEdit](https://code.visualstudio.com/api/references/vscode-api#WorkspaceEdit)
  collects changes across documents/resources into one domain operation.
  [applyEdit](https://code.visualstudio.com/api/references/vscode-api#workspace.applyEdit)
  documents ordering and different failure behavior for text-only versus
  resource edits. Bulk submission and transactional behavior are separate
  promises; a batch should not imply rollback unless it implements it.
- Neovim's current docs [deprecate nvim_call_atomic](https://neovim.io/doc/user/deprecated/)
  in favor of [nvim_exec_lua](<https://neovim.io/doc/user/api/#nvim_exec_lua()>).
  Executing host-side Lua can combine arbitrary work in that editor's trust
  model. We use a closed typed operation list instead of evaluating guest
  scripts in the privileged host. That preserves the Wasm capability boundary.
- [WIT](https://component-model.bytecodealliance.org/design/wit.html) defines
  typed contracts, including records, variants and resources; it does not
  define an interface's behavior. Ordering, limits, ownership, failures and
  compatibility remain our responsibility.

## The general batch contract

`mindstream:plugin/batch.execute` accepts a typed list of commands over all
17 existing operations: logging, UUID/random bytes/permission inspection,
clock reads/add/format, frontmatter, notes all/get, storage read/list/write/
delete, and native tool available/run. Each dispatch delegates to the same
`HostContext` method as the scalar API. No permission is granted by using a
batch. Note writes remain declarative effects outside this host API.

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
- The first failure stops later commands and returns its index and original
  error kind/detail. Earlier side effects remain, with no rollback. Earlier
  kept results are not returned on failure. Callers must recover explicitly;
  automatic retry of a partially executed batch would be unsafe.
- Deadline and cancellation checks run before and after each operation and
  trap the guest. They are not catchable batch error values. Native processes
  use the existing cancellation and shared time-credit/absolute-ceiling logic.
- Limits are 128 commands, 1,024 text arguments, 1 MiB literal request bytes
  and 8 MiB accounted cumulative result data, including unkept results.
  Existing per-operation caps still apply. The result accounting includes
  conservative record overhead; it is not a total host RSS limit. These checks
  occur after the canonical ABI lifts arguments, so guest/host allocation
  limits and broader memory testing remain relevant.

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

This example needs storage read/write and notes read grants. The frontmatter
result feeds a storage write without a guest round trip; only replies 2 and 3
are returned. Use a separate plan for any guest decision based on those values.
The SDK test host mirrors the transport but still does not model execution
budgets; real runtime tests/probes cover that behavior.

## Compatibility and adoption

Scalar APIs remain available. Legacy built components were tested against the
extended host, including the unchanged shipped TypeScript component. A newly
built component importing `batch` requires a host that supplies that interface;
it cannot run on an older app merely because the scalar APIs exist. The SDK
and ABI are still private/pre-release. Before publishing a stable contract,
version the operation set and define capability/version discovery; future
changes to variant shapes are not automatically ABI-compatible.

Use explicit batches for measured patterns with enough crossing/copy cost to
outweigh plan overhead. Keep simple calls simple. Preserve the baseline when
an optimization loses. The current general batching candidate is optional;
it does not replace shipped Templates. A purpose-built bulk operation or
per-call caching may be a better future experiment for a hot path, but neither
is implemented or claimed faster by this comparison.

New general-host API code can affect release binary/package sizes even if a
plugin does not call it. Matching app startup/memory/package measurements must
be repeated before closing release gates for this revision. The earlier
optimization report's package pairs do not validate the new host additions.
No budgets were raised, no untested platform is marked passed, and Luau stays.
