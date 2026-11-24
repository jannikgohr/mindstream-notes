# Plugin host API design

Which capabilities belong in the host and which in the plugin, the decided but
unbuilt note events, jobs and ink APIs, proposals for other capabilities, and
why the experimental batch interface is shaped the way it is. The batch
contract plugin authors build against is in
[Batching host calls](../plugin-batch-api.md).

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

The current Wasm API has no general HTTP, note-body, attachment, credential or
event API. Declared text-checker services, artifact downloads and native
services already have separate host mechanisms; they do not grant a Wasm guest
arbitrary networking. The existing `notes` interface returns metadata, while
note writes use validated effects.

Note events, background jobs, a first form of scoped HTTP, secret settings and
ink page access are decided, for handwriting recognition as their first user.
They are described under
[Note events, jobs and ink pages](#note-events-jobs-and-ink-pages) and are not
implemented yet. The rest of this table is still a proposal:

| Capability                                         | Useful for                                                         | Host contract to define                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded note queries and opt-in content reads      | Search, backlinks, transformations, summarizers                    | Filters, selected fields, pagination, revision IDs and separate grants for content access. Avoid returning every body by default.                     |
| Revision-checked bulk edit effects                 | Applying transformations across notes                              | Expected revisions, validation before writes, conflict results and explicit atomicity. Do not make generic host batching promise a vault transaction. |
| HTTP to manifest-declared destinations             | Service integrations, publishing and remote lookups                | The general form of the decided setting-origin requests: approved destinations, concurrency, and requests outside jobs.                               |
| Credential handles                                 | Authenticated service integrations                                 | Opaque references scoped to a plugin and destination, beyond the decided `secret` settings. No app account tokens or cookies.                         |
| Attachment handles and user-selected import/export | OCR of attachments, image processing, PDF tools and export formats | Explicit selection or vault grants, byte limits and streamed access where needed. No arbitrary filesystem paths.                                      |
| Capability and version discovery                   | Portable third-party plugins                                       | Supported interface versions and optional operations, distinct from the user's grants. A guest can choose a fallback before calling a missing import. |

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
LanguageTool/model servers remain possible. In the decided first form the
destination is the origin of a setting, and typing a LAN or plain-HTTP URL
into it is that opt-in. A read-and-network plugin can send granted note data
to those destinations; approval must make that clear.

The host must enforce destinations during DNS resolution and connection,
including IPv4/IPv6, redirects and DNS rebinding. Default to no automatic
redirects; any later redirect support must validate every hop and avoid
forwarding credentials across origins. Do not inherit app cookies, auth
headers, filesystem schemes or ambient proxy authority. Scope credential
handles to the approved destination and redact sensitive request details.
This needs backend enforcement rather than relying on WebView CORS.

Set explicit request/response byte caps, decompressed-body caps, concurrency
limits and connect/total timeouts. Requests must stop on cancellation, plugin
disable/remove and vault closure. Slow I/O goes through the decided job
contract, so the one-second guest budget does not expand and network waits
never hold a guest call open. Result delivery must recheck the plugin and
vault lifetime. Generic batching must not replay a non-idempotent POST; jobs
are delivered at least once, so a plugin may only queue requests that are
safe to repeat.
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

## Note events, jobs and ink pages

Decided on 2026-11-20 with handwriting recognition as the first user. Note
events are implemented; the rest is not yet. Every contract here is implemented in both hosts,
the Rust backend and `src/lib/plugins/browser-host.ts`, with mirrored tests,
so neither host gets a contract the other cannot meet. iOS is out of scope.

### Handwriting recognition is a plugin

Recognition needs a model server the user picks, so it is not core. The host
owns what needs authority or consistency: reading pages, rendering them,
storing recognized text, the search index, events, jobs and HTTP. The plugin
owns policy: when to recognize, the prompt, building the request and parsing
the reply. It ships as a bundled Rust plugin, "Handwriting recognition
(OpenAI-compatible)", off by default, in the desktop, Android and browser
apps. When a job runs, its `prepare` skips pages without strokes and pages
whose text matches their current strokes, whatever the event's origin, so the
note change its own write causes costs nothing. Two devices with an active
recognizer can both read a page edited on one of them before the first
result syncs; avoiding that is best effort, and the user documentation says
to turn recognition on in one place.

The cursor and job tables and the queue rules (claiming, backoff, dedupe,
limits) are in `storage-core`, which the browser also runs in its SQLite
worker, and so is settling. Only the loops that call plugins exist once per
host.

### Note events

A plugin subscribes with a contribution, which needs `notes.watch`:

```json
"noteEvents": [
  { "on": "note.changed", "export": "noteChanged", "noteKinds": ["ink"], "settleMs": 5000 }
]
```

- One event per note, carrying `noteId`, `kind` and `revision`. No content:
  knowing that a note changed and reading what is in it are separate grants.
  There is no local or sync origin, because the recognizer treats both alike.
- The host holds a note's events until nothing in it has changed for
  `settleMs`, then delivers one event for the latest revision. Editor saves
  and sync writes settle the same way.
- Delivery uses a durable cursor per plugin export and vault, in the vault's
  local database, and is at least once. Handlers must tolerate repeats.
  Triggers give each note row a change number and time on every content
  write, so no write path, sync included, can skip them. A migration numbers
  existing notes. The cursor only moves past notes whose event was delivered,
  so a note still settling holds it back. A handler that fails is logged and
  the cursor moves on.
- A new cursor starts at the beginning, so enabling a plugin delivers every
  existing note of its kinds. The cursor also stores a hash of the plugin's
  effective settings and starts over when they change, however they changed,
  so notes skipped while it was unconfigured are delivered again. Becoming
  the active recognizer will start it over the same way. Starting over gives
  the cursor a new generation, and a delivery already in flight cannot move
  the new cursor.
- Trashing or deleting a note sends no event.
- When a handler fails with `queue-full`, the cursor stays put and the event
  is delivered again once the queue has room. A large backlog is read in
  batches instead of being dropped.

### Background jobs

Slow work runs as host-owned jobs, so no guest call waits on the network.
A job has three exports:

1. An event or action handler queues the job with a payload of at most
   16 KiB, a dedupe key and the names of its two other exports.
2. When the job's turn comes, the host calls `prepare` with the payload. It
   returns the request and up to 64 KiB of context, or nothing to finish the
   job without a request. Building the request late keeps queued rows small
   and uses the note as it is when the job runs.
3. The host sends the request, then calls the continuation with the payload,
   the context and the response or error.

Rules:

- Jobs live in the vault's local SQLite, never sync and survive restarts. A
  request in flight when the app quits is sent again, which is one more reason
  queued requests must be safe to repeat.
- Queuing a job whose dedupe key is already waiting replaces the waiting job.
  A running job finishes; the host's own checks reject a result that went
  stale meanwhile.
- One job runs at a time per plugin.
- A job is done when its continuation returns. A guest error or trap in
  `prepare` or the continuation fails the job at once, with the error shown
  under Background work. A job left running when the app quit or the vault
  closed runs again when the vault next opens.
- The host retries network errors, 5xx, 408 and 429 after 1, 5 and 30
  minutes. The continuation is called once per attempt sequence, with the
  first response that is not retried or the error that ended the retries,
  and fails the job by returning an error. A job replayed after the app quit
  can reach its continuation again.
- Each plugin may have 10,000 jobs and 16 MiB of payload queued per vault.
  Failed jobs count toward the limit, and only the newest 100 failures are
  kept. Queuing past a limit fails with `queue-full`.
- Jobs pause while the vault is closed, while the Android app is in the
  background, and in any browser tab that does not own the vault. Running in
  Android's background scheduler is a separate integration.
- The host draws a "Background work" section in the plugin's settings with
  queued, running and failed counts, each failure's error, Retry, Dismiss and
  Cancel all. Background failures raise no toasts, except one for the first
  failure after a plugin setting changed, so a mistyped URL is noticed.

Disabling a plugin is the same as removing it for everything the host runs on
its behalf: the request in flight is aborted and its jobs and cursor are
deleted. Settings, plugin storage and permission grants are kept, as they are
today. Enabling it again starts a fresh cursor.

### HTTP from a setting's origin

The first form of scoped HTTP, the general contract above restricted to jobs
and to one kind of destination. It needs `network.settingOrigin`:

```json
"network": { "destinations": [{ "setting": "endpoint" }] }
```

- The destination setting must have `scope: "D"` and no default, so only
  the user of this device chooses where requests go, by typing the URL or
  restoring their own backup. A synced or shared vault cannot redirect
  requests, and plugins cannot write settings. Until it is set, requests
  fail with "server URL not set".
- A request has a method (`GET` or `POST`), a URL, `content-type` and
  `accept` headers, headers filled from one of the plugin's own settings
  (`{ "header": "authorization", "fromSetting": "apiKey", "prefix": "Bearer " }`),
  a UTF-8 body of at most 8 MiB and a timeout of at most 300 s. The body
  crosses the guest boundary as a string, inside the guest's memory limit.
- The response has a status, bounded headers and a body of at most 1 MiB.
  HTTP error statuses are responses. Destination, timeout, size and transport
  failures are distinct errors.
- The URL's origin must equal the named setting's origin when the request is
  sent, not when it was queued. Otherwise the job fails with "server URL
  changed".
- No redirects, no cookies, no app credentials.
- The check is on the origin only. Neither host restricts the addresses a
  name resolves to: the user picks the server, and LAN servers are the
  common case. The DNS and connection rules of the general proposal apply
  to manifest-declared destinations, not to this form.
- The native host sends requests with `reqwest`, for the reasons in
  [plugin host internals](plugin-host.md#design-notes). The browser host uses
  `fetch` and so is subject to CORS, mixed-content blocking and Chrome's Local
  Network Access prompt. It checks the URL's shape when it is entered, for
  example a plain-HTTP hostname from an HTTPS page, and its failures carry
  one hint covering the causes a page cannot tell apart. What works from the
  browser, per server setup, belongs in the user documentation.

### Secret settings

A new plugin setting type, available to every plugin:

- `type: "secret"` is valid only with `scope: "D"`, so it never syncs.
  Backups leave secret values out, unlike other device settings, and a
  restore ignores any it finds.
- The settings UI masks it, with show/hide and Clear. Removing a plugin
  deletes its secret values, though it keeps its other settings, because a
  removed plugin's settings have no UI to clear them from.
- Plugin calls receive only whether it is set, never the value. The host
  inserts it through `fromSetting` in a job request or through a text
  checker's `apiKeySetting`. LanguageTool's `api-key`, already device-scoped,
  switches to it without a migration.
- Values never appear in job rows, errors, logs or diagnostics. In the
  browser they sit in the origin's storage, where any script on that origin
  can read them.

### Ink pages and recognized text

Two permissions: `ink.read` and `ink.writeRecognizedText`.

- `ink.pages(note)` lists each page with its stroke signature, computed by the
  host, and its recognized entry, if any, and says whether this account may
  edit the note, so `prepare` can skip shared notes it could not write to.
- `ink.render-page(note, page)` returns PNG bytes drawn by one fixed recipe,
  strokes only, cropped to their bounds with 24 px padding, on white, at most
  1600 px per side, and the signature of the strokes it drew. The plugin
  stores text under that signature, not one from an earlier `ink.pages`. It
  sees the image; options wait for a second user.
- `ink.set-recognized-text(note, page, signature, text)` checks the signature
  in the transaction that writes. It fails with `stale` when the page's
  strokes no longer match, with `not-active-recognizer` for any plugin but
  the chosen one, and with `read-only` for a shared note this account may
  not edit.

Recognized text lives in the note's `ink:handwriting` map: page ID to text,
stroke signature and the plugin that wrote it. It syncs and stays outside
undo. The host prunes entries for pages that were deleted or have no strokes.

A recognizer is a plugin granted `ink.writeRecognizedText`. Each vault has
at most one active recognizer on each device; like plugin settings, the
choice does not sync. Settings → Search shows the choice, including none,
whenever a recognizer is enabled. Enabling a recognizer while none is
active makes it active. Disabling the active one clears the choice, and if
exactly one other recognizer is enabled it takes over.
`ink.is-active-recognizer()` lets `prepare` skip the request when the result
could not be stored. Recognized text stays in notes when a plugin is disabled
or removed, because it is note content.

The stroke decoder, renderer and signature are Rust in a crate both hosts
build, with tiny-skia and a PNG encoder, so both send the same image for the
same page. The TypeScript codec writes strokes, so a parity test keeps the
Rust decoder in step with it. The rendered image does not need to match the
editor canvas.

Search reuses the ink index in `notes.pdf_text`. Its staleness signature,
`ink_background_signature` in Rust and `backgroundSignature` in TypeScript,
also covers recognized pages, and a test in each language asserts the same
string. Rust cannot rebuild that text alone, because PDF background text comes
from pdf.js. A write clears the note's cached text through the existing
signature check, and the host emits `index-stale`, which wakes the
TypeScript sweep in either host, since the sweep otherwise runs only at
startup and after sync. Outdated text stays indexed until it is read again;
it still finds the note, and the sheet below marks it.

An open ink editor is not told about host writes. That is safe: ink saves
merge into the stored state rather than replace it, and the editor does not
show recognized text.

Ways to see and undo the state:

- The ink note menu gets "Recognized text", a read-only sheet with each page's
  text and whether it is current, outdated or not read yet.
- Settings → Search gets "Remove recognized text", which says how many notes
  it touches, deletes `ink:handwriting` from every ink note in the vault this
  account can edit as a synced edit, and clears this device's active
  recognizer so the text does not return until the user picks one again. It
  reports shared notes it could not edit. Another device with an active
  recognizer reads the pages again, including results it finishes offline,
  and the confirmation says so.

## Why fewer crossings can take longer

Host imports are in-process Wasmtime calls, not WebView IPC or network
requests, so a batch only pays off when the crossings it saves cost more than
building the plan, lowering it across the ABI, validating it and copying the
results back. On a physical Android device, date-heavy template rendering was
slower batched than scalar: p95 0.564 against 0.533 ms ahead-of-time compiled,
and 2.34 against 1.54 ms under the Pulley interpreter, where the extra guest
code is interpreted while the host's date helpers stay native. Both paths still
did all 61 date operations; batching does not deduplicate work. A mixed
workload gained 4–7%. Those timings predate the current failure record, so
repeat the app startup, memory and package size measurements before the batch
interface ships.
