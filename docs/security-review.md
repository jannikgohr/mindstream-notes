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

| ID                                                              | Severity                | Area            | Short                                                         |
| --------------------------------------------------------------- | ----------------------- | --------------- | ------------------------------------------------------------- |
| [H1](#h1--webview-csp-is-disabled)                              | High                    | Tauri client    | `csp: null` disables CSP app-wide                             |
| [H2](#h2--asset-scheme-reflects-a-remote-controlled-mime-type)  | High                    | Tauri client    | Remote-controlled `Content-Type` on `mindstream://`           |
| [H3](#h3--the-collab-relay-is-unauthenticated)                  | ~~High~~ **Fixed**      | Backend         | Anyone may join/publish to any relay room                     |
| [M1](#m1--presence-and-sync-request-frames-are-unsigned)        | Medium                  | Collab protocol | Only document updates require a signature                     |
| [M2](#m2--signature-enforcement-fails-open-when-auth-is-absent) | Medium                  | Collab protocol | Missing `auth` silently disables the signed-frame requirement |
| [M3](#m3--personal-rooms-reuse-the-item-uid-and-item-key)       | Medium _(partly fixed)_ | Collab protocol | Unscoped rooms reuse the item key as the wire key             |
| [M4](#m4--writer-key-username-binding-is-self-asserted)         | Medium                  | Sharing         | A writer can publish a signing key under another's username   |
| [M5](#m5--share-manifest-provenance-is-not-verified)            | Medium                  | Sharing         | First manifest matching a scope id wins, regardless of author |
| [M6](#m6--no-rate-limiting-in-front-of-etebase-auth)            | Medium                  | Backend         | Login endpoint is unthrottled; `X-Forwarded-For` is spoofable |
| [L1](#l1--no-replay-protection-within-an-epoch)                 | Low                     | Collab protocol | Signed frames carry no nonce, counter, or timestamp           |
| [L2](#l2--auth-refresh-can-be-triggered-by-any-key-holder)      | Low                     | Collab protocol | Self-signed frame forces a manifest re-fetch                  |
| [L3](#l3--x-forwarded-proto-is-trusted-unconditionally)         | Low                     | Backend         | Client can dictate the scheme Django sees                     |
| [L4](#l4--container-and-image-hardening)                        | Low                     | Backend         | No `cap_drop`/`no-new-privileges`; image pinned by tag        |
| [L5](#l5--random-96-bit-ivs-under-a-long-lived-key)             | Low                     | Collab protocol | Birthday bound on IV collision                                |
| [L6](#l6--collab-logging-is-verbose-in-production)              | Low                     | Client          | Key fingerprint and frame metadata logged unconditionally     |

---

## High

### H1 — Webview CSP is disabled

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

**Suggested:** set a real CSP. A restrictive starting point:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: mindstream:; connect-src 'self' https: wss:;
object-src 'none'; frame-ancestors 'none'`. Expect to iterate — pdf.js and
Excalidraw both tend to need `blob:` and `worker-src`.

### H2 — Asset scheme reflects a remote-controlled MIME type

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

**Suggested, in order of value:**

1. Allowlist `mime_type` on ingest _and_ on serve — map anything unrecognised
   to `application/octet-stream`. The app only needs a handful of image types
   plus `application/pdf`.
2. Add `X-Content-Type-Options: nosniff` and
   `Content-Disposition: attachment` for non-image types.
3. Drop `Access-Control-Allow-Origin: *`, or narrow it to the app origin.

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

**Suggested:** require signatures on awareness too, and either sign
`sync_step_1` or rate-limit the reply per peer. If read-only members must be
able to announce presence, give them a distinct viewer key so peers can render
them as viewers rather than trusting a self-declared identity.

### M2 — Signature enforcement fails open when `auth` is absent

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

**Suggested:** make the distinction explicit in the type rather than inferring
it from absence — e.g. `auth: { kind: "unshared" } | { kind: "scoped", … }` —
so a scoped room with unresolved authorization is a distinguishable state that
rejects rather than a missing one that permits.

### M3 — Personal rooms reuse the item UID and item key

> **Half fixed.** The room id is no longer the Etebase item UID — every room,
> scoped or not, is now named after a derived P-256 public key. The wire key is
> still the raw item key; that half is open.

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

**Still suggested:** derive the AES-GCM wire key for the unscoped path through
HKDF with its own info string, instead of handing the raw Etebase item key to
the webview. There is no reason the personal path should be weaker than the
shared one.

### M4 — Writer-key username binding is self-asserted

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

**Suggested:** verify the manifest collection's owner matches the scope owner
recorded locally at accept time, and treat more than one match for a
`share_scope_id` as an error rather than picking one.

### M6 — No rate limiting in front of Etebase auth

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

**Suggested:** add `limit_req` on the auth paths specifically and a global
`limit_conn`. Either strip a client-supplied `X-Forwarded-For` at the edge
(`proxy_set_header X-Forwarded-For $remote_addr`) or configure `real_ip` with an
explicit trusted-proxy list. Add the standard security headers.

---

## Low

### L1 — No replay protection within an epoch

Signed frames bind `roomId` and `collabEpoch`
([`signed-collab-frame.ts:267-274`](../src/lib/sync/signed-collab-frame.ts)) but
carry no nonce, sequence number, or timestamp. Any captured frame stays valid
for the life of its epoch and can be replayed by the relay operator or any room
peer. Epoch rotation on downgrade bounds this across epochs, but within one it
is unbounded. Impact is limited because Yjs updates are idempotent — replaying a
document update is a no-op. Replayed _awareness_ frames are more interesting,
and they are unsigned anyway ([M1](#m1--presence-and-sync-request-frames-are-unsigned)).

### L2 — Auth refresh can be triggered by any key holder

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

The `$forwarded_proto` map ([`nginx.conf:16-19`](../backend/nginx/nginx.conf))
falls back to `$scheme` only when the header is absent — a client that sends
`X-Forwarded-Proto: https` has it honoured with no trusted-proxy check. This
feeds Django's `CSRF_TRUSTED_ORIGINS`. The stack is documented as sitting behind
a TLS terminator that overwrites the header, so this only bites if nginx is ever
reachable directly. Worth a `real_ip_from` / trusted-proxy guard anyway.

### L4 — Container and image hardening

`docker-compose.yml` sets no `read_only`, `cap_drop: [ALL]`, or
`security_opt: [no-new-privileges:true]` on any service. `victorrds/etebase` is
pinned by tag (`0.14.2-alpine`) rather than digest, so the image contents can
change under a fixed tag. The log-size caps and the `POSTGRES_PASSWORD:?` required-
variable guard are good practice already present; this is the remaining gap.

### L5 — Random 96-bit IVs under a long-lived key

`encodeCollabFrame` draws a fresh random 12-byte IV per frame
([`signed-collab-frame.ts:250`](../src/lib/sync/signed-collab-frame.ts)) under a
per-note key that lives as long as the epoch. Random 96-bit IVs hit a ~2^-32
collision probability around 2^32 frames, and GCM nonce reuse is catastrophic
(it leaks the authentication key). Live collab emits a frame per edit burst, so
reaching that is implausible in practice — noted for completeness. A
deterministic counter-based IV would remove the concern entirely.

### L6 — Collab logging is verbose in production

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

## Suggested order of work

1. [H2](#h2--asset-scheme-reflects-a-remote-controlled-mime-type) — smallest
   change with the largest risk reduction; a MIME allowlist plus `nosniff` is
   contained and testable.
2. [H1](#h1--webview-csp-is-disabled) — more iteration, since pdf.js and
   Excalidraw will need accommodating, but it is the control that caps
   everything else on the client.
3. [M1](#m1--presence-and-sync-request-frames-are-unsigned) and
   [M2](#m2--signature-enforcement-fails-open-when-auth-is-absent) — both sit in
   code being actively changed on this branch, so they are cheapest to fix now.
4. ~~[H3](#h3--the-collab-relay-is-unauthenticated)~~ (done) and
   [M6](#m6--no-rate-limiting-in-front-of-etebase-auth) — backend changes,
   independent of the client work.
5. [M3](#m3--personal-rooms-reuse-the-item-uid-and-item-key),
   [M4](#m4--writer-key-username-binding-is-self-asserted),
   [M5](#m5--share-manifest-provenance-is-not-verified) — design-level, worth
   thinking through together since all three are about binding cryptographic
   material to an attested identity.
