# Sync server pen test — October 2026

Tested the server in `backend/server` against a real Postgres 16 container,
with the server built from this worktree and run with open signup on loopback,
both directly and inside an `ubuntu:26.04` container. Every finding below was
reproduced over HTTP with msgpack bodies, not inferred from reading alone. The
client app was surveyed only where it defines the wire format.

## Summary

| ID  | Severity | State | Finding                                                          |
| --- | -------- | ----- | ---------------------------------------------------------------- |
| H1  | High     | Fixed | Key blobs are stored without a size limit and outside accounting |
| H2  | High     | Fixed | Keys and names are stored outside the storage plan               |
| H3  | High     | Fixed | An invitation outlives the join that should cancel it            |
| H4  | Medium   | Fixed | A removed or demoted admin's invite links come back              |
| H5  | High     | Fixed | An old invitation can still change an existing member's access   |
| M1  | Medium   | Open  | Concurrent large bodies can exceed the container's memory        |
| M2  | Medium   | Fixed | Concurrent writes can exceed an account's storage plan           |
| M3  | Medium   | Fixed | A page budget weighs content but not chunk names                 |
| M4  | Medium   | Fixed | Invitation previews bypass the page budget                       |
| L1  | Low      | Open  | A login says whether a username exists                           |
| L2  | Low      | Open  | The profile route says whether a username exists                 |
| L3  | Low      | Open  | Inviting says whether a username exists                          |

## H1 — Key blobs are stored without a size limit and outside accounting

**Where:** `src/collections.rs`, `create_collection` and `validate_items`.

`sharing::validate_membership_keys` holds a membership key to 4096 bytes, and
both the invitation and invite-link paths call it. Creating a collection did
not. Neither did item validation, so `Item.encryption_key` was unbounded too.
The request body cap of 75 MiB was therefore the only limit, and none of these
bytes are part of `collections.bytes_used`, which counts revision metadata and
chunk sizes only.

An account could park up to 75 MiB per request outside its plan, and repeat
that without bound. With open signup that needs no invitation; with a plan it
is a quota bypass. It is also unbounded database growth.

**Evidence, before the fix:**

- A collection created with an 8 MiB `collectionKey` and an 8 MiB
  `collectionType` answered `201`. The row held 8,388,608 bytes in each column
  while `bytes_used` was `4`.
- An item pushed with an 8 MiB `encryptionKey` answered `200`, stored
  8,388,608 bytes, and left `bytes_used` at `8`.
- On a 100 KiB plan, a second 64 KiB item was refused with `402 storage_full`,
  while a collection with an 8 MiB key was still accepted with `201`.

**Fix:** `create_collection` calls `sharing::validate_membership_keys`, and
`validate_items` rejects an item key longer than `sharing::MAX_KEY_BYTES`.
Both now answer `400` with `Malformed membership key.` or
`Item key is too large.` Regression tests:
`collection_keys_are_held_to_a_size_the_app_uses` and
`item_keys_are_held_to_a_size_the_app_uses` in `tests/storage.rs`.

The cap still allows 4096 bytes per row, but those bytes are now charged to
the plan (see H2), so the cap is no longer free storage. The bytes counted
are the same ones the recount uses; a key that fits the cap but does not fit
the plan is refused with `402 storage_full`.

## H2 — Keys and names are stored outside the storage plan

**Where:** `src/collections.rs` (`store_revisions`, `counted_bytes`,
`prune`, `drop_content`), `src/chunks.rs` (`measure`, `store`,
`upload_chunk`, `audit_storage`), `src/sharing.rs` and `src/links.rs`.

`collections.bytes_used` counted revision metadata and chunk content only.
Every other client-chosen field was stored for free: `items.encryption_key`,
`items.uid`, `revisions.uid`, `chunks.uid`, `members.encryption_key` and
`members.collection_type`, `invitations.signed_encryption_key`, and the keys,
uid and claim key of an invite link. An item with no key, empty metadata and
no chunks could therefore cost nothing, however many were written. The H1
cap on a key made the key small, not counted.

**Evidence, before the fix:** an account on an 8 KiB plan created a collection
and pushed 1000 items, each with a 4096-byte `encryptionKey` and four bytes of
metadata. All 1000 were accepted. `bytes_used` and the usage page reported
4004 bytes, while Postgres held 4,096,000 bytes of item keys. The same gap
covered chunk names: a revision with 32,768 zero-byte chunks and 64-byte uids
stored about 2 MiB of names while only its four metadata bytes were counted.

**Fix:** one SQL expression in `collections::counted_bytes` now defines what a
collection is charged for, and both the recount used by `drop_content` and
the drift audit in `chunks::audit_storage` use it. It counts item uid, item
key and revision uid; revision uid and metadata; chunk uid and content;
member key and collection type; invitation uid and key; and link uid, key and
claim key. `store_revisions` checks and charges the new item, revision and
chunk-name bytes; `chunks::measure`, `chunks::store` and `upload_chunk`
include the uid; `prune` gives back both revision and chunk names; membership,
invitation and link inserts and removals adjust the collection in the same
transaction. Migration `0010_count_metadata.sql` recounts existing rows once,
so a deployed server does not start undercounted.

Regression tests: `item_keys_count_against_storage` and
`chunk_uids_count_against_storage` in `tests/storage.rs`. The first writes one
4 KiB item key and then has the second refused on a 6 KiB plan; the second
does the same for 64-byte chunk names on an 8 KiB plan.

**Residual:** collection uids and the database's per-row overhead are not
counted. Both are small and bounded by the collection limit, unlike the
client-chosen keys and names above.

## M1 — Concurrent large bodies can exceed the container's memory

**Where:** `src/wire.rs` (`Msgpack` buffers the whole body), `src/edge.rs`
(connection caps), `src/config.rs` (defaults).

`Bytes::from_request` holds each request body in memory until the handler
runs. The defaults are a 75 MiB body, 128 connections per address and a 4 GiB
container limit in `compose.yml`. One address can therefore have about 9.6 GiB
of bodies buffered at once. The body pacing in `edge.rs` limits how slowly a
body may arrive, not how many arrive together.

**Evidence:** eight concurrent 75 MiB posts to `/api/v1/collection/` raised the
server's RSS from 186 MiB to 609 MiB, then it fell back. That is the expected
linear growth; 128 such bodies would be far past the 4 GiB limit. The OOM was
not run to completion here, so the container being killed is arithmetic rather
than an observed crash.

**Suggested:** a server-wide in-flight body budget (for example, count bytes
as frames arrive in `Paced` and fail the request past a cap, or a weighted
semaphore keyed on `Content-Length`), or defaults that agree with each other:
128 connections times a body limit must fit the memory the container is given.
The comment on the memory limit already says to raise it with the limits above,
but the shipped numbers do not fit.

## M2 — Concurrent writes can exceed an account's storage plan

**Where:** `src/limits.rs`, `for_writes` and `check_new_space`.

`for_writes` read the account's plan and summed `collections.bytes_used`, and
the write then went on to add to that sum. Writes to one collection take turns
on its row lock, but the storage budget belongs to the account: two writes to
different collections could both read the same usage and both pass. The check
and the write were one turn only for a single collection.

**Evidence:** on a 2 MiB plan, 32 concurrent 1 MiB pushes to 32 collections let
two through and stored 2,097,288 bytes (2 MiB + 136). One write is the honest
maximum; the second was let through against the same, not yet updated, total.
The overshoot is at least one write and grows with the number of writes that
reach the check while another one is still storing. The same check-then-insert
pattern existed for `max_spaces` in `check_new_space`, though that window is
much smaller and was not made to lose a race here.

This is a billed limit, so the effect is free storage for the duration of the
burst, not access to anything belonging to someone else.

**Fix:** `for_writes` and `check_new_space` take a per-account advisory
transaction lock (`pg_advisory_xact_lock`) before reading the running totals,
so the check and the write are one turn per account. The lock ends with the
transaction. Writes for an account without a storage limit do not take it;
plans with a limit serialize their writes, which is the cost of an exact
budget. Regression test `concurrent_writes_to_different_collections_share_one_budget`
in `tests/storage.rs`: it stores 2 MiB + 136 before the fix and one write
after it.

## H3 — An invitation outlives the join that should cancel it

**Where:** `src/sharing.rs`, `add_member`, `remove_membership` and
`modify_member`; reached from `sharing::accept` and `links::claim`.

`invite` refuses to invite an existing member, but an invitation created
before the account joins by another route was never withdrawn. Accepting it
later called `add_member` with the invitation's access level, replacing the
access the link had just granted. The same stale row survived a removal,
because `remove_membership` withdrew invitations the removed account had
*sent*, not invitations addressed *to* it. That made a read-only link member
an admin, and let a removed member rejoin with the old invitation.

**Evidence, before the fix:** the owner invited the guest as `Admin`, then
made a `ReadOnly` link. The guest claimed the link; fetching the collection
reported `left: Admin`, `right: ReadOnly` after accepting the older
invitation. In a second run the owner removed the guest after the link claim;
the invitation was still in `list_incoming`, and accepting it put the guest
back with `Admin`.

**Fix:** `withdraw_invitations_to` deletes every invitation addressed to an
account in the collection, charges back the bytes, and tells the sender.
`add_member` calls it before the membership is inserted, so joining by a link
or accepting one invitation cancels every other way in. `remove_membership`
and `modify_member` call it too, for rows that may predate the fix.

Regression test `joining_by_link_withdraws_an_older_invitation` in
`tests/access.rs`: the stale invitation is gone from `list_incoming`, accepting
the saved copy fails, and the collection still reports `ReadOnly`.

## H4 — A removed or demoted admin's invite links come back

**Where:** `src/sharing.rs`, `remove_membership` and `modify_member`.

H3 withdrew the invitations a removed or demoted member had sent, but not the
invite links they had made. `links::find` stopped honouring such a link while
its maker was not an admin, so it looked withdrawn. The row was still there.
If the same account was added back, or promoted back to admin, the old link
worked again, even though its secret may have been shared while the account
had authority and the owner had since removed that authority.

**Evidence, before the fix:** an admin made a link. The owner demoted the
admin to read-write; opening the link answered `404`, as expected. The owner
then promoted the account back to admin; opening the same link answered `200`
and a new guest could claim it. The regression test fails at that point with
`left: 200, right: 404`.

**Fix:** `withdraw_links` deletes every link the account made in the
collection and gives back its counted bytes. `remove_membership` calls it
after withdrawing invitations, and `modify_member` calls it whenever the new
access is not admin. Migration `0011_withdraw_stale_access.sql` removes rows
an older build left behind. The existing
`link_stands_only_while_its_maker_is_an_admin` test in `tests/links.rs` now
also demotes and re-promotes, then removes and re-adds the maker, and checks
the link stays gone each time.

**Residual:** disabling an account does not delete links it made; re-enabling
it makes them work again. This is deliberate for a temporary suspension, but
an operator using disable as a revocation should remove the account from the
collection instead. The migration can only judge access as it stands: a link
whose maker was removed and re-added before the upgrade still looks valid.
Rotate links in spaces that had admin churn before deploying.

## H5 — An old invitation can still change an existing member's access

**Where:** `src/sharing.rs`, `accept`.

`invite` refuses to invite an existing member, and the link and invitation
join paths normally withdraw every invitation addressed to an account before
it becomes a member. A row written by an older build could still exist for an
account that was already a member. `accept` did not check membership; it
called `add_member`, whose upsert replaced the access the member already had
with the invitation's access. A read-write member holding an old Admin
invitation could therefore make themselves an admin.

**Evidence, before the fix:** a read-write member's access was `2`. An
invitation with access `1` (Admin) was inserted for the same account, as an
older build could have left it. Accepting it answered `201`; the member's
access became `1`. After the fix the same request answers `409
already_member`, the member stays at `2`, and the stale row is gone.

**Fix:** after locking the collection and the invitation, `accept` checks
`members` for the caller. If the caller is already a member it withdraws the
invitation, commits, and answers `409 already_member`; it does not call
`add_member`. Migration `0011_withdraw_stale_access.sql` deletes such rows,
and also invitations whose sender is no longer an admin, then recounts the
affected collections. Regression test
`a_stale_invitation_cannot_change_an_existing_members_access` in
`tests/access.rs`.

## M3 — A page budget weighs content but not chunk names

**Where:** `src/chunks.rs` (`Loaded`, `load`), `src/collections.rs`
(`list_items`, `list_revisions`, `list_collections`).

The page budget compared the content of each revision with
`max_page_bytes`. A revision also carries the uids of its chunks, each up to
64 bytes, and a revision may name 32,768 chunks. Those names were not
weighed. Worse, `prefetch=medium` sets `with_content=false`, and `list_items`
skipped the budget entirely in that case with the comment that there was
nothing to weigh. A client could therefore ask for a page far larger than the
budget without asking for any content.

**Evidence, before the fix:** on a server with a 64 KiB page budget, one item
with 32,768 zero-byte chunks and 64-byte names answered
`prefetch=medium&limit=1000` with 2,228,397 bytes: 34 times the budget. The
same shape with 100 items sharing 1000 names would return about 6.4 MB
before the fix; the regression test now answers 545,006 bytes on a 512 KiB
budget.

**Fix:** `Loaded` keeps `fits` separately from `with_content`. A revision
weighs its content when that is sent, and always the bytes of its chunk uids.
`list_items` truncates a page to `fits` whether or not content was requested;
`list_revisions` and `list_collections` do the same. An item too large for
any page still goes out alone as references, so paging cannot get stuck.

Regression test `medium_prefetch_page_is_held_to_the_budget` in
`tests/storage.rs`.

**Residual:** `fetch_updates` still returns every requested item, because the
client does not page it and silently dropping rows would lose updates; its
amplification is bounded by the 10,000 refs a request may carry, not by the
page budget. It deserves a cap or a client protocol change.

## M4 — Invitation previews bypass the page budget

**Where:** `src/sharing.rs`, `with_previews`; `src/collections.rs`,
`main_items`.

`list_incoming` and `fetch_incoming` attach a preview of each collection's
main item so the recipient can read its name before joining. `main_items`
called `chunks::load` with a budget of zero, which meant it read every chunk
uid of every main item and attached all of them. The invitation page itself
has a limit of 1,000 rows, so one request could carry a thousand previews,
each naming up to 32,768 chunks. This was the same amplification M3 fixed for
collection and item pages, left in the one place that had a budget argument
but passed zero.

**Evidence, before the fix:** on a server with a 512 KiB page budget, one
invitation to a collection whose main item named 32,768 zero-byte chunks with
64-byte uids answered `GET /api/v1/invitation/incoming/?limit=1000` with
2,228,705 bytes. After the fix the same request answers 335 bytes, because
the one preview does not fit and is omitted. The regression test is
`invitation_previews_are_held_to_the_page_budget` in `tests/storage.rs`.

**Fix:** `main_items` takes a budget and reads one main item at a time,
subtracting the bytes of the chunk uids it carries. A preview that does not
fit is left out; the invitation still arrives with its key, and the recipient
can fetch the collection after joining. `with_previews` passes
`max_page_bytes`. A link's own preview (`links::open`) is a single item and
passes an unlimited budget, preserving its old shape.

**Residual:** the main-item query still fetches a row for every invitation
before the loop. The response is bounded now, but a thousand invitations to
collections whose main items name 32,768 chunks still cost their chunk-id
arrays on the server. A cap on preview rows would bound that too; it would
leave some invitations without a preview until the recipient joins.

## L1 — A login says whether a username exists

**Where:** `src/auth.rs`, `login_challenge`.

An unknown username answers `401 user_not_found`; a known one answers `200`
with a challenge and salt. Signup-code checks answer uniformly; the profile
and invite routes do not, see L2 and L3. Login is held to
`MINDSTREAM_AUTH_RATE_PER_MINUTE` (10 by default) per address, which makes
bulk enumeration slow but not impractical.

**Evidence:** the same request body for a fresh account answered `200` with a
125-byte challenge; for a name that does not exist it answered `401` with
`code=user_not_found`.

**Why it is open:** the Etebase login flow needs the account's salt before it
can derive the key, and the client library treats an unknown user as a
distinct outcome. Answering with a decoy salt and a challenge that can never
verify would move the disclosure to the signature step unless that step also
stopped saying `user_not_found`, which is a wire-format change on both sides.
The per-address limit is the current mitigation.

## L2 — The profile route says whether a username exists

**Where:** `src/sharing.rs`, `fetch_user_profile`.

The authenticated profile lookup used before an invitation answers `404
User` for a name that does not exist and `200` with the account's public key
for one that does. Unlike login, it has no `AuthAttempt` extractor, so the
only cost is one request per name. An account holder can enumerate the user
base at request speed and learn which names are real; the answer also gives
the public key for each one.

**Evidence:** a signed-in device asking for a fresh account's name received
`200` and a 32-byte `pubkey`; the same request for an unused name received
`404` with `code=does_not_exist`.

**Why it is open:** the client needs the key before it can invite someone, so
the route cannot simply answer `404` for both. A rate limit keyed on the
caller or the target would slow enumeration, but an invite flow that looks up
many names at once would feel it too. L1 is the same trade-off on the login
path; together they are the remaining username-enumeration surface.

## L3 — Inviting says whether a username exists

**Where:** `src/sharing.rs`, `invite` and `account_id_of`.

An admin can create a collection on an open-signup server, then call
`POST /invitation/outgoing/` with any username. A name that exists and is not
already a member produces an invitation and answers `201`; a name that does
not exist answers `404 does_not_exist`. The request is not rate-limited, and
the successful case also writes an invitation row and wakes the recipient.

**Evidence:** an account created a collection and invited a fresh account:
`201`. The same request with an unused name answered `404`. The probe printed
`known=201 unknown=404`.

**Why it is open:** the server cannot address an invitation to an account
that is not there, and the client distinguishes an unknown name from a
successful invitation. A rate limit would slow this channel but, as with L2,
would also slow a legitimate batch of invitations. The profile route already
gives the same answer to an authenticated caller, so this is an additional
oracle rather than the only one.

## Checked and found sound

- Collection access always goes through `membership`, which answers `404` to
  non-members; item and chunk reads are scoped by collection and, for chunks,
  by a revision of the named item.
- Room tickets are short-lived, bound to account, session, collection and
  item, and re-checked against the database on connect. Read-only members
  cannot relay document changes.
- Invitations, invite links and signup codes bind to the caller's account or
  a proof over the link secret; link claims are locked and counted with the
  membership.
- Session tokens are 32 random bytes, stored as SHA-256; login challenges are
  HMAC-authenticated and single-use; the admin token compares in constant
  time.
- SQL is parameterised throughout; the `format!` statements interpolate
  constant column lists and clause fragments only.
- The public invite page escapes what it reflects and pins a hash-based CSP.

## Reproducing

```sh
docker run -d --name ms-pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_USER=mindstream \
  -e POSTGRES_DB=mindstream -p 55432:5432 postgres:16-alpine

cd backend/server
cargo build --bin mindstream-server
MINDSTREAM_DATABASE_URL=postgres://mindstream:testpass@127.0.0.1:55432/mindstream \
MINDSTREAM_LISTEN=127.0.0.1:18080 MINDSTREAM_SIGNUP=open \
MINDSTREAM_TEST_RESET=true MINDSTREAM_ADMIN_TOKEN=pen-admin \
  ./target/debug/mindstream-server

MINDSTREAM_TEST_DATABASE_URL=postgres://mindstream:testpass@127.0.0.1:55432/mindstream \
  cargo test
```

The probes were throwaway integration tests driving the wire protocol by hand
with `rmp_serde`; the regression tests that remain are in `tests/storage.rs`,
`tests/access.rs` and `tests/links.rs`.
