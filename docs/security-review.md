# Security review — open items

What a security audit of Mindstream Notes found and has **not** yet resolved.
Fixed findings have been removed; `git log` on this file has the full original
audit and the reasoning behind each fix.

For the by-design trade-offs the sync/history model carries see
[known-limitations.md](known-limitations.md); for how the pieces fit together
see [architecture.md](architecture.md).

## Trust boundaries

The three that matter, and the ones every item below sits on:

1. **Relay/server operator** — sees ciphertext and all routing metadata.
2. **A share recipient** — holds the room key and can author content your
   client ingests.
3. **A revoked/downgraded member** — someone who _used_ to hold the above.

## Summary

| ID                                                      | Severity | Area    | Short                                                                |
| ------------------------------------------------------- | -------- | ------- | -------------------------------------------------------------------- |
| [M4](#m4--writer-key-username-binding-is-self-asserted) | Medium   | Sharing | A writer can publish a signing key under another's username          |
| [M5](#m5--share-manifest-provenance-is-not-verified)    | Medium   | Sharing | A manifest claiming a scope is trusted without checking who wrote it |
| [L4](#l4--etebase-image-is-pinned-by-tag)               | Low      | Backend | Image contents can change under a fixed tag                          |

Both Mediums are the same shape: cryptographic material bound to a
**self-declared** identity rather than an attested one. Worth designing
together.

---

## M4 — Writer-key username binding is self-asserted

**Where:** [`sync/mod.rs`](../src-tauri/src/sync/mod.rs),
`list_collab_writer_keys` / `filter_writable_collab_writers`.

Writer signing keys are published as ordinary items in the scope collection.
`list_collab_writer_keys` reads `payload.username` **from the item content** and
pairs it with `payload.public_key_b64`. `filter_writable_collab_writers` then
checks only that the _claimed_ username appears in the collection's writable
member set — never that the member who wrote the item is the member it names.

So a writable member can publish a key item claiming another writable member's
username bound to their own public key. Every peer accepts frames signed by that
key as authored by the impersonated user.

This is **not** a privilege escalation: Etebase enforces read-only at the
server, so only an existing writer can publish the item, and a writer can
already write. The impact is **attribution** — precisely what the signed-frame
layer was built to establish. It also interacts badly with downgrade: keys
published during an epoch outlive the moment of publication, so a member can
pre-position a key under another identity before losing write access.

**Why it is still open.** There is no server-attested identity to bind to.
Etebase's `ItemMetadata` carries only type/name/mtime/description/colour with no
author field, and items are end-to-end encrypted, so the server cannot attest
authorship to other members either.

**Suggested:** have the collection owner counter-sign each writer key, so the
roster is owner-attested rather than member-attested. That needs a long-term
owner signing identity and a trust bootstrap at invitation-accept time — a
protocol change, and a breaking one.

## M5 — Share manifest provenance is not verified

**Where:** [`sharing.rs`](../src-tauri/src/sharing.rs),
`share_scope_collab_info` / `select_scope_manifest`.

`share_scope_collab_info` lists every `mindstream.share_manifest` collection the
account can see and matches on `share_scope_id`, with no check on who created
that collection.

`share_scope_id` is a UUID, so an outsider cannot guess it. But every member of
a scope knows their own scope's id. A member (including a read-only one, who can
create their _own_ collections and share them with you) can create a manifest
collection claiming that same `share_scope_id`, carrying attacker-chosen
`collab_salt`, `collab_epoch`, and part-collection UIDs, and share it with the
victim — who would then derive room ids and keys from the attacker's salt.

**Partly mitigated.** Resolution no longer takes the first match: it collects
every manifest claiming a scope and refuses to resolve the scope at all if there
is more than one. That kills the race — an impostor manifest can no longer be
silently preferred — and failing closed costs live collab for that folder, where
guessing would have cost the room key.

**What is still open:** provenance itself. A manifest whose legitimate twin is
absent is still trusted. The code treats "exactly one manifest claims this
scope" as "the right one does".

**Suggested:** verify the manifest collection's owner against the scope owner
recorded locally at accept time.

## L4 — Etebase image is pinned by tag

**Where:** [`docker-compose.yml`](../backend/docker-compose.yml).

`victorrds/etebase` is pinned by tag (`0.14.2-alpine`) rather than by digest, so
the image contents can change under a fixed tag without the compose file
changing.

**Suggested:** pin by digest and bump deliberately.

---

## Unverified, which is its own risk

Nothing currently exercises **two real clients converging over the live relay**
now that every frame type requires a signature. The T4 `collab.e2e.ts` and
`sharing.e2e.ts` specs would cover it, but both are red — pre-existing, not
fallout from the security work; see
[e2e/status.md](e2e/status.md#currently-red--measured-2026-07-20).

The two tests most worth having are blocked behind that same repair:

- a **read-only member cannot write** to a shared collection
- a **revoked member loses access** once the epoch rotates

Both are T4. They are the difference between "the crypto is right" and "the
permission model is right", and only the second class of bug hands a colleague
data they should not have.

## Accepted, not fixed

- **Random 96-bit IVs under a long-lived room key.** Reaching the birthday bound
  needs ~2^32 frames under one key, which an editing session will never
  approach. Revisit only if key lifetimes change.
- **Collab logging includes a key fingerprint.** Six base64 chars of a 256-bit
  key, kept so a user can confirm two devices imported the same secret when
  diagnosing "live editing isn't working". Removing it costs a real support tool
  to withhold ~36 bits that are useless without the rest.
- **Relay traffic metadata is visible to the operator.** Frame timing and sizes
  reveal editing activity per room even though room ids are opaque and contents
  are ciphertext. Inherent to a relay you self-host.
