# Sync server pen test — October 2026

Tested the server in `backend/server` against a real Postgres 16 container,
with the server built from this worktree and run with open signup on loopback,
both directly and inside an `ubuntu:26.04` container. Every finding below was
reproduced over HTTP with msgpack bodies, not inferred from reading alone. The
client app was surveyed only where it defines the wire format.

## Summary

| ID  | Severity | State     | Finding                                                           |
| --- | -------- | --------- | ----------------------------------------------------------------- |
| H1  | High     | Fixed     | Key blobs are stored without a size limit and outside accounting  |
| H2  | High     | Fixed     | Keys and names are stored outside the storage plan                |
| H3  | High     | Fixed     | An invitation outlives the join that should cancel it             |
| H4  | Medium   | Fixed     | A removed or demoted admin's invite links come back               |
| H5  | High     | Fixed     | An old invitation can still change an existing member's access    |
| M1  | High     | Fixed     | Concurrent bodies and responses can exceed the container's memory |
| M2  | Medium   | Fixed     | Concurrent writes can exceed an account's storage plan            |
| M3  | High     | Fixed     | A page budget weighs content but not chunk names                  |
| M4  | Medium   | Fixed     | Invitation previews bypass the page budget                        |
| M5  | Medium   | Fixed     | A removed member can come back by a link                          |
| L1  | Low      | Fixed     | A login says whether a username exists                            |
| L2  | Low      | Mitigated | The profile route says whether a username exists                  |
| L3  | Low      | Mitigated | Inviting says whether a username exists                           |

A review of the first round of fixes reopened H2 and M3, found M1 worse than
first written and added M5. Each section describes where its finding ended up.
M1 and M3 are named after their first severity and rated by what the review
found.

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

The review of the first fix found references still outside the count.
`revisions.chunk_ids` holds a row id for every chunk a revision names, and many
items may name the same chunks. On a 3 MiB plan, 61 revisions naming the same
32,768 chunks reported 2.1 MB in use while their arrays took 6.5 MB on disk, or
16 MB uncompressed. Each one was charged 76 bytes and stored about 106 KB.

**Fix:** one SQL expression in `collections::counted_bytes` now defines what a
collection is charged for, and both the recount used by `drop_content` and
the drift audit in `chunks::audit_storage` use it. It counts item uid, item
key and revision uid; revision uid, metadata and 8 bytes for each chunk
reference; chunk uid and content; member key and collection type; invitation
uid and key; and link uid, key and claim key. `store_revisions` checks and
charges the new item, revision and chunk-name bytes; `chunks::measure`,
`chunks::store` and `upload_chunk` include the uid; `prune` gives back revision
names, references and chunk names; membership, invitation and link inserts and
removals adjust the collection in the same transaction. Deleting an account
takes its rows out of collections other people own, so `admin::remove_account`
locks those and its own in id order, because two accounts can each belong to what
the other owns, and counts the others again. Migration `0010_count_metadata.sql` recounts
existing rows once, so a deployed server does not start undercounted.

Regression tests: `item_keys_count_against_storage`,
`chunk_uids_count_against_storage` and `chunk_references_count_against_storage`
in `tests/storage.rs`. `the_count_of_stored_bytes_agrees_with_the_rows_after_every_change`
in `tests/links.rs` compares the count with the audit after each way of changing
a collection, deleting a member's account included.

**Residual:** collection uids and the database's per-row overhead are not
counted. Both are small and bounded by the collection limit, unlike the
client-chosen keys and names above.

## M1 — Concurrent bodies and responses can exceed the container's memory

**Where:** `src/wire.rs` (`Msgpack` buffers the whole body), `src/edge.rs`
(pacing, connection caps), `src/lib.rs` (body limits), `src/collections.rs` and
`src/chunks.rs` (responses built in memory).

`Bytes::from_request` holds each request body in memory until the handler
finishes. The defaults were a 75 MiB body, 128 connections per address and a
4 GiB container limit in `compose.yml`, so one address could have about 9.6 GiB
of bodies buffered at once. Three things made that more than a burst:

- No account was needed. The body limit was global, so `login_challenge`,
  `login`, `signup` and `recover` read a 60 MiB body from anyone, at 20 requests
  at once and 10 a minute after that.
- Pacing was an average over what had arrived. A body sent almost whole earned
  about 21 hours to finish, and needed one byte every two minutes to keep the
  connection open.
- A trusted proxy is exempt from the per-address cap, which left only the
  server-wide cap of 10,000 connections. `compose.yml` trusts every private
  network, so that is the normal case.

Responses had the same problem, with nothing to hold them back. Each stayed in
memory until the client took it, and a client with a session could ask for a
page on every connection and read none of them. Behind a proxy that came to more
than 300 GiB in theory.

**Evidence:** eight concurrent 75 MiB posts to `/api/v1/collection/` raised the
server's RSS from 186 MiB to 609 MiB, then it fell back. Eight bodies of 49 MiB
held RSS at 823 MiB for 240 seconds on one byte a minute each, and the server
still answered when the last bytes came.

A later run took it to the end. Version 0.2.0 and the fixed server were each
held to 4 GiB with no swap, as `compose.yml` holds the container, and every
client came through a trusted proxy with an address of its own:

| Attack                                                               | 0.2.0                     | Fixed          |
| -------------------------------------------------------------------- | ------------------------- | -------------- |
| 400 clients ask for a page and do not read                           | Killed in about 5 seconds | Peak 894 MiB   |
| 200 clients send 49 MiB of a body and stop                           | Killed in about 5 seconds | Peak 1,283 MiB |
| 400 parked pages and 40 clients sending whole valid bodies of 49 MiB | Not run                   | Peak 2,658 MiB |

In the first run the fixed server served 15 pages and answered the other 385
with `503`. Throughout all three, a client asking for a small page every 250 ms
got every answer: 81 of 81, 80 of 80 and 120 of 120.

**Fix:** every part of a body takes room as it arrives and keeps it until the
handler is done (`edge::hold_body_room`).
`MINDSTREAM_MAX_BODY_BYTES_IN_FLIGHT`, 1 GiB by default, caps the server, and
`MINDSTREAM_MAX_BODY_BYTES_IN_FLIGHT_PER_ADDRESS`, 256 MiB, caps each client,
which behind a trusted proxy means the address it forwards. A body that would
go past either is cut off and answered `503`. Room is taken for what has
arrived and not for `Content-Length`, so a promise of a large body costs nobody
anything, and handlers read a body only after checking the session.
Routes that take a body without a session are held to 64 KiB. What a body has
already sent buys at most 30 minutes.

Responses are held the same way (`edge::hold_response_room`). A handler takes
room for what it is about to read before it reads it, and a response keeps room
for what it weighs until the last of it has gone to the connection.
`MINDSTREAM_MAX_RESPONSE_BYTES_IN_FLIGHT`, 512 MiB by default, caps the server,
and `MINDSTREAM_MAX_RESPONSE_BYTES_IN_FLIGHT_PER_ADDRESS`, 128 MiB, caps each
client. Past either the answer is `503`. Answers of 64 KiB or less are not
counted, so `/healthz` and small syncs go on. A response goes out in pieces, each
a copy, because hyper drops a body as soon as its last frame is queued, and the
room would be free again long before the memory was.

`CappedStream` holds a client to taking what it asked for. It starts with 30
seconds, each byte it takes buys more at 16 KiB a second, up to half an hour, and
time spent with output waiting for it is paid out of that. Keeping the connection
from going quiet is not enough any more. In a live run a client that sent a byte
every 30 seconds and read almost nothing was cut off after 150 seconds, with 14 KB
taken.

Regression tests: `sign_in_routes_take_no_large_body`,
`bodies_are_held_to_the_room_the_server_has` and
`saying_a_body_will_be_large_takes_no_room` in `tests/edge.rs`,
`responses_are_held_to_the_room_the_server_has` in `tests/storage.rs`, and
`what_a_body_sent_buys_only_so_much_time`,
`a_response_ends_up_holding_what_it_weighs`,
`a_client_that_keeps_talking_and_takes_nothing_is_cut_off` and
`a_client_that_keeps_taking_is_not_cut_off` in `src/edge.rs`.

**Residual:** a body exists twice while it is decoded and a response twice while
it is encoded, so the peak can reach twice each cap, which with the defaults is
3 GiB of the 4 GiB. Answers of 64 KiB or less are not counted, and neither is what
the kernel holds in socket buffers. Someone with several addresses can fill the
room for responses and keep it full for about half an hour. The server stays up
and small syncs go on, but large pages get `503` for everyone until then.

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
_sent_, not invitations addressed _to_ it. That made a read-only link member
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
or accepting one invitation cancels every other way in. `invite` refuses an
existing member, so a member should never hold an invitation. `remove_membership`
calls it as well, because a row that got past those checks would otherwise be
a way back after a removal, as whatever access it names.

Regression test `joining_by_link_withdraws_an_older_invitation` in
`tests/access.rs`: the stale invitation is gone from `list_incoming`, accepting
the saved copy fails, and the collection still reports `ReadOnly`.
`a_stale_invitation_goes_when_the_member_does` covers the removal.

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
access is not admin. The existing
`link_stands_only_while_its_maker_is_an_admin` test in `tests/links.rs` now
also demotes and re-promotes, then removes and re-adds the maker, and checks
the link stays gone each time.

**Residual:** disabling an account does not delete links it made; re-enabling
it makes them work again. This is deliberate for a temporary suspension. To end
them for good an admin removes the account from the collection, which used to
answer `404` for a disabled account. `remove_member` and `modify_member` now
look the name up among the collection's members, disabled or not. Regression
test `a_disabled_admin_can_be_taken_out_and_its_links_stay_gone` in
`tests/links.rs`.

## H5 — An old invitation can still change an existing member's access

**Where:** `src/sharing.rs`, `accept`.

`invite` refuses to invite an existing member, and the link and invitation
join paths withdraw every invitation addressed to an account before it becomes
a member, so a member should hold none. `accept` did not check, though. It
called `add_member`, whose upsert replaced the access the member already had
with the invitation's access, so if such a row ever existed a read-write member
could make themselves an admin.

**Evidence, before the fix:** a read-write member's access was `2`. An
invitation with access `1` (Admin) was inserted for the same account by hand.
Accepting it answered `201`; the member's access became `1`. After the fix the
same request answers `409 already_member`, the member stays at `2`, and the
stale row is gone.

**Fix:** after locking the collection and the invitation, `accept` checks
`members` for the caller. If the caller is already a member it withdraws the
invitation, commits, and answers `409 already_member`; it does not call
`add_member`. No deployment holds an invitation from before these fixes, so
there is nothing to clean up. The check stays because this is the one place an
invitation could raise someone's access. Regression test
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

The fix to `list_items` weighed a page only after reading it, so a response was
bounded and the server's memory was not. `fetch_updates` was not held to the
budget at all, and neither page nor answer weighed metadata.

**Evidence, before the fix:** on a server with a 64 KiB page budget, one item
with 32,768 zero-byte chunks and 64-byte names answered
`prefetch=medium&limit=1000` with 2,228,397 bytes: 34 times the budget. The
same shape with 100 items sharing 1000 names would return about 6.4 MB. On a
512 KiB budget, a 2,199-byte `fetch_updates` request naming 61 such items
answered 136 MB. At the 10,000 refs a request may carry that comes to about
22 GB built in memory, though only the 61 were run. 1000 items of 64 KiB
metadata made a page of 65.7 MB.

**Fix:** the database weighs a row before it is read. `collections::page` takes
the weight of each row a list found, its metadata, its key and each chunk it
names at the longest a uid can be, and the list reads only the rows that fit.
Neither `chunk_ids` nor the chunk uids of rows that do not go out reach the
server's memory. Content is held to what the budget has left. One row always
goes out, as references if it has to, so paging cannot get stuck.

`fetch_updates` cannot end early, because a client takes what comes back for
all it asked. When more than one item would not fit it answers `413
too_much_at_once`, and the app asks for fewer (`sync::pull::in_two_turns`). One
item is always answered, so an oversized item in a shared collection cannot
stop anybody's sync. An older client gets an error and loses nothing.

Regression tests: `medium_prefetch_page_is_held_to_the_budget`,
`fetch_updates_is_held_to_the_budget`, `fetch_updates_answers_one_item_of_any_size`
and `pages_weigh_metadata_and_reach_every_item` in `tests/storage.rs`, and
`asking_for_fewer_reaches_every_item_a_large_batch_was_refused_for` in the app's
sync tests.

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

**Fix:** `main_items` takes a budget, has the database weigh every main item
first and reads only those that fit. A preview that does not fit is left out;
the invitation still arrives with its key, the app shows it without a name, and
the recipient can fetch the collection after joining. `with_previews` passes
`max_page_bytes`. A link's own preview (`links::open`) is a single item and
passes an unlimited budget, preserving its old shape.

## M5 — A removed member can come back by a link

**Where:** `src/links.rs`, `claim`; `src/sharing.rs`, `remove_member`.

A link that lets several people in keeps working after someone used it, and
they still hold its secret. `claim` checked whether the caller was a member and
not whether an admin had just taken them out. H3 rated the same outcome by an
old invitation as High.

**Evidence, before the fix:** a guest claimed a link with five uses, the owner
removed them, and claiming the same link again answered `201`.

**Fix:** `removed_members` records whether an admin did the removing (`by_admin`,
migration `0011_removed_by_an_admin.sql`), and `claim` then answers as for a
dead link, whichever link it is. Someone who left by themselves is not held
back. An invitation is how an admin lets someone back in, and joining clears
the row. Regression tests `someone_taken_out_does_not_come_back_by_a_link` and
`someone_who_left_can_come_back_by_a_link` in `tests/links.rs`.

**Residual:** on a server that lets people sign up, a removed person can claim
a link they kept from another account. The server cannot tell them from anyone
else holding the link, so the app asks. After a removal, if the folder has links
that can still be used, it offers to remove them. That is for the admin to decide,
since a link may have been made for others.

## L1 — A login says whether a username exists

**Where:** `src/auth.rs`, `login_challenge` and `verify_signed`.

An unknown username answered `401 user_not_found`; a known one answered `200`
with a challenge and salt. Login is held to `MINDSTREAM_AUTH_RATE_PER_MINUTE`
(10 by default) per address, which made bulk enumeration slow but not
impractical. On a closed server this was the only name check an outsider could
reach.

**Evidence, before the fix:** the same request body for a fresh account answered
`200` with a 125-byte challenge; for a name that does not exist it answered `401`
with `code=user_not_found`.

**Fix:** a name without an account gets a salt and a challenge like any other.
`Keys::decoy` works out the salt from the name and the server's secret, so it is
as long as a real one and the same each time. `verify_signed` then takes every
step a wrong password takes, against a key nobody holds, and answers
`login_bad_signature`. An account without a recovery key goes the same way, and
the throttle on wrong passwords counts for a decoy too, or a name that never
turned into `429` would give itself away after eleven tries.

Three things stood in the way of the work being the same, and changed:

- A challenge carried the account's number in the clear. It now carries a hash
  of the name.
- The account's row lock came first, which a missing row cannot do. It now comes
  after the proof holds, and the key is read again under the lock, so a password
  changed in between still counts.
- A decoy is made for every request, so a missing name costs no more than any
  other.

What is left is the database finding a row or not. `auth::no_sooner` holds every
sign-in to 100 ms from when its request is in, well above all of the work. The
clock starts after the body has arrived, or a caller could spend the time sending
it. The wait comes after the transaction ends, so it costs a timer and not a
database connection.

Measured over loopback to the first byte of the answer, 1,500 of each, against a
5% line of 0.050 for the distance between the two distributions:

| Step      | Known p50 | Unknown p50 | Gap of means | Distance |
| --------- | --------- | ----------- | ------------ | -------- |
| Challenge | 101.48 ms | 101.47 ms   | −8 µs        | 0.026    |
| Login     | 101.39 ms | 101.42 ms   | −53 µs       | 0.031    |

Without the 100 ms the gaps were +4 µs and −19 µs, at distances of 0.032 and
0.026. As a control, a build without it that skipped the signature check for
unknown names showed −74 µs at a distance of 0.066, so a gap of that size is
visible to this measurement. That run's challenge step, which was not changed,
read 0.057, so the line is only rough.

The app says "Wrong username or password." and keeps "Wrong password." where the
account is not in question. Regression tests
`a_name_nobody_has_signs_in_like_a_wrong_password` and
`signing_in_takes_no_less_than_a_set_time` in `tests/security.rs`,
`sending_slowly_does_not_use_up_the_time_a_sign_in_takes` in `tests/edge.rs`, and
`a_decoy_stays_the_same_and_belongs_to_nobody` in `src/keys.rs`.

**Residual:** on a server with open signup, taking a name answers `409
user_exists` at the same rate, so this protects closed and invite servers. Someone
watching one name sees its salt change if an account takes it. The owner signing
in clears an account's count of wrong passwords, and nothing clears a decoy's.
The timing was measured on one machine over loopback, not across a network.

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

**Mitigation:** the client needs the key before it can invite someone, so the
route cannot simply answer `404` for both. It now counts against a limit per
account, `MINDSTREAM_LOOKUP_RATE_PER_MINUTE`, 30 by default with a burst of 30,
and `MINDSTREAM_UNKNOWN_NAMES_PER_DAY`, 20 by default. Past either the answer is
`429` for any name, so the refusal says nothing either. A list of guesses is
mostly names nobody has and ends after 20 of them. A list of names that are mostly
real goes on at 30 a minute, which is why this is mitigated and not fixed. The app
asks once for each person the user names, so it comes near neither. Both limits
are kept in memory and start over when the server restarts. Regression tests
`looking_up_names_is_held_to_a_rate` and `guessing_names_runs_out` in
`tests/access.rs`.

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

**Mitigation:** the server cannot address an invitation to an account that is
not there, so the route has to tell them apart. `invite` counts against the same
per-account limits as the profile route. `remove_member` and `modify_member` said
the same thing without writing anything, answering "User" or "Member" not found.
They now look the name up among the collection's members and answer the same
for any other name. Regression test
`member_routes_say_nothing_about_names_outside_the_collection` in
`tests/access.rs`.

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
`tests/access.rs` and `tests/links.rs`. The load runs and timing measurements
were throwaway too. Each ran the release build as a separate process under
`systemd-run --scope -p MemoryMax=4G -p MemorySwapMax=0`.

`tests/upgrade.rs` takes a database with rows in it from the schema of 0.2.0 to
the current one. The upgrade was also run for real: 0.2.0 filled a database
through its API, and the fixed server started on it. Migrations went from 9 to 11,
the charge went from 6,553,628 to 6,561,419 bytes, the audit found no drift before
or after new writes, a session from before the upgrade still worked, and all 106
items were served.
