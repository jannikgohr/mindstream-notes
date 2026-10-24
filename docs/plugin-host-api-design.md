# Plugin host API design and general batching

This is the design guidance for the experimental Wasm batch interface. It
covers all current host capabilities, not only dates. The production Templates
component uses Rust with scalar host dates. TypeScript examples remain outside
the shipped tree.

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

## Next host capabilities

This is a proposal, not a list of implemented imports. The current Wasm API
has no general HTTP, note-body, attachment, credential or event API. Declared
text-checker services, artifact downloads and native services already have
separate host mechanisms; they do not grant a Wasm guest arbitrary networking.
The existing `notes` interface returns metadata, while note writes use
validated effects.

Prioritize capabilities with concrete plugin uses:

| Capability                                         | Useful for                                                               | Host contract to define                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded note queries and opt-in content reads      | Search, backlinks, transformations, summarizers                          | Filters, selected fields, pagination, revision IDs and separate grants for content access. Avoid returning every body by default.                     |
| Revision-checked bulk edit effects                 | Applying transformations across notes                                    | Expected revisions, validation before writes, conflict results and explicit atomicity. Do not make generic host batching promise a vault transaction. |
| Scoped HTTP requests                               | Service integrations, publishing, remote lookups and local model servers | Approved destinations, bounded bytes and concurrency, typed responses, cancellation and credential isolation.                                         |
| Host-managed credentials                           | Authenticated service integrations                                       | User-selected opaque credential references scoped to a plugin and destination. No app account tokens, cookies or raw secrets in manifests/logs.       |
| Attachment handles and user-selected import/export | OCR, image processing, PDF tools and export formats                      | Explicit selection or vault grants, byte limits and streamed access where needed. No arbitrary filesystem paths.                                      |
| Cancellable jobs and bounded change subscriptions  | Slow I/O, AI/OCR and incremental indexing                                | Ownership, progress, result delivery, backpressure and teardown on disable/remove/vault closure. Mobile OS suspension must remain visible.            |
| Capability and version discovery                   | Portable third-party plugins                                             | Supported interface versions and optional operations, distinct from the user's grants. A guest can choose a fallback before calling a missing import. |

### HTTP proposal

Provide a typed host request operation with method, URL, headers and byte
body. Return status, bounded headers and bytes. Treat HTTP statuses such as
404/429 as responses; distinguish permission, destination, timeout, size and
transport errors. Guests can handle JSON, application retries and service
protocols themselves. Avoid a host wrapper for each service or language.

Require an explicit networking grant plus approved scheme/host/port
destinations. A manifest update that widens destinations must require review,
even if its permission names are unchanged. HTTPS should be the default.
Loopback/LAN endpoints and plain HTTP need distinct, visible opt-in so local
LanguageTool/model servers remain possible. A read-and-network plugin can
send granted note data to those destinations; approval must make that clear.

The host must enforce destinations during DNS resolution and connection,
including IPv4/IPv6, redirects and DNS rebinding. Default to no automatic
redirects; any later redirect support must validate every hop and avoid
forwarding credentials across origins. Do not inherit app cookies, auth
headers, filesystem schemes or ambient proxy authority. Scope credential
handles to the approved destination and redact sensitive request details.
This needs backend enforcement rather than relying on WebView CORS.

Set explicit request/response byte caps, decompressed-body caps, concurrency
limits and connect/total timeouts. Requests must stop on cancellation, plugin
disable/remove and vault closure. Slow I/O needs a specified job/continuation
contract or an explicitly bounded I/O allowance. The existing one-second
guest budget must not silently expand, and network waits must not freeze the
UI. Result delivery must recheck the plugin and vault lifetime. Neither
generic batching nor an automatic retry should replay a non-idempotent POST.
If network batches become useful, specify their sequential/parallel and
partial-completion semantics separately from the current synchronous batch.

This follows the scoped-access pattern in
[Figma's network manifest](https://developers.figma.com/docs/plugins/making-network-requests/)
and [Extism's explicit allowed hosts](https://extism.org/docs/install/).
[OWASP's SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
explains why validating an initial URL alone is insufficient and recommends
disabling redirects to prevent validation bypass. These are design references,
not claims that our proposed HTTP implementation already exists or is tested.

Pure text parsing, filtering, sorting, hashing and service-specific payload
construction should stay in guests unless measurement justifies a shared
implementation. Bounded queries and host-owned jobs reduce repeated data
transfer more effectively than mirroring every small helper in the host.

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
  in favor of [running a script in the editor](<https://neovim.io/doc/user/api/#nvim_exec_lua()>).
  A host-side script can combine arbitrary work in that editor's trust model. We use a closed typed operation list instead of evaluating guest
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
  conservative record overhead; it is not a total host RSS limit. These checks
  occur after the canonical ABI lifts arguments. During lifting, Wasmtime
  applies a separate 9 MiB argument-copy budget per host call, including
  container overhead. It resets on each host call and cannot be raised by the
  plugin. This bounds copies of aliased guest strings before the batch
  validator receives its owned values. It is separate from guest linear memory
  and total host RSS.
- Exhausting the argument-copy budget traps the invocation before the batch
  handler runs, with no batch failure or progress record. Earlier host calls
  can still have effects. Requests that fit lifting but exceed a batch limit
  return the ordinary batch failure. Host-to-guest results are outside the
  argument-copy budget; the batch result cap and guest memory cap still apply.

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
  use an operation with known idempotent behavior before retrying it.
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

## Why fewer crossings can take longer

The physical Android comparison measured complete implementations. Date-heavy native AOT p95 was
0.533-0.545 ms scalar versus 0.564-0.570 ms batch; interpreter p95 was
1.537-1.558 versus 2.338-2.343 ms. These measurements predate the richer failure
record. They are not new timings for the revised ABI.

The template batch candidate first scans title/body, parses date expressions
and allocates commands, then lowers the typed plan across the component ABI.
The host validates and dispatches it, retains intermediate values and returns
selected results. The guest builds a JSON result map; the normal renderer
parses expressions again and looks them up. Scalar rendering computes dates
as it encounters them. Both paths still perform all 61 date operations;
batching does not deduplicate expressions or combine date arithmetic.

These scalar imports are in-process Wasmtime calls, not WebView IPC or network
requests. Saving crossings has to repay the extra plan/copy/validation/result
work. With Pulley, the additional guest code runs in the interpreter while
the host's date helpers remain native. That explains why reducing imports
alone is a poor predictor of speed. The implementation differences support
these explanations, but the experiment did not separately profile their costs.

The mixed workload builds the same guest plan on both paths and showed a small
batch gain, about 4-5% native and 7% interpreter in later paired rounds. Its
broader work and copying pattern differ from template rendering. Profiling
and a template candidate that reuses parsed expressions would help test which
costs dominate; neither is established by the existing timings.

## Compatibility and adoption

Scalar APIs remain available. Legacy built components were tested against the
extended host, including the TypeScript component now retained as an example. A newly
built component importing `batch` requires a host that supplies that interface;
it cannot run on an older app merely because the scalar APIs exist. The SDK
and ABI are still private/pre-release. Before publishing a stable contract,
version the operation set and define capability/version discovery; future
changes to variant shapes are not automatically ABI-compatible.

The recovery fields extend the experimental failure record incompatibly with
the original batch-importing component. Rebuild those guests with the matching
WIT and host. The three Rust comparison artifacts are rebuilt together; the
historical benchmark files and their hashes remain unchanged. Scalar-only
components retain their original interfaces.

Use explicit batches for measured patterns with enough crossing/copy cost to
outweigh plan overhead. Keep simple calls simple. Preserve the baseline when
an optimization loses. The current general batching candidate is optional;
it does not replace shipped Templates. A purpose-built bulk operation or
per-call caching may be a better future experiment for a hot path, but neither
is implemented or claimed faster by this comparison.

New general-host API code can affect release binary/package sizes even if a
plugin does not call it. Matching app startup/memory/package measurements must
be repeated before this revision ships. Earlier package measurements do not
validate the new host additions.
No budgets were raised, and no untested platform is marked passed.
