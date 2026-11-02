# Security review — open items

What a security audit of Mindstream Notes found and has **not** yet resolved.
Nothing from that audit is open any more. `git log` on this file has the full
original audit and the reasoning behind each fix. The October 2026 test of the
sync server keeps its own list in
[pen-test-2026-10.md](pen-test-2026-10.md), including what is only mitigated there.

For the by-design trade-offs the sync/history model carries see
[limitations.md](limitations.md); for how the pieces fit together
see [architecture.md](architecture.md).

## Trust boundaries

The three that matter:

1. **Relay/server operator** — sees ciphertext and all routing metadata.
2. **A share recipient** — holds the room key and can author content your
   client ingests.
3. **A revoked/downgraded member** — someone who _used_ to hold the above.

## Closed

- **M4, writer keys bound to a self-declared username.** The writer-key registry
  is gone. The sync server authenticates each room socket from a ticket only a
  member can get, names the sender of every frame itself, and drops document
  changes from members who may only read.
- **M5, share manifest provenance not verified.** A shared folder is one
  collection now, so no manifest decides which room or collection a client uses.
  The manifest that remains names the folder at the top of the share, and a
  device believes it only for a folder that arrived through that share. See
  [server-design.md](server-design.md#sharing).
- **L4, Etebase image pinned by tag.** The Etebase image is no longer used. The
  server is built from this repository.

## Covered by tests

The two gaps this file used to list are closed. `tests/access.rs` in the server
has `read_only_member_can_read_but_not_write` and
`removed_member_loses_access_at_once`, and they run on every pull request that
touches the server. `multi/sharing.e2e.ts` changes a member's access and removes
them between two real clients. The collaboration suites run on pushes to main,
on diffs that touch sync or sharing, and on pull requests labelled `ci:app-e2e`.

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
