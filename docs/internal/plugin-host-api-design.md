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

The contract plugin authors build against, with its limits, failure phases,
recovery and an example, is in [Batching host calls](../plugin-batch-api.md).
The sections below cover why it is shaped that way.

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
