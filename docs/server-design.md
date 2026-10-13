# Sync server design

Status: agreed design, written 2026-10-12. Steps 1 to 5 of the
[build order](#build-order) are built, on the server in
[backend/server](../backend/server/README.md) and in the app, and the old
stack is gone from the repository.

- The vault is one collection and so is each shared folder. A sync opens
  with one request that says which of them changed.
- Live collaboration for every kind of note runs on the server's rooms. The
  app listens on the change feed and syncs when the server says something
  changed.
- A folder is shared by invitation or by invite link. A link opens from a
  browser into the app.
- The app signs up with a recovery key, signs in with a code, recovers an
  account, and has a panel for two-factor sign-in, the recovery key, the
  password and the devices signed in.

Of step 6 everything but billing is built. The server counts what an account
stores, refuses what goes over a limit, and has the interface that sets
limits. The app says which limit a sync ran into and whose plan it is. The
billing program is not built and will not be part of this repository, see
[decisions](#decisions).

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
| Managed  | Limits and the interface that sets them are public. The program that takes payment is private.          |

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

- The server cannot leave attachments out of a pull, and it does not try.
  A new device downloads them in the background along with the notes, as it
  always has. That was decided over the earlier idea of fetching an
  attachment when it is first opened.
- Account limits can only use what the server can count: bytes, spaces, members
  per space, blob size and sessions. It cannot count notes.

As built, the vault is one collection of type `mindstream.vault` and a
shared folder is one of type `mindstream.shared`. An app that synced with the
four vault collections of before starts over against the new one on its
first sync: its rows are detached from their old items and uploaded again,
and a row another device has already moved over is matched by its own id,
not uploaded twice.

A shared folder made before this cannot sync any more, because nothing reads
the four collections it was made of. A folder the account shared goes back
into its vault and can be shared again. A folder shared with the account is
removed from the device by its first sync, which finds that the server lists
no such share. The old collections stay on the server unused.

Locally a row belongs to a shared folder when its `share_scope_id` is the uid
of the folder's collection. The collection is found by that uid, in one
fetch, so there is no list of manifests to search and nothing a second
collection could claim. That is what closes M5.

The collection's own content is a small manifest: which folder is the root,
who shared it, and the epoch and salt that live sessions mix into their
keys. The folder's name is the collection's name.

One stream of mixed items cannot be applied in the order it arrives. The
server sends items in the order they last changed, so a folder renamed last
week comes after the notes it has held for a year, and an attachment comes
before the note it belongs to if the note was edited since. The pull handles
this in one of two ways:

- A change that fits one page is applied from that page, folders first, then
  notes, attachments and signatures. Nearly every sync is this.
- Anything larger, a first sync above all, is listed without content first.
  The content is then fetched kind by kind in batches. Each item is
  downloaded once, memory stays at one batch, and every folder is in place
  before the first note is applied.

### What is kept

An item keeps its current revision and a set number before it, ten unless the
operator says otherwise. Older revisions go when a new one arrives. The app's
note history lives on each device and does not use them.

A deleted item keeps only the record that it was deleted. The client sends
that record without the item's chunks, which is where this fork of the client
library departs from upstream: there the chunks stay on the tombstone and a
server has to hold their content for as long as the tombstone lives.

Content goes with the last revision that used it, from the database or the
blob store, and stops counting against the owner in the same transaction.
Chunks are shared between revisions, so a chunk is only removed once nothing
refers to it. Files are removed after the transaction commits. A crash in
between leaves a file nothing points to, never a row that points to nothing.

The exception that lets deletions past a full or lapsed plan holds for
deletions only. A revision that is marked deleted and still carries content
is a write.

## Sync

- **An idle check is one request.** The collection list accepts a stoken and
  returns only the collections that changed. Checked against the reference
  server: it returns nothing when nothing changed, and returns the collection
  after an item is added to it.

  Built. A sync opens by asking that list, for the vault and the shared
  folders at once, what changed since the account's cursor. It then visits
  the spaces the answer names and the ones this device has something to
  send to, and no others. A visit is what a sync always was: pull, then
  push. A sync that visits nothing is the one request.

  A collection counts as changed when an item in it did, when its own
  record did (a folder's name, or the key material of its live sessions),
  when a member's rights did, and for an account that has just joined it.
  A deleted collection is named as deleted, and one the account was taken
  out of is reported as lost. `idle_check_names_every_collection_a_device_has_to_visit`
  holds the server to each of these, since a case it missed would be a
  change no device goes to look for.

  Three rules keep the shortcut safe:
  - The account's cursor moves last, and only when everything the answer
    named was applied. A shared folder that failed, or a space still
    waiting for a row to be let go, keeps it where it was, so the next
    sync hears of the same spaces again.
  - The cursor is dropped whenever the app opens its database. The first
    sync of every run asks about everything, visits every space, and
    removes the shared folders the full list no longer has. A change that
    was somehow missed costs one restart at most.
  - What a sync pushed is past the cursor it saves. The next sync is told
    those spaces changed and pulls its own changes back, once.

  The reachability probe that used to go before every sync now goes only
  while the device does not know the server is there: before the first
  sync of a run, and after one that could not reach it. The probe gives up
  after six seconds, where a sync's own requests wait far longer, so
  being offline still costs one short question per tick. Once a sync has
  gone through, the list it opens with is the probe.

- **A change feed makes it zero.** Each device holds one socket on which the
  server names the collections that changed and announces new invitations. It
  carries no data. The client reacts by running a normal sync. The periodic
  tick stays as a fallback, which mobile needs once the app is in the
  background.
- **Edits stop costing a request per note.** Before pushing, the client fetches
  each changed note one at a time. One batched fetch replaces that.

  Built, for every kind of item and for deletions. A push builds the next
  revision of an item on the item as the server has it. It now asks for
  those by name, a batch per request. Only a note is asked for with its
  content, because the key of its live sessions is in there and has to be
  carried over. Folders, attachments, signatures and anything about to be
  deleted come as their revision alone, so replacing an 8 MiB attachment no
  longer downloads the old 8 MiB first. A change built on a revision that
  is no longer the latest is refused as before.

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
- **A list and its cursor come from one snapshot.** The collection list reads
  what changed, what was removed and the cursor it hands back in several
  statements. Under the default isolation a change committing between two of
  them is behind the new cursor without being in the answer, and the device
  never sees it. The list runs in one repeatable-read transaction.
- **A response has a size.** A response is built in memory, so the content it
  carries is held to a budget, 32 MiB unless set otherwise. A list ends its
  page early. A request for named items answers with content for as many as
  fit, from the first, and the uids of the chunks for the rest. The client
  asks for those again, which puts one of them first, and fetches chunk by
  chunk the item that comes first and still has no content. A fetch of one
  item does that inside the client library. A revision may name a chunk once.
- **What is acknowledged is on disk, files included.** A blob is written
  under another name, synced, renamed, and its directory synced before the
  upload is answered. The store is the `object_store` crate with syncing
  turned on, which also leaves the way open to S3. The key that seals the
  authenticator secrets is created the same way and by a hard link, which
  fails if the name is taken, so two servers starting at once cannot each
  write their own.

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

The server learns that a session or a membership ended from a notification
on a database connection, and that connection can drop. So it does not rely
on having heard:

- When the connection comes back, it asks the database about the session and
  the membership behind every open socket, room or feed.
- A socket is asked about once more after it is registered, because a session
  can end between being let in and being findable.
- Everything is asked about again every five minutes regardless.
- If nothing can be asked for a minute, every socket is closed with a code
  that tells the client to come back.

A peer that reads too slowly is dropped once more than a set amount is
waiting for it. The amount waiting is judged before a frame is added, so one
frame of the largest size the room accepts cannot by itself drop a peer that
was keeping up.

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
  inside the invitation decrypts it. Built: the client library's invitation
  preview carries the name, and the notification reads "Ann shared “Trip
  plans” with you". Reading it accepts nothing.
- **Invitations are pushed** over the change feed. Accepting triggers the first
  pull at once. Built: the feed's invitation flag makes the app list its
  invitations again, and accepting asks for a sync. The app also lists them
  again whenever the feed connects. An invitation that arrived while the
  socket was down is in no collection, so no sync brings it and no later
  message mentions it.
- **Only a shared folder is offered.** An invitation to a collection of any
  other type was made by another program. The app neither shows nor accepts
  it, so nobody can put a collection of their choosing among a user's.
- **The root is a claim.** The manifest names the folder at the top of the
  share, and whoever shares writes the manifest. A device marks a folder as
  the shared root only if that folder arrived through the share. Otherwise a
  manifest naming someone's own folder would mark it as shared with them,
  and on a read-only share lock them out of it.
- **Inviting someone else moves nothing.** Sharing a folder moves its rows
  into the folder's collection once. What is added later inherits the scope
  as it is added, so a second invitation has nothing to move. It used to
  delete and recreate every item for every member.
- **Member changes are one request** and take effect in open rooms
  immediately.
- **An invitation is only as good as its sender.** It is accepted on the
  authority of the admin who sent it. Accepting checks that the sender is
  still an admin of the space on an account that is still enabled, under the
  same lock that removing a member takes. An admin who is removed or
  downgraded has their pending invitations withdrawn. A claim on an invite
  link follows the same rule.
- **Keys are remembered.** The server hands out every public key: a
  recipient's when a folder is shared with them, a sender's with their
  invitation. A server that handed out a key of its own could read what is
  shared, or stand in for a sender. Nothing proves a key on first sight, so
  the app keeps the first key it relied on for a name on a server, in the
  local database, and holds back anything that comes with another one.
  - Inviting someone whose key changed creates and sends nothing. The dialog
    shows the key the server gives now and the key remembered, as digits,
    and the invitation goes out only when the user says to share with the
    new key.
  - An invitation from a changed key is shown with the same warning and both
    keys, and "Accept" becomes "Accept anyway". The backend refuses to accept
    it without that choice, so the rule does not rest on the UI.
  - A key is kept at the moment it is relied on: when an invitation to it is
    sent, or one from it is accepted. Looking at a key keeps nothing.
  - Account settings show the account's own key as the same digits. That is
    what two people compare, over another channel, to know the server gave
    each of them the other's real key. A key only changes when an account is
    made again, so a warning is rare and worth reading.
  - An invite link needs none of this. Its content is sealed to a key that
    only the link's holders can derive, so the server could not have made it.

**Who may write a row.** A pulled item says which local row it is by the id
in its payload, and ids travel with rows from space to space. That is what
lets a note keep its history when its folder is shared. It also means that
someone who can write to a folder shared with a user, and who knows the id of
one of that user's own notes, could put an item with that id into the shared
folder and have it overwrite the note and pull it into their folder. Ids are
random, so they have to be learned, for instance from a note that was once in
a folder the two shared.

The rule, in `sync::claim`: an item may write a row that is in its own space,
or one that its last home has let go of. A row is let go when the server
deletes its item while this device still holds edits to it. That is what a
note moving into a shared folder looks like from the owner's second device,
and it is the only case in which a row changes space through a pull. Any
other row of another space is out of reach, including one that is new on this
device and has not been uploaded yet. The same holds one level down: an
attachment is only attached to a note of its own space, and a deletion only
reaches rows of the space it came from.

Two things make the rule safe to enforce:

- **Deletions go up before creations, across every space.** A row that moves
  is a deletion in one space and a creation in another. A sync now pulls
  every space, then pushes every space's deletions, then everything new. So
  no device ever finds a row in two spaces, and refusing an item whose row is
  at home elsewhere never refuses a row that is legitimately on its way.
- **A refused item is tried again.** Spaces are pulled one after another, so
  a device can meet the creation before the deletion. Refused items are kept
  until every space has been pulled and then applied. If one is still
  refused, the space's cursor stays where it was and the next sync pulls the
  item again, three syncs at most. After that it is dropped and logged: it
  was not a row on its way anywhere.

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
level, and a landing page on the server for devices without the app. Both are
built, see below.

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

As built in the app:

- **Making one.** The links of a folder are in its access dialog, below the
  members. The owner of a folder and its admins see them. A link is shown
  once, when it is made, because its secret is in its text and nowhere else.
  The list afterwards shows each link's rights, how often it was used and
  when it ends, and removes one. Making a link to a folder that is not shared
  yet shares it, the same way the first invitation does.
- **Joining by one.** "Join shared folder…" is in the file tree's background
  menu, in the shared view too. The dialog takes two steps so that nobody
  joins something unseen. It first shows who invites to which folder with
  which rights, then joins. Joining creates nothing on the device. The sync
  it starts pulls the folder in like any other shared folder.
- **Signing up by one.** The signup code field also takes a link. The form
  then sends the link in place of a code, and the new account joins the
  folder. A link is only good on the server that made it, so the form holds
  back a link for another server and offers to switch to that server.
- **What the app refuses.** A link to a collection that is not a shared
  folder is never opened or joined, for the reason such an invitation is
  never shown. A link for a server the device is not signed in to is looked
  at and not joined.

- **Opening one from outside the app.** A link is a web address on whatever
  server made it, so a browser opens it and shows the server's page for
  links. That page offers the same link under the app's own scheme,
  `mindstream-notes://join?link=…`, built in the browser and sent nowhere.
  The operating system hands such an address to the app: as its argument
  when that starts the app, and through the instance already running when
  there is one. The app then comes to the front with the join dialog open and
  the link filled in.

  It does no more than that. Any program on the device can open an address
  under the scheme, with any link inside, so nothing is asked of a server
  until the user presses "Continue". An address that carries no invite link
  opens nothing.

  The desktop app is a single instance now, which this needs: a second
  launch hands its arguments to the first and ends. Builds that run on a
  data directory of their own, as the test suite's devices and a
  developer's second vault do, are left out.

  The installer registers the scheme. The app never registers it at run
  time, so a build run from a checkout cannot take the scheme away from the
  installed app. What an invite link and the app's address look like is
  written down in [protocol/links](../protocol/links), with examples that
  the client library, the app's window, the app's start-up code and the
  server's page are each tested against.

Tried on a real build: starting the app with a link as its argument, and
starting it a second time with one while it runs. Not tried: the installer's
registration and a click in a browser, which need the app installed. Mobile
is not covered. A phone opens links through verified web addresses, one
domain at a time, which a self-hosted server does not have.

## Accounts

### Device sessions

Signing in creates a session for that device. The server keeps a hash of its
token, a name and when it was last used, and the user can list and revoke
sessions.

This replaces the silent refresh. The app used to answer a rejected token by
logging in again with the stored main key, with no user involved. The key is
equivalent to the password, so that path would have bypassed a second factor
and undone every row of the table below. It is gone. A sync that meets a
rejected token signs the device out, keeps its notes, and says so in a
notification. That is `run_session` in
[sync/mod.rs](../src-tauri/src/sync/mod.rs) and `end_session_locally` in
[auth/mod.rs](../src-tauri/src/auth/mod.rs). The change feed asks for that
sync the moment the server closes its socket, so the device notices within a
second.

A device names itself when it signs in: the app, the machine's name where the
system gives one, and the system. The list of devices shows that name.

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

Everything that reads an account's credentials and then acts on them takes
the account's row lock first: signing in, a new password, setting up or
removing an authenticator, a reset with the recovery key, and the
administrator's reset. Without it a sign-in that verified the old password
could create its session after the password change had ended the others, and
the old password would have outlived its replacement.

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

As built in the client library and the app:

- The recovery key is 32 random bytes. The client derives two keys from it
  the way it does from the password's key: one wraps the copy of the account
  keys, the other signs a recovery request. The server stores the copy and
  the public half of the signing key.
- It is shown as 56 letters and digits in fourteen groups of four. The last
  characters are a checksum, so a typing mistake is caught on the device and
  costs no attempt at the server. Case, spaces and dashes do not matter when
  it is typed back.
- The app shows it once, with a button to copy it, and does not go on until
  the user says it is stored. The window is not reloaded before that, and the
  key survives closing the settings dialog by accident.
- A signed-in account can replace its key with the password, and a code if it
  has a second factor. That is also the answer to a key that was never
  written down.

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
- **A limit is not a failed sync.** The server answers a write that goes over
  a limit with status 402 and a word for the limit. The app pulls as usual,
  pushes the spaces that have room, and leaves what was refused where it is,
  to go up with the first sync that can take it. It shows one notice for as
  long as the limit holds. For the account's own plan the notice says so.
  In a folder someone else shared it names the folder and its owner, because
  the person typing can only ask them. The dialogs for sharing, inviting,
  accepting and joining have a sentence for each limit too.

  Two things about this are rough. A device that is over a limit asks again
  with every sync, which costs two requests each time. And a push is one
  transaction for each kind of thing, so one attachment that is too large
  holds back the other attachments in the same space until it is removed.

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
- The room protocol is written down once, in [protocol/room](../protocol/room),
  under MIT OR Apache-2.0. The plan was a small crate that the app and the
  server both link. A crate would not have covered the side that matters:
  frames are decoded in the web view, in TypeScript, and the fake server the
  app's unit tests use is TypeScript too. So the shared thing is a file with
  the numbers, example frames and one scripted conversation, and each side
  has a test that reads it: the server's hub, the server over real sockets,
  the app's room socket and the fake server. Changing the protocol means
  changing the file first, and the tests say which side has not followed.
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
- How many connections it takes. nginx used to cap these per address. The
  server now counts open connections and, separately, open sockets, per
  address and in all. An IPv6 caller is its /64. A trusted proxy is exempt
  from the connection count and the clients it forwards are not. An account
  may hold 32 change feeds and a session 4.
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

Targets, set before anything was built, and where each stands. "Before" is the
Etebase stack with the app as it was.

| Scenario                         | Before          | Target                     | Measured                              |
| -------------------------------- | --------------- | -------------------------- | ------------------------------------- |
| Idle sync                        | 11 requests     | 1 request, 0 with the feed | 1 request, 2 ms                       |
| Authenticated read               | 27 ms           | 2 ms or less               | About 2 ms                            |
| Remote edit reaches other device | Up to one tick  | Under a second             | Not timed. The e2e suite waits for it |
| Open a note in a shared folder   | 7 requests      | 1 ticket request, no blobs | 3 requests, no blobs                  |
| Push 1000 new notes, server time | 5.4 ms per note | Under 1 ms per note        | 0.63 ms per note                      |
| Relay frame                      | 0.7 ms          | No worse                   | 0.57 ms                               |

Opening a note in a shared folder is still three requests and not one: the
note's own key lives in its item, so the item and its collection are fetched
before the ticket is asked for. See open point 2.

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

### Measured after step 2

The same server twice, on the same machine on the same day. The first column
replays what the app asked for before: four collections for the vault, four
more for each shared folder, every one of them visited on every sync. The
second is the app as built: one collection per space, one request to ask what
changed, and the items a push changes fetched by the batch. The request counts
are exact. Times are the median of 20, and differ by 10 to 40% between runs.

| Scenario                                 | Old layout         | As built          |
| ---------------------------------------- | ------------------ | ----------------- |
| Idle sync tick                           | 11 requests, 17 ms | 1 request, 2 ms   |
| Idle tick with one shared folder         | 18 requests, 27 ms | 1 request, 2 ms   |
| Tick with one new note                   | 12 requests, 24 ms | 3 requests, 12 ms |
| Tick with one edited note                | 13 requests, 25 ms | 4 requests, 14 ms |
| Tick that receives another device's edit | 11 requests, 16 ms | 2 requests, 4 ms  |
| First sync of a new account              | 15 requests, 44 ms | 5 requests, 20 ms |
| Push 25 edited notes                     | 26 requests, 80 ms | 2 requests, 30 ms |
| Open a note in a shared folder           | 8 requests, 31 ms  | 3 requests, 10 ms |

Against the Etebase stack an idle tick took 273 ms, so the two steps together
bring it to under a hundredth of that. Most of it came with the server in
step 1. What step 2 adds is that the cost stops growing with the number of
shared folders, and that a device with a slow link makes one round trip
where it made eleven.

Not everything got better:

- Pushing 100 new notes is one request either way.
- A new device's first pull of 220 notes is six requests where it was five,
  because a first pull now lists without content and then fetches by kind.
  That keeps memory at one batch and applies folders before the notes in them.
- A sync that sends something is one request more than it needs: the next
  sync is told that space changed and pulls the device's own change back.

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
   members out of rooms. With the server refusing them, this design proposed
   to drop both. The app still has them: it gives a folder a new salt when a
   member is removed or made read-only, and the others reconnect their rooms
   once they have synced it. Whether to keep that is not decided.

   What the salt adds is small. It is stored in the collection, under the
   collection key, and that key is never changed. A removed member keeps
   the key, so the new salt is out of their reach only for as long as the
   server refuses to hand them the collection. That is the same server that
   refuses them the room. And what is typed in a room is synced to the
   collection moments later, under keys the removed member also kept.

2. **Where the room key comes from when a note opens.** Today the per-note key
   is fetched from the server on every open. It could be cached locally, or
   derived from the collection key so no fetch is needed.
3. **Whether read-only members send presence**, so writers can see who is
   watching.
4. **Requests for state.** A joining client asks the room for the document, and
   today every writer answers to everyone. Addressing the reply to the
   requester and limiting how often a socket may ask would stop a join from
   fanning a whole document out to the room.
5. **The link's shape.** Settled. A link is a web address on its server, and
   the app answers to `mindstream-notes://join?link=…`. See
   [invite links](#invite-links).
6. **Who may create links that permit signup** on a self-hosted server. The
   server leaves it to the operator. Under `invite` any admin of a space may.
   Under `closed`, the default, nobody may and the administrator hands out
   signup codes. Confirm the default.
7. **Printing or saving the recovery key.** The format is settled, see
   [recovery key](#recovery-key). The app offers a copy button and nothing
   else. A file to save or a page to print is still open.
8. **How long a device session lasts** when it is not used.
9. **The size under which content comes inline.**
10. **Email verification on managed**, and whether it gates the first sync.
11. **Whether the public repository carries a working billing program.**
    Decided for now, on 2026-10-13, that it does not. Enforcing limits and the
    interface that sets them stay in the public server, because the managed
    service runs that same server and self-hosters can use limits too. The
    program that talks to a payment provider lives in a private repository
    once there is one. It is of no use to
    someone hosting for themselves, it changes with prices and tiers that are
    nobody else's business, and how it catches abuse is better not published.
    It reaches the server only over HTTP, as any other program could, which is
    why this design treats it as outside the AGPL work. That last point is a
    reading of the licence and worth checking with someone qualified before
    the service takes money.
