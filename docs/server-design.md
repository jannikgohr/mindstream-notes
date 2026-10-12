# Sync server design

Status: agreed design, written 2026-10-12. The server in
[backend/server](../backend/server/README.md) has the core of step 1 and the
server halves of steps 3, 4 and 5: rooms and the change feed, invite links,
then device sessions, two-factor sign-in and the recovery key. The app still
runs on the old stack: nothing on the client side is built yet.

This replaces the backend stack described in
[architecture.md](architecture.md#the-backend-stack): nginx, Etebase on
Postgres, yjs-relay and excalidraw-room. One server takes over all of it. It
keeps the Etebase client library and its encryption, and adds what the current
stack cannot offer: rooms that know who is connected, pushed changes, sharing
in one step, and account security.

Every row in the [decisions](#decisions) table was decided by the project
owner. The mechanisms under the later headings are proposals for carrying those
decisions out, and may change during implementation. Points that still need an
answer are collected under [open points](#open-points).

## Why

### Live collaboration cannot tell who is connected

The relays are blind broadcast hubs, so everything that needs identity is
worked around on the client.

- **Joining.** A room id is the public half of a keypair derived from the note
  key, and the relay checks a signature against it. That proves a client can
  derive the room secret. It says nothing about which member it is or what
  they may do. The derivation is in
  [collab_room.rs](../src-tauri/src/sync/collab_room.rs).
- **Write permission.** Every frame in a shared room carries an ECDSA signature
  and a JSON header. Together they add roughly 400 bytes, counted from the
  header format and not measured. Peers check the signature against writer
  keys stored as items in the shared folder's assets collection. Those keys
  are bound to usernames the writer declares, which is finding M4 in
  [security-review.md](security-review.md).
- **Read-only members** are kept out of live rooms entirely, by
  `can_receive_live_collab_room`.
- **Revocation** rotates a salt in the share manifest and waits for every
  client to notice on its next sync. The manifest's origin is unverified, which
  is finding M5.
- **Freeform notes** go through a third-party socket.io server that admits
  anyone who knows a room id.
- **Presence** exists only where the awareness protocol is used. Ink and
  freeform report no peers, as [known-limitations.md](known-limitations.md)
  records.

### Sync is slow, and most of the time is the server

Measured on the local test stack with `pnpm bench:backend --scale full`. See
[the benchmark](#testing) for what the numbers cover.

| What the app does                                       | Requests | Localhost                   |
| ------------------------------------------------------- | -------- | --------------------------- |
| Idle sync tick, nothing changed                         | 11       | 273 ms                      |
| Tick with one edited note                               | 13       | 365 ms                      |
| Idle tick with one shared folder                        | 18       | 501 ms                      |
| Push 1000 new notes                                     | 1        | 5.9 s                       |
| Push edits to 100 notes                                 | 101      | 3.8 s                       |
| New device pulls 1250 notes                             | 25       | 3.2 s                       |
| Open a personal note for live editing, before the relay | 2        | 63 ms                       |
| Same, in a shared folder holding 8 MiB of attachments   | 7        | 818 ms, 16.7 MiB downloaded |
| Relay frame, sender to receiver                         |          | 0.7 ms                      |
| Memory of the five containers                           |          | 215 MiB idle, 443 MiB after |

- An authenticated Etebase request costs about 27 ms. nginx alone answers in
  0.75 ms and Etebase's route without a database in 1.1 ms. Etebase opens a new
  Postgres session for every request: 41 sessions for 40 requests.
- Request count is the other half. Requests are sequential, so on a 40 ms link
  the idle tick takes about 0.7 s.
- Nothing pushes changes. A remote edit waits for the next tick, 30 s by
  default.
- Opening a note in a shared folder downloads every attachment in that folder
  twice, because the writer-key lookup lists the whole assets collection.
- The relays are already fast. A new server will not make typing feel faster.

### Sharing a folder takes four invitations

A shared folder is four collections: a manifest plus folders, notes and assets.
The recipient accepts four invitations in sequence with no transaction, as
[bundles.rs](../src-tauri/src/sharing/bundles.rs) notes, so partial states
exist and need handling. The recipient cannot see the folder's name before accepting.
Invitations are found by scanning, not pushed. Changing a member's access or
removing them loops over the collections one request at a time.

## Decisions

| Area     | Decision                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Client   | Keep the Etebase client library and its encryption. It has proven itself end to end.                    |
| Client   | Stock Etebase servers do not need to keep working. The app already runs on its own etebase-rs fork.     |
| Client   | Breaking changes are fine. There are no real users yet, so nothing is migrated.                         |
| Server   | One server hosts storage, auth and the live rooms for every note kind.                                  |
| Server   | Written in Rust, fresh, not ported from the Python reference server.                                    |
| Server   | Lives in this repository at `backend/server`.                                                           |
| Server   | Postgres is the only database, for self-hosted and managed alike.                                       |
| Server   | Licensed AGPL. The app stays MIT OR Apache-2.0.                                                         |
| Speed    | It must be noticeably faster than the current stack, measured with the benchmark.                       |
| Data     | One collection per space: one for the vault and one for each shared folder.                             |
| Rooms    | The server enforces write permission. Per-frame signatures, writer keys and the join challenge go.      |
| Rooms    | Freeform notes use the same room protocol as every other kind. socket.io goes.                          |
| Sharing  | Invite links, including signup on self-hosted servers.                                                  |
| Accounts | Sessions are per device and replace the silent token refresh.                                           |
| Accounts | Two-factor sign-in with TOTP, compatible with the common authenticator apps.                            |
| Accounts | A recovery key.                                                                                         |
| Accounts | Recovery still requires the second factor when one is enrolled.                                         |
| Accounts | No reset of the second factor by email.                                                                 |
| Accounts | A signed-in device plus the re-entered password may enrol a new authenticator.                          |
| Managed  | The `managed` server type runs on this server, later with account limits, paid subscriptions and tiers. |
| Managed  | The owner of a space pays for its storage. Collaborators need no paid account.                          |

## What stays and what changes

What Etebase encrypts and signs, and how, stays as it is. That covers the
account keys, collection and item encryption, chunking, and the invitation
exchange. The etebase-rs fork remains the client.

Everything around that is free to change: which routes exist, what they batch,
what the server pushes, and how the app lays its data out in collections.

Two additions touch key handling. Both reuse existing primitives, and both
deserve their own review before they ship.

- The [recovery key](#recovery-key) stores a second wrapped copy of the account
  keys.
- An [invite link](#invite-links) is an ordinary invitation addressed to a
  keypair derived from a secret in the link.

## Architecture

```
one process, one port, behind the deployer's TLS proxy

HTTP  /api/...            storage and account routes
WS    change feed         <- commit events
WS    rooms               <- membership events
GET   /healthz            kept, the app's reachability probe uses it
GET   invite landing page

Postgres                  accounts, sessions, collections, items, members,
                          invitations, entitlements, usage counters
blob store                filesystem when self-hosted, S3-compatible when managed
```

- **One source of truth.** Sessions, membership and commits live in one
  process. A commit publishes the collection and its new stoken, which feeds
  the change feed. A membership change reaches the rooms the same way, so the
  server can close that member's sockets at once.
- **A connection pool.** The per-request session is what makes Etebase slow,
  not Postgres.
- **Small chunks in the database, large ones in the blob store.** A note is
  usually one small chunk. The large chunks of one upload are written as a
  single blob, so an attachment costs one write and one flush to disk, and one
  object once blobs live in a bucket.
- **Ready for a second node without running one.** Tickets are signed and
  short-lived, not held in memory. The change feed can ride on Postgres
  notifications. Rooms run on one node at first, and routing by room is the
  later step.
- **The edge moves into the server.** nginx currently provides the auth rate
  limit, the per-address connection cap, trusted-proxy handling for the client
  address, and the 75 MB body limit. The server has to do all four.
- **Administration is a command-line tool** on the server binary plus a signup
  policy in its configuration: closed, by invitation, or open. This replaces
  the Django admin and the `AUTO_SIGNUP` flag.
- **A version handshake.** Self-hosters upgrade the app and the server
  separately, so each side has to learn the other's protocol level and say
  clearly when one of them needs updating.

## Data layout

Each space is one collection. The vault is a space, and so is each shared
folder. Folders, notes, attachments and signatures are item types inside it.

This removes the four vault collections, the share manifest, and the three part
collections per share. A note belongs to exactly one space, as today. Moving it
into or out of a shared folder deletes it from one collection and creates it in
the other, as today.

The server cannot tell a note from an attachment, because an item's type sits
in its encrypted metadata. Two consequences follow.

- Leaving attachment content out of a pull has to go by size. Chunks under a
  threshold come inline and larger ones as references, which the client
  downloads when the attachment is opened. A new device no longer downloads
  every attachment up front.
- Account limits can only use what the server can count: bytes, spaces, members
  per space, blob size and sessions. It cannot count notes.

## Sync

- **An idle check is one request.** The collection list accepts a stoken and
  returns only the collections that changed. Checked against the reference
  server: it returns nothing when nothing changed, and returns the collection
  after an item is added to it.
- **A change feed makes it zero.** Each device holds one socket on which the
  server names the collections that changed and announces new invitations. It
  carries no data. The client reacts by running a normal sync. The periodic
  tick stays as a fallback, which mobile needs once the app is in the
  background.
- **Edits stop costing a request per note.** Before pushing, the client fetches
  each changed note one at a time. One batched fetch replaces that.
- **Stoken order must match commit order.** If two transactions commit out of
  order, a device whose cursor has already passed the slower one never sees it.
  One counter orders every change on the server, and a writer takes its lock
  as the last step before committing. A lock per collection would not be
  enough, because a single cursor covers every collection a client has. The
  price is that commits happen one at a time across the server. If that ever
  limits throughput, cursors can be handed out from a watermark of finished
  transactions instead.
- **An acknowledged push must survive a power cut.** The client clears a note's
  dirty flag when the server acknowledges it, so a lost commit would never be
  sent again. Commits are flushed to disk before they are acknowledged.
- **Mixed pages.** A pull can deliver a note before its folder. The existing
  pass that re-parents orphans should cover this and needs checking.

## Live rooms

A room is a collection plus an item. The server knows both, and it knows who is
a member at which access level.

1. The Rust side, which holds the session, asks the server for a ticket for one
   note. The ticket is signed, lasts about 30 seconds, and names the session
   and the room. Access is read from the database when the socket opens, so a
   ticket cannot carry access that has since changed.
2. The WebView opens the room socket with the ticket. The session token never
   reaches the WebView or a URL.
3. The server admits members and sends each socket a roster with usernames
   taken from sessions.
4. Each frame carries a class the server can see: an update to the document, a
   request for state, or presence. The server drops updates from read-only
   members. Receivers act on the class the server saw, so a read-only member
   cannot hide an update inside a presence frame.
5. When a member is removed or downgraded, the server closes or downgrades
   their sockets immediately. When a session ends, the sockets it opened close
   with it.

Frames stay encrypted under the per-note key. The server relays ciphertext and
never reads it.

What this removes:

- the join challenge and the room id that doubles as a public key
- the writer-key registry, its scan of the assets collection, and the backoff
  around refreshing it
- per-frame signatures and the replay guard
- the yjs-relay, excalidraw-room and nginx containers, and `socket.io-client`

What it adds for users: read-only members can watch live, and every note kind
gets presence from the roster.

**The trust this places in the server.** Today peers reject unauthorised writes
themselves. After this change the server does it, which is the same trust
Etebase already asks for at rest. A malicious server working with a read-only
member could inject live edits. It still could not read anything. The server
also learns which user is in which room, where the relay saw only opaque ids.

## Sharing

With one collection per space, sharing a folder is one invitation, one
membership and one accept. The bundling code and its partial states go, and so
does finding M5, because no manifest decides which room or collection a client
uses.

- **The name is visible before accepting.** It lives in the collection's own
  metadata. The server returns that metadata with the invitation, and the key
  inside the invitation decrypts it.
- **Invitations are pushed** over the change feed. Accepting triggers the first
  pull at once.
- **Member changes are one request** and take effect in open rooms
  immediately.
- **Recipient keys are pinned.** The client remembers the public key first seen
  for a username and warns when it changes. Without this a server could swap in
  its own key when a folder is shared. This weakness exists today.

### Invite links

An invite link lets someone join without the owner knowing their username, and
on a self-hosted server without an account existing beforehand.

- The owner's client creates a random secret and derives a keypair from it. The
  fork already supports deriving a box keypair from a seed.
- The owner sends an ordinary invitation to that keypair's public key. The
  server stores it with an expiry and a use limit.
- The link carries the link id and, in its fragment, the secret. The fragment
  never reaches the server.
- To claim, the recipient signs in, derives the keypair from the secret, opens
  the invitation as it would any other, and accepts. The server creates the
  membership and counts the use in one step.
- On a self-hosted server a link can also permit one signup.

Whoever holds the link can claim it until it is used up or expires. Links are
single-use by default.

It needs two new pieces: handling for links opened at the operating-system
level, and a landing page on the server for devices without the app.

As built on the server:

- The client derives a second key from the secret, one that signs, and gives
  the server its public half. Every request about a link carries a signature
  made with it over the action, the link id and the caller's username. A link
  id alone therefore gets nothing, which matters because ids pass through
  address bars, logs and chat previews. The fork already derives the login key
  from a seed this way.
- A link gives read or write access and never admin. It lasts a week unless
  told otherwise and 90 days at most. It lets in one person unless told
  otherwise and 100 at most.
- Looking at a link needs the secret and no account. The server returns the
  sender's name and key, the sealed collection key and the collection's own
  item, so the app can show who invites the person to what before they sign in
  or sign up.
- A link stops working when its maker stops being an admin of the space.
- The landing page is the same for every link and never looks one up.

| Route                              | Takes                            | Does                         |
| ---------------------------------- | -------------------------------- | ---------------------------- |
| `POST mindstream/link/`            | Session of an admin of the space | Makes a link                 |
| `GET mindstream/link/?collection=` | The same                         | Lists the links into a space |
| `DELETE mindstream/link/{id}/`     | The same                         | Removes one                  |
| `POST mindstream/link/{id}/open/`  | Proof of the secret              | Shows what the link leads to |
| `POST mindstream/link/{id}/claim/` | Session, proof of the secret     | Joins the space              |
| `GET /join/{id}`                   | Nothing                          | The page a browser shows     |

Signing up where signup is not open takes one of two things in the signup
request. One is a code an administrator made on the command line, good for one
account. The other is proof of a link that was made to allow it. The server's
signup setting has three values to match: `closed` takes codes only, `invite`
takes such links too, and `open` takes anyone.

## Accounts

### Device sessions

Signing in creates a session for that device. The server keeps a hash of its
token, a name and when it was last used, and the user can list and revoke
sessions.

This replaces the silent refresh. Today, when a token is rejected the app logs
in again with the stored main key and no user involved. That is
`run_with_reauth` in [sync/mod.rs](../src-tauri/src/sync/mod.rs). The key is
equivalent to the password, so the path would bypass a second factor. With
device sessions a rejected token means signing in again.

Ending a session closes its rooms and its change feed at once. Some changes
end sessions other than the caller's:

| Change                             | Sessions ended     |
| ---------------------------------- | ------------------ |
| Signing out, or being signed out   | That device's      |
| A new password                     | Every other device |
| An authenticator set up or changed | Every other device |
| A reset with the recovery key      | All of them        |
| The account disabled or deleted    | All of them        |

A new password ends the other sessions because a password is often changed on
the suspicion that someone else knows it.

### Two-factor sign-in

TOTP with the parameters every authenticator app honours: SHA-1, six digits, a
30 second step.

- The server asks for a code only after the password signature checks out, so
  it never reveals which accounts have a second factor. The code travels inside
  the signed login body.
- The server rejects a time step it has already accepted, and stores the
  secret encrypted, since a secret it has to verify cannot be hashed. The key
  for that lives outside the database, so a copy of the database alone does
  not yield anyone's codes.
- Five wrong codes lock an account's second factor for ten minutes. The
  devices already signed in keep working.
- Enrolment takes the password again and is in two steps: the server hands out
  a secret, and nothing changes until a code from it comes back. It then
  issues ten single-use backup codes.
- Changing the password, turning the second factor off, and regenerating the
  recovery key or the backup codes all ask for a code again.
- Second factors are stored in a generic table so passkeys can be added later.

What it protects: someone who has the password cannot get a session, so they
cannot download ciphertext, push changes or join rooms. It does not protect
content after a server breach, because the password alone still decrypts.

### Recovery key

The account's keys are one blob, a random account key plus the identity private
key, encrypted under a key derived from the password. The recovery key adds a
second copy of that blob, wrapped under a random secret shown once at signup.
The server stores the copy and a recovery public key.

A reset is the update a password change already sends, signed by the recovery
key instead of the old login key. The server then revokes every session, and
the client issues a new recovery key. A password change leaves the recovery
copy valid, because the blob itself does not change.

It takes two requests, because the client needs the recovery copy before it
can wrap the account keys under a new password. The first proves the recovery
key and the second factor and returns the copy with a grant good for ten
minutes. The second carries the grant, the new keys and the new recovery key.
The grant exists because a code works once, so the second request could not
show it again. The server refuses to keep a recovery key that has been used.

### Routes

"Password" below means a request signed with the key derived from it, the way
a login is. A code travels inside the signed body.

| Route                                     | Takes                                   | Does                                         |
| ----------------------------------------- | --------------------------------------- | -------------------------------------------- |
| `POST authentication/login/`              | Password, code if enrolled              | Opens a session                              |
| `POST authentication/change_password/`    | Session, password, code if enrolled     | Sets the new login key                       |
| `POST authentication/recover/`            | Recovery key, code if enrolled          | Returns the recovery copy and a grant        |
| `POST authentication/recover/complete/`   | Recovery key, the grant                 | Sets the new keys and opens a session        |
| `GET mindstream/security/`                | Session                                 | Says what the account has set up             |
| `POST mindstream/totp/enroll/`            | Session, password                       | Returns a secret to put in the authenticator |
| `POST mindstream/totp/confirm/`           | Session, a code from that authenticator | Turns it on and returns backup codes         |
| `POST mindstream/totp/disable/`           | Session, password, code                 | Turns it off                                 |
| `POST mindstream/backup-codes/`           | Session, password, code                 | Replaces the backup codes                    |
| `PUT mindstream/recovery/`                | Session, password, code if enrolled     | Sets or replaces the recovery key            |
| `GET mindstream/sessions/`                | Session                                 | Lists the devices signed in                  |
| `DELETE mindstream/sessions/{id}/`        | Session                                 | Signs one device out                         |
| `POST mindstream/sessions/revoke-others/` | Session                                 | Signs every other device out                 |

Replacing an authenticator also asks for a code, unless the session asking
signed in with one. That exception is the way back for someone who has lost
the authenticator and the backup codes and still has a signed-in device.
Signup accepts a recovery key in the same request, so an account never exists
without the one it was shown.

### Losing a factor

| Lost                           | Still have                  | Way back                                                         |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------- |
| Password                       | A signed-in device          | Set a new password there. The client does not need the old one.  |
| Password                       | Recovery key, second factor | The recovery flow sets a new password.                           |
| Authenticator                  | Password, a backup code     | Sign in with the backup code and enrol again.                    |
| Authenticator and backup codes | Password, signed-in device  | Re-enter the password on that device and enrol a new one.        |
| Authenticator and backup codes | Password only               | An administrator resets it when self-hosted. No path on managed. |
| Password and recovery key      | No signed-in device         | Server data is unrecoverable, by design.                         |

## Managed service

The `managed` server type currently points at Etebase's hosted service and is
not offered in the app. It will point at a deployment of this server.

- **Entitlements live in the database.** Each account has a plan and limits. A
  self-hosted server treats everyone as unlimited.
- **The owner of a space pays.** The server counts ciphertext bytes per space
  in the same transaction as the write and attributes them to the owner.
  Collaborators spend the owner's quota. When a space is full the server
  rejects pushes from everyone in it with a distinct error, and the app says
  whose storage is full.
- **A lapsed subscription means read-only.** Pulls and deletes keep working.
  Nothing is removed.
- **Member limits follow the owner's tier.** An invite link is checked against
  the limit when it is claimed.
- **Billing is a separate program.** It receives payment webhooks and writes
  entitlements. The server never sees payment data. It is not built. What it
  has to do, and a stand-in that sets plans by hand, are in
  [backend/billing](../backend/billing/README.md).
- **Both sides of a share must be on the same server.** A managed account
  cannot share with a self-hosted one.

Running a hosted service also brings duties this design only names: verifying
email addresses, deleting accounts on request, backups that can restore to a
point in time, and limits against abuse of open signup.

## Licensing and layout

- `backend/server` is AGPL. It is written fresh, from the protocol as the
  BSD-licensed client libraries speak it and from the reference server's
  observable behaviour. The owner stays the sole copyright holder, which keeps
  dual licensing possible and does not force the managed service to publish
  every change. Porting the reference server's source would give up both.
- A small crate holds the room protocol types. Both the app and the server link
  it, so it is MIT OR Apache-2.0.
- The app never depends on the server crate outside tests.
- Billing stays a separate program, outside the AGPL work.
- Outside contributions to the server need a decision before the first one
  arrives. Without a contributor agreement, relicensing is no longer possible.
- `src-tauri` stays its own Cargo package. A workspace at the repository root
  would move the target directory, which `test.yml` refers to by path.
- CI gets a path filter so server-only changes skip the app matrix.

This section is a reading of the licences, not legal advice.

## Security

Closed by this design:

- M4 and M5 in [security-review.md](security-review.md). The writer-key
  registry and the share manifest no longer exist.
- L4. The Etebase image is no longer used.

Newly owned:

- The auth endpoint, rate limits, size caps and every access check. All
  handlers go through one authorisation function, and its tests are generated
  from the route table.
- TOTP secrets and session token hashes at rest.
- The invite link claim path and the recovery path, the two places that grant
  access without the usual login.

Accepted:

- The server enforces write permission in rooms, as it already does at rest.
- The server sees who is in which room.
- A removed member keeps the keys they already had. The server stops serving
  them. This is how Etebase behaves at rest today.
- A link grants access to whoever holds it, until it is used or expires.
- With the authenticator and the backup codes lost and no signed-in device, a
  managed account cannot add a device again.

## Testing

- **Conformance.** The etebase-rs suite runs against a server named by
  `ETEBASE_TEST_HOST` and calls a reset route. The server serves that route in
  debug builds, and the suite gates the routes that keep their Etebase
  behaviour.
- **Comparison.** The same scripted session runs against the Python server and
  the new one, and the responses are compared field by field for error codes
  and paging. The Python server is a black box here and its source is not
  consulted.
- **In process.** The server starts inside `cargo test` on a free port, so sync
  and permission tests need a Postgres and nothing else. That covers the two
  tests
  [security-review.md](security-review.md) lists as missing: a read-only
  member cannot write, and a removed member loses access.
- **Benchmark.** `pnpm bench:backend`, in
  [e2e-tests/perf/backend-bench](../e2e-tests/perf/backend-bench/run.mjs). It
  replays the app's call sequences, so
  [vault.mjs](../e2e-tests/perf/backend-bench/vault.mjs) has to follow the
  client as the data layout changes. Two runs against the same server differ by
  10 to 40%.

Targets, none of them measured yet:

| Scenario                         | Today           | Target                     |
| -------------------------------- | --------------- | -------------------------- |
| Idle sync                        | 11 requests     | 1 request, 0 with the feed |
| Authenticated read               | 27 ms           | 2 ms or less               |
| Remote edit reaches other device | Up to one tick  | Under a second             |
| Open a note in a shared folder   | 7 requests      | 1 ticket request, no blobs |
| Push 1000 new notes, server time | 5.4 ms per note | Under 1 ms per note        |
| Relay frame                      | 0.7 ms          | No worse                   |

### Measured after step 1

Both stacks in Docker on the same machine, the same client, the same request
counts. Fewer requests come with step 2, when the app changes how it lays out
its data.

| Scenario                    | Etebase stack | New server |
| --------------------------- | ------------- | ---------- |
| Idle sync tick, 11 requests | 273 ms        | 15 ms      |
| Tick with one edited note   | 365 ms        | 22 ms      |
| Push 1000 new notes         | 5.9 s         | 0.63 s     |
| New device pulls 1250 notes | 3.2 s         | 0.27 s     |
| Push an 8 MiB attachment    | 1.18 s        | 0.38 s     |
| Pull an 8 MiB attachment    | 448 ms        | 197 ms     |
| Memory after startup        | 215 MiB       | 38 MiB     |
| Memory after the benchmark  | 443 MiB       | 194 MiB    |

Rooms, measured the same way against the two relays:

| Scenario                            | Old relays | New server |
| ----------------------------------- | ---------- | ---------- |
| Enter a room, first frame delivered | 50 ms      | 6 ms       |
| Frame, one sender to one receiver   | 0.68 ms    | 0.56 ms    |
| Frame to all of 32 peers            | 1.34 ms    | 1.12 ms    |
| Frames per second, one pair         | 65,000     | 70,000     |

About 45 ms of the old figure for entering a room is Docker Desktop delaying
a second write on a new connection, which the new handshake does not trigger.
The frame figures are within the run-to-run noise of each other.

## Build order

1. Server core: accounts, device sessions, collections, items and blobs on
   Postgres, with entitlements and byte counting in the schema from the start.
   The etebase-rs suite and the benchmark are the gates.
2. The app moves to one collection per space.
3. Rooms and the change feed. The old relays and the signature code go.
4. Invitations, then invite links.
5. Recovery key and two-factor sign-in.
6. Quota enforcement and the billing program.

## Not in scope

- Migrating data from an Etebase server
- Compatibility with stock Etebase servers or older app versions
- Sharing between servers
- A second server node
- Passkeys
- Tiers, prices and the payment provider

## Open points

1. **Key rotation on removal.** The collab epoch and salt exist to lock removed
   members out of rooms. With the server refusing them, this design drops both
   and does not rotate keys on removal. Confirm.
2. **Where the room key comes from when a note opens.** Today the per-note key
   is fetched from the server on every open. It could be cached locally, or
   derived from the collection key so no fetch is needed.
3. **Whether read-only members send presence**, so writers can see who is
   watching.
4. **Requests for state.** A joining client asks the room for the document, and
   today every writer answers to everyone. Addressing the reply to the
   requester and limiting how often a socket may ask would stop a join from
   fanning a whole document out to the room.
5. **The link's shape.** The `mindstream:` scheme is already taken inside the
   WebView for attachments, and nothing handles links at the operating-system
   level yet.
6. **Who may create links that permit signup** on a self-hosted server. The
   server leaves it to the operator. Under `invite` any admin of a space may.
   Under `closed`, the default, nobody may and the administrator hands out
   signup codes. Confirm the default.
7. **The recovery key's format**, and whether the app offers something to print
   or save.
8. **How long a device session lasts** when it is not used.
9. **The size under which content comes inline.**
10. **Email verification on managed**, and whether it gates the first sync.
11. **Whether the public repository carries a working billing program.** The
    proposal is that it does not. Enforcing limits and the interface that sets
    them stay in the public server, because the managed service runs that same
    server and self-hosters can use limits too. The program that talks to a
    payment provider would live in a private repository. It is of no use to
    someone hosting for themselves, it changes with prices and tiers that are
    nobody else's business, and how it catches abuse is better not published.
    It reaches the server only over HTTP, as any other program could, which is
    why this design treats it as outside the AGPL work. That last point is a
    reading of the licence and worth checking with someone qualified before
    the service takes money.
