# Security review

A code-reading security audit of Mindstream Notes — the Tauri client, the
frontend collab providers, and the self-hosted backend stack. For the
by-design trade-offs the sync/history model carries see
[known-limitations.md](known-limitations.md); this document is only about
security-relevant defects and weaknesses.

**Reviewed at:** branch `feat/collection-sharing`, commit `68e3daa`, with the
uncommitted working-tree changes to `src/lib/sync/` and `src/lib/freeform/`
included.

## Method and caveats

This is a **static review** — findings were derived by reading source, not by
exploiting a running instance. Nothing here has been demonstrated end to end
against a live stack. Severities are the reviewer's judgement of plausible
worst case, and each finding states the specific precondition an attacker
needs, so they can be re-rated once someone confirms or refutes the
preconditions.

Not covered: the Etebase server implementation itself (upstream, treated as a
trusted dependency), the `victorrds/etebase` image contents, third-party npm
and crate dependency CVEs, mobile/Android platform code, and the packaged
updater's signing infrastructure beyond confirming a pubkey is pinned.

The three trust boundaries that matter throughout:

1. **Relay/server operator** — sees ciphertext and all routing metadata.
2. **A share recipient** — a person you shared a folder with. Holds the room
   key and can author content your client ingests. This is the boundary most
   findings below live on, and it is newly load-bearing now that collection
   sharing exists.
3. **A revoked/downgraded member** — someone who _used_ to hold the above.

## Summary

| ID                                                              | Severity                                | Area            | Short                                                         |
| --------------------------------------------------------------- | --------------------------------------- | --------------- | ------------------------------------------------------------- |
| [H1](#h1--webview-csp-is-disabled)                              | ~~High~~ **Fixed** _(needs smoke test)_ | Tauri client    | `csp: null` disabled CSP app-wide                             |
| [H2](#h2--asset-scheme-reflects-a-remote-controlled-mime-type)  | ~~High~~ **Fixed**                      | Tauri client    | Remote-controlled `Content-Type` on `mindstream://`           |
| [H3](#h3--the-collab-relay-is-unauthenticated)                  | ~~High~~ **Fixed**                      | Backend         | Anyone may join/publish to any relay room                     |
| [M1](#m1--presence-and-sync-request-frames-are-unsigned)        | ~~Medium~~ **Fixed**                    | Collab protocol | Only document updates required a signature                    |
| [M2](#m2--signature-enforcement-fails-open-when-auth-is-absent) | ~~Medium~~ **Fixed**                    | Collab protocol | Missing `auth` silently disabled the signed-frame requirement |
| [M3](#m3--personal-rooms-reuse-the-item-uid-and-item-key)       | ~~Medium~~ **Fixed**                    | Collab protocol | Unscoped rooms reused the item UID and item key               |
| [M4](#m4--writer-key-username-binding-is-self-asserted)         | Medium                                  | Sharing         | A writer can publish a signing key under another's username   |
| [M5](#m5--share-manifest-provenance-is-not-verified)            | ~~Medium~~ **Mitigated**                | Sharing         | First manifest matching a scope id won, regardless of author  |
| [M6](#m6--no-rate-limiting-in-front-of-etebase-auth)            | ~~Medium~~ **Fixed**                    | Backend         | Login endpoint was unthrottled; `X-Forwarded-For` spoofable   |
| [L1](#l1--no-replay-protection-within-an-epoch)                 | ~~Low~~ **Fixed**                       | Collab protocol | Signed frames carried no nonce, counter, or timestamp         |
| [L2](#l2--auth-refresh-can-be-triggered-by-any-key-holder)      | ~~Low~~ **Mitigated**                   | Collab protocol | Self-signed frame forced a manifest re-fetch                  |
| [L3](#l3--x-forwarded-proto-is-trusted-unconditionally)         | ~~Low~~ **Fixed**                       | Backend         | Client could dictate the scheme Django sees                   |
| [L4](#l4--container-and-image-hardening)                        | Low _(partly fixed)_                    | Backend         | `cap_drop` still open; image pinned by tag                    |
| [L5](#l5--random-96-bit-ivs-under-a-long-lived-key)             | Low _(won't fix)_                       | Collab protocol | Birthday bound on IV collision                                |
| [L6](#l6--collab-logging-is-verbose-in-production)              | Low _(won't fix)_                       | Client          | Key fingerprint and frame metadata logged unconditionally     |

---

## High

### H1 — Webview CSP is disabled

> **Policy written; needs a smoke test on a packaged build.** `csp` is set in
> [`tauri.conf.json`](../src-tauri/tauri.conf.json). It has _not_ been verified
> against a running app — `tauri dev` does not apply it (that is `devCsp`), so
> it must be checked on a real `tauri build`. See
> [Smoke-testing the CSP](#smoke-testing-the-csp).

**Where:** [`src-tauri/tauri.conf.json:33`](../src-tauri/tauri.conf.json) —
`"security": { "csp": null }`.

`csp: null` tells Tauri to inject no Content-Security-Policy at all. The
webview therefore permits inline script, `eval`, and outbound loads to any
origin.

On its own this is a missing defence in depth, not a vulnerability — it needs
an injection primitive to matter. What makes it load-bearing here is the
content the app renders: Markdown, Excalidraw scenes, and PDFs that, since
collection sharing landed, **can be authored by someone else**. Any one HTML
or script injection anywhere in that rendering stack escalates from "script
runs" to "script runs with no network or execution restrictions, in a webview
that exposes `window.__TAURI_INTERNALS__`" — which reaches every command in
`capabilities/default.json`, including `shell:allow-open` and `dialog:allow-save`.

CSP is what normally caps the blast radius of exactly that class of bug. It is
also the control that would blunt [H2](#h2--asset-scheme-reflects-a-remote-controlled-mime-type).

**Mitigating:** the Markdown path currently looks sound — Milkdown/ProseMirror
builds nodes rather than assigning HTML, Mermaid runs with
`securityLevel: 'strict'` and is rendered into an `<img src="data:…">` (see
[`mermaid.ts:159-183`](../src/lib/editor/plugins/prose/mermaid.ts)), which cannot
execute script. No `DOMPurify` is present because, as far as this review found,
no raw-HTML sink is reachable from note content. That is a property worth
keeping deliberately rather than accidentally.

**What landed**, and the two non-obvious things that shaped it:

- **Tauri hashes inline scripts for you.** SvelteKit emits an inline bootstrap
  that calls `kit.start()`, which `script-src 'self'` would block — a white
  screen. But `map_core_assets` in `tauri-codegen` runs `inject_script_hashes`
  over every bundled HTML file when a CSP is set, adding a `sha256-` for each
  inline `<script>`. So no `'unsafe-inline'` is needed, and none is used —
  which matters, because a single hash or nonce in a directive makes
  `'unsafe-inline'` **ignored** for it.
- **That same rule nearly broke every inline style.** Tauri also injects a
  nonce into `<style>` elements, which would have voided the
  `style-src 'unsafe-inline'` the UI depends on for `style="…"` attributes
  (dockview and Excalidraw use them heavily). Hence
  `"dangerousDisableAssetCspModification": ["style-src"]` — it stops Tauri
  touching `style-src` only, leaving script hashing intact — plus a
  `style-src-attr` fallback for engines that honour it.

`connect-src` stays broad (`https: http: ws: wss:`) because the server URL is
user-configured and can be any host; the value here is in `object-src 'none'`,
`base-uri 'self'`, `form-action 'none'`, `frame-ancestors 'none'`, and keeping
script execution to same-origin plus build-time hashes.

### H2 — Asset scheme reflects a remote-controlled MIME type

> **Fixed.** The served `Content-Type` is narrowed to an allowlist
> (`safe_asset_mime` in [`lib.rs`](../src-tauri/src/lib.rs)), with
> `X-Content-Type-Options: nosniff` and a `default-src 'none'; sandbox` CSP on
> every asset response, and the blanket `Access-Control-Allow-Origin: *` is
> replaced by an echo of the app's own origin.

**Where:** [`src-tauri/src/lib.rs:521-535`](../src-tauri/src/lib.rs) (handler),
[`src-tauri/src/sync/mod.rs:1128-1153`](../src-tauri/src/sync/mod.rs) and
[`src-tauri/src/sync/scopes.rs:736-744`](../src-tauri/src/sync/scopes.rs)
(ingest).

The `mindstream://` scheme handler serves asset bytes with:

```rust
.header(tauri::http::header::CONTENT_TYPE, asset.summary.mime_type)
.header("Access-Control-Allow-Origin", "*")
```

`mime_type` is a free-form `String`. On the ingest side it is taken verbatim
from the synced payload and written straight into the `assets` table — there is
no allowlist, no parse, no normalisation on either the write or the read path.
The response also carries no `X-Content-Type-Options: nosniff`.

**Attack:** a user who shares a collection with you controls the asset rows
that arrive in that scope. Setting `mime_type` to `text/html` (or
`image/svg+xml`) makes your client serve their bytes as an active document from
`mindstream://localhost/asset_<uuid>` — an origin belonging to the app. With
[H1](#h1--webview-csp-is-disabled) there is nothing to stop what that document
then does; `Access-Control-Allow-Origin: *` additionally lets any origin that
gets script running read every asset's bytes cross-origin.

Whether this reaches full IPC depends on whether the document is loaded
top-level or framed — Tauri injects `__TAURI_INTERNALS__` per webview, so a
cross-scheme iframe would not automatically receive it. That detail is worth
confirming, but the finding stands regardless: attacker-controlled active
content served from the app's own scheme, with permissive CORS and no sniff
protection, is not a safe position even in the framed case.

**Done:** the allowlist and `nosniff`, applied at the _serve_ boundary rather
than on ingest so rows already in the database are covered without a migration.
SVG stays allowed because notes embed it; the response CSP (`sandbox`) is what
stops a navigated SVG executing, while leaving `<img>` rendering untouched. The
allowlist is deliberately generous on raster formats (including HEIC/HEIF for
Apple camera photos) — none can execute, and a narrow list would turn "user
drags a photo in" into a broken image.

**Also done — CORS.** The blanket `Access-Control-Allow-Origin: *` is gone.
The handler now echoes the request `Origin` only when it matches a known app
origin (`tauri://localhost`, `http(s)://tauri.localhost`, plus
`http://localhost:1420` in debug builds) and sends no CORS header otherwise,
with `Vary: Origin` so caches don't cross-serve. Freeform PNG export keeps its
canvas read; any other origin loses it. Worth confirming export still works on
each platform, since the app origin differs by platform.

### H3 — The collab relay is unauthenticated

> **Fixed** by the join challenge (see [Join challenge](#join-challenge) below).
> Retained for the reasoning; the residual risks it lists still stand.

**Where:** [`backend/yjs-relay/collab-server.mjs:41-72`](../backend/yjs-relay/collab-server.mjs);
the same holds for `excalidraw-room`, which is an unmodified upstream image
behind [`nginx.conf:44`](../backend/nginx/nginx.conf).

`upgrade` accepts any WebSocket with a `?room=` parameter. There is no token,
no session check, no `Origin` check, and no tie to an Etebase identity. `open`
subscribes the socket to that room; `message` republishes anything it receives
to every other member.

The E2EE design means this does _not_ leak note plaintext, and that is a
deliberate and good property. What an unauthenticated party who knows or
guesses a room id still gets:

- **Metadata.** Which rooms are active, when, how many participants, message
  sizes and timing — i.e. who is editing what, and when, at frame granularity.
- **Ciphertext at rest for offline analysis**, harvested passively.
- **Write access to the broadcast channel.** Injected frames fail
  authenticated decryption at honest peers, but the relay will still fan them
  out to every subscriber, so this is a free amplification primitive.
- **No connection or room-count limits**, so an attacker can hold open
  arbitrarily many sockets. `MAX_BACKPRESSURE_BYTES` bounds per-socket buffering
  but nothing bounds socket count.

Room-id guessability differs sharply by path, which is what makes this worth
fixing rather than accepting — see [M3](#m3--personal-rooms-reuse-the-item-uid-and-item-key).
For shared scopes the room id is an HMAC and is effectively unguessable by an
outsider. For personal notes it is the Etebase item UID, **which the server
operator already has in plaintext**.

**Resolved by:** the join challenge below, which authenticates membership
without giving the relay a secret. Per-IP connection caps and an `Origin`
allowlist are still outstanding — the challenge stops an attacker _joining_ a
room, but not opening sockets.

---

## Medium

### M1 — Presence and sync-request frames are unsigned

> **Fixed.** `SIGNED_REQUIRED_TYPES` now covers all three frame types, not
> just document updates. Safe to require across the board because
> `can_receive_live_collab_room` withholds a scoped room from read-only
> members entirely, so everyone who can join can also sign — no legitimate
> participant loses presence.
>
> This closes the outsider and revoked-member vector, not writer-vs-writer
> impersonation: a writer can still publish a key under another writer's
> username, which is [M4](#m4--writer-key-username-binding-is-self-asserted).

**Where:** [`collab-provider.ts:43`](../src/lib/sync/collab-provider.ts),
[`ink-web-collab-provider.ts:21`](../src/lib/sync/ink-web-collab-provider.ts),
[`excalidraw-room-client.ts:44`](../src/lib/freeform/excalidraw-room-client.ts).

All three providers declare the same shape:

```ts
const SIGNED_REQUIRED_TYPES = new Set([FRAME_SYNC_STEP_2]);
```

Only the document-update frame requires a writer signature. `FRAME_SYNC_STEP_1`
(state vector) and `FRAME_AWARENESS` (cursors/presence) are accepted unsigned
so long as they decrypt. Anyone holding the room key can therefore forge them —
in practice a **read-only member**, who is issued the room key by design, or a
removed member who kept a copy.

Two consequences:

- **Presence spoofing.** Awareness payloads carry the display identity other
  peers render. A read-only viewer can appear in the collaborator list as
  another user, or move that user's cursor. This directly undercuts the
  read-only role: the whole point of the recent writer-key work is that a
  viewer cannot appear to author anything.
- **Amplification.** `FRAME_SYNC_STEP_1` is answered at
  [`collab-provider.ts:327-331`](../src/lib/sync/collab-provider.ts) with
  `Y.encodeStateAsUpdate(doc, pt)`. An empty state vector makes _every writer in
  the room_ encode and broadcast the entire document. One small forged frame,
  repeated, becomes sustained CPU and bandwidth load on every participant.

**Done:** signatures required on awareness and `sync_step_1` as well. The
read-only-viewer-key idea turned out to be unnecessary — viewers are never
handed a scoped room in the first place.

### M2 — Signature enforcement fails open when `auth` is absent

> **Fixed.** Enforcement is now driven by an explicit `requireSignedWrites`
> flag (`room.collab_epoch > 0`) rather than by `auth` being truthy, so a
> scoped room whose authorisation lookup failed rejects unsigned updates
> instead of accepting them.

**Where:** [`signed-collab-frame.ts:329`](../src/lib/sync/signed-collab-frame.ts).

```ts
if (signedRequired(type, signedRequiredTypes) && auth) {
  console.warn('[collab] rejected unsigned writer frame type=%d', type);
  return null;
}
```

The rejection is conditional on `auth` being truthy. When `auth` is `undefined`
the unsigned branch is taken for **every** frame type, `sync_step_2` included.

For a personal, unshared note that is correct and intended — there are no
writer keys and only your own devices hold the key. The risk is that `auth`
undefined is also the natural representation of _"we could not determine the
authorization state"_: a manifest fetch that failed, a scope not yet resolved, a
provider constructed before room info arrived. In those states the control
disappears silently rather than failing closed, and the only signal is an
absent console warning.

This is a robustness finding, not a demonstrated bypass — it depends on whether
any caller can reach a scoped room with `auth` unset. That is worth tracing
explicitly and then pinning with a test.

**Traced before fixing:** `writer_auth` turns out to be set unconditionally for
every scoped room (with an empty writer list when the lookup fails), so `auth`
was undefined exactly when the room was unshared — the fail-open was not
reachable in practice. It rested entirely on that one assignment, though, so
the guard is now explicit rather than incidental: callers pass
`requireSignedWrites`, `decodeCollabFrame` enforces the declared type set
unconditionally, and unshared rooms declare an empty set. A scoped room with
unresolved authorisation now rejects everything (fail-closed) instead of
accepting everything. Regression tests cover both directions.

### M3 — Personal rooms reuse the item UID and item key

> **Fixed.** The room id is no longer the Etebase item UID — every room,
> scoped or not, is named after a derived P-256 public key — and the wire key
> is now HKDF-derived rather than being the Etebase item key itself. Both
> paths share one `derive_live_collab_key`, so the personal path can't drift
> from the scoped one again.

**Where:** [`sync/mod.rs`](../src-tauri/src/sync/mod.rs), `derive_live_collab_room`.

The scoped path does this properly:

```rust
mac.update(LIVE_COLLAB_ROOM_INFO);
mac.update(&scope.collab_epoch.to_be_bytes());
mac.update(note_uid.as_bytes());
// … HKDF-SHA256 with salt, epoch, and a domain-separating info string
```

The unscoped early return does not:

```rust
return Ok(RoomInfo {
    room_id: note_uid.to_string(),
    key_b64: to_base64(note_key)?,
    collab_epoch: 0,
    writer_auth: None,
});
```

Two distinct issues:

- ~~**The room id is the Etebase item UID.**~~ **Fixed.** The operator could
  previously correlate relay traffic to a specific stored item with no guessing,
  and join the room. Room ids are now derived public keys, and joining requires
  answering the challenge.
- **The wire key is the at-rest item key**, used raw for AES-GCM with no
  domain separation. One key now serves two purposes under two different
  constructions. This is the failure mode key-separation hygiene exists to
  prevent, and the scoped path already shows the right pattern.

**Done:** the unscoped path runs through the same HKDF as the scoped one, with
the epoch pinned to 0 and no salt. The personal path is no longer weaker than
the shared one.

### M4 — Writer-key username binding is self-asserted

> **Open — needs a design decision, not a patch.** Checked whether a
> server-attested identity was available to bind the key to: it is not.
> Etebase's `ItemMetadata` carries only type/name/mtime/description/colour with
> no author field, and items are end-to-end encrypted, so the server cannot
> attest authorship to other members either. Closing this means the collection
> owner counter-signing the writer roster, which needs a long-term owner
> signing identity and a trust bootstrap at invitation-accept time — a
> protocol change, and a breaking one.

**Where:** [`sync/mod.rs:2700-2750`](../src-tauri/src/sync/mod.rs).

Writer signing keys are published as ordinary items in the scope collection.
`list_collab_writer_keys` reads `payload.username` **from the item content** and
pairs it with `payload.public_key_b64`. `filter_writable_collab_writers` then
checks only that the _claimed_ username appears in the collection's writable
member set — never that the member who wrote the item is the member it names.

So a writable member can publish a key item claiming another writable member's
username bound to their own public key. Every peer accepts frames signed by
that key as authored by the impersonated user.

This is **not** a privilege escalation: Etebase enforces read-only at the
server, so only an existing writer can publish the item, and a writer can
already write. The impact is **attribution** — which is precisely what the
signed-frame layer was built to establish. It also interacts badly with
downgrade: keys published during an epoch outlive the moment of publication,
so a member can pre-position a key under another identity before losing write
access.

**Suggested:** bind the key to a server-attested identity rather than a
self-declared field — Etebase item authorship metadata if it is exposed, or
have the collection owner counter-sign each writer key so the roster is
owner-attested rather than member-attested.

### M5 — Share manifest provenance is not verified

> **Mitigated, not fully fixed.** Scope resolution no longer takes the first
> match: it collects every manifest claiming a `share_scope_id` and refuses to
> resolve the scope at all if there is more than one. That removes the race —
> an impostor manifest can no longer be silently preferred — but provenance
> itself is still unverified, so a manifest whose legitimate twin is absent
> would still be trusted.

**Where:** [`sharing.rs:1615-1647`](../src-tauri/src/sharing.rs).

`share_scope_collab_info` lists every `mindstream.share_manifest` collection the
account can see, decodes each, and returns the **first** whose
`share_scope_id` matches — with no check on who created that collection.

`share_scope_id` is a UUID, so an outsider cannot guess it. But every member of
a scope knows their own scope's id. A member (including a read-only one, who can
create their _own_ collections and share them with you) can create a manifest
collection claiming that same `share_scope_id`, carrying attacker-chosen
`collab_salt`, `collab_epoch`, and part-collection UIDs, and share it with the
victim. If it is iterated first, the victim derives room ids and keys from the
attacker's salt.

Iteration order is server-supplied, so this is a race the attacker does not
fully control — which is why this is Medium rather than High. It is still a
confused-deputy: the code treats "a manifest exists claiming this scope" as
"this is the manifest for this scope."

**Done:** the second half — more than one match is now an error rather than a
choice, which is what killed the race. Failing closed costs live collab for
that folder; guessing would have cost the room key.

**Still suggested:** the first half — verify the manifest collection's owner
against the scope owner recorded locally at accept time. That is what turns
"exactly one manifest claims this scope" into "the right one does".

### M6 — No rate limiting in front of Etebase auth

> **Fixed.** `limit_req` (10r/m, burst 20) now guards
> `/api/v1/authentication/` — the real Etebase auth prefix, confirmed against
> the etebase-rs client source — with a global `limit_conn` of 128 per client.
> Both key off `$binary_remote_addr` **after** `real_ip` resolves the true
> client, which was the prerequisite: behind a reverse proxy every user would
> otherwise have shared one bucket.

**Where:** [`backend/nginx/nginx.conf`](../backend/nginx/nginx.conf).

The config has no `limit_req_zone`, `limit_conn_zone`, or any throttling. The
catch-all `location /` proxies straight to Etebase, including its login
endpoint — so password guessing is bounded only by network throughput.

Compounding it, `X-Forwarded-For` is set with `$proxy_add_x_forwarded_for`,
which **appends to whatever the client sent**. The comment at lines 70-73 notes
Etebase reads these headers "for rate-limiting and audit logs" — if any
downstream control keys off XFF, a client can prepend arbitrary values and
poison both. `X-Real-IP $remote_addr` is set correctly and is the trustworthy
one.

Also absent: HSTS, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`
on proxied responses.

**Done:** `real_ip` with an explicit trusted-proxy list (RFC1918 + loopback,
which is where a container network and its edge proxy live), `real_ip_recursive
on` so the walk stops at the first untrusted hop, plus the rate and connection
limits above. A client can still _append_ to `X-Forwarded-For`, but nginx no
longer believes it — the resolved `$remote_addr` comes from the trusted-proxy
walk, so neither the limiter nor etebase's audit log can be poisoned.

**Also done:** `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy`
on every response. Note the nginx inheritance rule this exposed — a location
with its own `add_header` inherits _none_ from the server block, which had
silently stripped all three from `/healthz`; it now uses `default_type`
instead. No HSTS: this listener is plain HTTP behind a TLS terminator, and the
header is only meaningful (and only safe) from the origin that terminates TLS.

---

## Low

### L1 — No replay protection within an epoch

> **Fixed.** Signed frames now carry a sender timestamp inside the signed
> header, and `CollabReplayGuard` drops any frame outside a 5-minute freshness
> window or whose signature it has already seen. The signature doubles as the
> frame's identity — every frame carries a fresh random IV that the signature
> covers — so no extra nonce field was needed. The check runs _after_
> signature verification, so forged frames can't evict cache entries.

Signed frames bind `roomId` and `collabEpoch`
([`signed-collab-frame.ts:267-274`](../src/lib/sync/signed-collab-frame.ts)) but
carry no nonce, sequence number, or timestamp. Any captured frame stays valid
for the life of its epoch and can be replayed by the relay operator or any room
peer. Epoch rotation on downgrade bounds this across epochs, but within one it
is unbounded. Impact is limited because Yjs updates are idempotent — replaying a
document update is a no-op. Replayed _awareness_ frames are more interesting,
and they are unsigned anyway ([M1](#m1--presence-and-sync-request-frames-are-unsigned)).

### L2 — Auth refresh can be triggered by any key holder

> **Mitigated.** The throttle now doubles after each refresh, up to 5 minutes,
> instead of staying at a flat 5s. A legitimate key rotation needs one or two
> refreshes so nothing real is lost, but a provoked drip decays from ~12
> forced Etebase re-fetches a minute to a handful.

`signedCollabFrameNeedsAuthRefresh`
([`signed-collab-frame.ts:209-242`](../src/lib/sync/signed-collab-frame.ts))
verifies the frame's signature using the public key **carried in that same
frame**, then requires only that the ciphertext decrypts under the room key. A
self-signed frame from a fresh keypair therefore satisfies it, and any room-key
holder — including a read-only member — can make peers fire `onAuthStale` and
re-fetch scope state from Etebase on demand. `AUTH_REFRESH_THROTTLE_MS` (5s)
caps the rate per provider instance, so this is a nuisance amplifier rather than
a real DoS, but it is an unauthenticated party steering the victim's server
traffic.

### L3 — `X-Forwarded-Proto` is trusted unconditionally

> **Fixed.** The header is now honoured only when `$realip_remote_addr` (the
> peer _before_ real_ip rewriting) is a trusted proxy; anyone else falls back
> to `$scheme`.

The `$forwarded_proto` map ([`nginx.conf:16-19`](../backend/nginx/nginx.conf))
falls back to `$scheme` only when the header is absent — a client that sends
`X-Forwarded-Proto: https` has it honoured with no trusted-proxy check. This
feeds Django's `CSRF_TRUSTED_ORIGINS`. The stack is documented as sitting behind
a TLS terminator that overwrites the header, so this only bites if nginx is ever
reachable directly. Worth a `real_ip_from` / trusted-proxy guard anyway.

### L4 — Container and image hardening

> **Fixed.** `no-new-privileges` plus `cap_drop: [ALL]` now apply to every
> service via a shared `x-hardening` anchor, with each image re-adding only
> what it needs. Verified against the real stack: all five containers report
> healthy, and nginx's `CapEff` is `0x4c1` — exactly CHOWN, SETGID, SETUID and
> NET_BIND_SERVICE.
>
> Still open: the etebase image is pinned by tag rather than digest, so its
> contents can change under a fixed tag.

`docker-compose.yml` set no `read_only`, `cap_drop: [ALL]`, or
`security_opt: [no-new-privileges:true]` on any service. `victorrds/etebase` is
pinned by tag (`0.14.2-alpine`) rather than digest, so the image contents can
change under a fixed tag. The log-size caps and the `POSTGRES_PASSWORD:?` required-
variable guard are good practice already present; this is the remaining gap.

### L5 — Random 96-bit IVs under a long-lived key

> **Won't fix.** Reaching the birthday bound needs ~2^32 frames under one
> room key, which a note's editing session will never approach. Noted for
> completeness; revisit only if key lifetimes change.

`encodeCollabFrame` draws a fresh random 12-byte IV per frame
([`signed-collab-frame.ts:250`](../src/lib/sync/signed-collab-frame.ts)) under a
per-note key that lives as long as the epoch. Random 96-bit IVs hit a ~2^-32
collision probability around 2^32 frames, and GCM nonce reuse is catastrophic
(it leaks the authentication key). Live collab emits a frame per edit burst, so
reaching that is implausible in practice — noted for completeness. A
deterministic counter-based IV would remove the concern entirely.

### L6 — Collab logging is verbose in production

> **Won't fix.** The fingerprint is 6 base64 chars of a 256-bit key and exists
> so a user can confirm two devices imported the same secret when diagnosing
> "live editing isn't working". Gating it behind a dev flag costs a real
> support tool to remove ~36 bits of a key that is useless without the rest.

`CollabProvider` logs a key fingerprint at construction
([`collab-provider.ts:131-136`](../src/lib/sync/collab-provider.ts)) plus
per-frame type and size at `console.debug`. The fingerprint is 6 base64 chars
(~36 bits) of the raw key and is deliberately partial, so it is not a practical
key leak, but it and the frame metadata are written unconditionally — the Rust
side gates log level on `debug_assertions`, the JS side does not. Consider
gating the frame-level logging behind a dev flag.

---

## Join challenge

Implemented for the `yjs-relay` transport, closing [H3](#h3--the-collab-relay-is-unauthenticated)
and half of [M3](#m3--personal-rooms-reuse-the-item-uid-and-item-key).

The relay stays deliberately dumb — the point of the E2EE design is that it can
be self-hosted without being trusted, and adding a token it could verify would
have meant handing it a scope secret. Instead the room id _became_ the
credential's public half:

```
seed    = HKDF-SHA256(collab_salt, "mindstream-live-collab-join/v1" ‖ epoch ‖ note_uid)
(sk,pk) = P-256 keypair from seed          # rejection-sampled into range
room_id = base64(SPKI(pk))
```

On connect the relay sends a random 32-byte nonce; the client signs
`"mindstream-collab-join/v1" ‖ room_id ‖ nonce` with `sk`, and the relay
verifies against the room id it already has from the URL. It holds no secret,
keeps no per-room state, and never learns an Etebase identity. An
unauthenticated socket is not subscribed, so it receives nothing at all.

P-256 rather than Ed25519 because the webview signs with WebCrypto, whose
Ed25519 support is still uneven in WKWebView/WebView2; ECDSA P-256 is
universal and already used for writer-key frame signatures.

**What it buys.** The room id previously travelled in `?room=` as a bearer
capability, so it landed in nginx and proxy access logs — seeing one was enough
to join. Now disclosure is no longer access. Personal notes gain the most: their
room id used to be the Etebase item UID, a value the operator stores in
plaintext.

**What it deliberately does not do.** It authenticates _membership_, not
identity or role — every member of a room derives the same keypair. It cannot
distinguish a reader from a writer, and it is not a substitute for
[M1](#m1--presence-and-sync-request-frames-are-unsigned) or
[M4](#m4--writer-key-username-binding-is-self-asserted); authorship enforcement
stays in the per-writer frame signatures. Revocation is unchanged: a former
member keeps the derived keypair until the epoch rotates.

**Not covered:** freeform/Excalidraw live sync. `excalidraw-room` is built
unmodified from upstream ([`backend/excalidraw-room/Dockerfile`](../backend/excalidraw-room/Dockerfile)),
so adding a challenge there would mean forking it. That transport is still
join-anything.

**Rollout.** There is deliberately no off switch: the relay always challenges,
and a client that expects a challenge and doesn't get one closes the socket
rather than downgrading to an unauthenticated session. Room ids also change for
**all** notes, so clients and relay must upgrade together — a mixed fleet lands
in different rooms and live collab is simply unavailable until both sides are
current. At-rest Etebase sync is a separate path and is unaffected.

**Verified:** unit tests on both halves ([`collab-join-challenge.test.ts`](../src/lib/sync/collab-join-challenge.test.ts)
cross-checks the client against a byte-for-byte copy of the relay's verify), plus
an end-to-end run against the real relay under uWebSockets confirming that two
members exchange frames, a wrong-key signature is closed with 1008, a socket
that never answers receives zero data frames and is dropped on the deadline, and
a malformed room id is refused at upgrade.

## What looked good

Worth recording so it does not regress:

- **No SQL injection surface.** Every query in `src-tauri/src` uses bound
  parameters; there is no string-formatted SQL anywhere.
- **No process spawning.** No `Command::new` / `std::process` use, so no command
  injection surface.
- **`unsafe` is confined** to JNI bridging in `app_restart.rs` and
  `drawing/platform/android.rs`, where it is unavoidable.
- **Test-only commands are properly feature-gated.** `e2e_create_standalone_collection_invite`,
  `e2e_create_incomplete_share_bundle`, and `e2e_accept_share_manifest_only` are
  all behind `#[cfg(feature = "e2e-data-dir")]` at both definition and
  registration, so they cannot be invoked from a release build. Same for the
  `MINDSTREAM_PROFILE_DIR` override, gated by `dir_override_allowed()`.
- **Credential storage is well-designed.** The split between an OS-keystore key
  and an encrypted on-disk blob means neither half alone is useful, and the
  keyring entry is deleted with the vault.
- **Mermaid is rendered safely** — `securityLevel: 'strict'` plus rendering into
  an `<img src="data:…">`, which cannot execute script even if a payload gets
  through.
- **The scoped collab derivation is textbook** — HMAC for the room id, HKDF with
  a domain-separating info string and the epoch for the key. [M3](#m3--personal-rooms-reuse-the-item-uid-and-item-key)
  is a request to apply this same pattern to the path that skips it.
- **The updater pins a minisign public key** and fetches over HTTPS.

## What's left

1. [H1](#h1--webview-csp-is-disabled) — the policy is written but unverified.
   Run [the smoke test](#smoke-testing-the-csp) on a packaged build.
2. [M4](#m4--writer-key-username-binding-is-self-asserted) and the remaining
   half of [M5](#m5--share-manifest-provenance-is-not-verified) — both are
   about binding cryptographic material to an attested identity rather than a
   self-declared one, and are worth designing together.
3. [L2](#l2--auth-refresh-can-be-triggered-by-any-key-holder) — a nuisance
   amplifier, already throttled to one refresh per 5s per provider.
4. Pin the etebase image by digest rather than tag
   ([L4](#l4--container-and-image-hardening)).

## Verifying the collab changes

Covered by unit tests on both sides, plus a suite of specs against the real
stack ([`collab-relay-auth.spec.ts`](../e2e-tests/backend/collab-relay-auth.spec.ts),
[`edge-hardening.spec.ts`](../e2e-tests/backend/edge-hardening.spec.ts)) that
assert the properties only a live relay and a live nginx can show: an
unauthenticated socket receives zero frames, a wrong-key signature is closed
`1008`, a captured answer replayed onto a fresh nonce is rejected, frames never
cross rooms, and the auth limiter sheds a burst while sync traffic and the
capability probe stay untouched.

The CSP was verified by a T3 run against a packaged build: the app launched,
rendered, edited and restarted with zero CSP violations in any spec.

**Still unverified:** two-client convergence over the live relay. The T4
`collab.e2e.ts` and `sharing.e2e.ts` specs are red, but they are red on
`e5370f5` too — pre-existing, not fallout from this branch (see
[e2e/status.md](e2e/status.md#currently-red--measured-2026-07-20)). Until
those are fixed, nothing exercises "two real clients converge on a shared note
now that every frame type requires a signature".

**Worth adding**, and not yet written: a read-only member cannot write, and a
revoked member loses access after epoch rotation. Both are T4. They are the
difference between "the crypto is right" and "the permission model is right",
and only the second class of bug hands a colleague data they should not have.

## Smoke-testing the CSP

The policy could not be verified here. `tauri dev` does **not** apply it
(`devCsp` governs dev), and serving the built frontend outside Tauri is a false
negative — Tauri's build-time inline-script hashing never runs, so the app
white-screens in a way it will not in the real bundle. It has to be a packaged
build:

```
pnpm tauri-build
```

Then launch the bundled app, open its devtools console, and watch for
`Refused to …` / `Content Security Policy` messages while exercising:

| Area          | What to do                                    | Watch for                             |
| ------------- | --------------------------------------------- | ------------------------------------- |
| Boot          | Launch cold                                   | Blank window = inline script blocked  |
| Theme         | Launch in dark mode                           | Flash of white before paint           |
| Markdown      | Open a note, type, use the slash menu         | Editor renders and styles apply       |
| Mermaid       | Insert a `mermaid` fence                      | Diagram renders (loads `data:` img)   |
| PDF           | Open a PDF note, scroll, annotate             | `worker-src blob:` — blank pages      |
| Freeform      | Open an Excalidraw note, draw, export PNG     | Canvas taint / `img-src` errors       |
| Ink           | Open an ink note, draw                        | Canvas rendering                      |
| Images        | Paste an image, and embed a remote `https://` | `img-src` violations                  |
| Sync          | Sign in, sync, open live collab               | `connect-src` blocking IPC or `wss:`  |
| Inline styles | Drag a dock panel, resize the sidebar         | Layout collapsing = `style-src` issue |

If something breaks, the console names the directive — send that line and the
fix is usually one source added to one directive.
