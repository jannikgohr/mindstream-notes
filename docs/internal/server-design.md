# Sync server design

The sync server in [backend/server](../../backend/server/README.md) is one Rust
program on Postgres. It holds storage, accounts and the live rooms for every
kind of note. The app talks to it through the
[etebase-rs fork](../../vendor/etebase-rs), so what Etebase encrypts and signs,
and how, is unchanged: the account keys, collection and item encryption,
chunking and the invitation exchange. Everything around that is this server's
own: which routes exist, what they batch, what it pushes and how the app lays
its data out.

Running and configuring it is in [self-hosting](../self-hosting.md),
[server configuration](../server-configuration.md) and
[server administration](../server-administration.md). Its tests are in
[developing the sync server](server-development.md).

## Decisions

| Area     | Decision                                                                                              |
| -------- | ----------------------------------------------------------------------------------------------------- |
| Client   | Keep the Etebase client library and its encryption. Stock Etebase servers need not work with the app. |
| Server   | One server hosts storage, auth and the live rooms for every note kind.                                |
| Server   | Written in Rust, fresh, not ported from the Python reference server.                                  |
| Server   | Postgres is the only database, for self-hosted and managed alike.                                     |
| Server   | Licensed AGPL. The app stays MIT OR Apache-2.0.                                                       |
| Data     | One collection per space: one for the vault and one for each shared folder.                           |
| Rooms    | The server enforces write permission. Peers do not check signatures.                                  |
| Rooms    | No key changes when a member is removed. The server keeps them out of the folder and its rooms.       |
| Sharing  | Invite links, including signup on self-hosted servers.                                                |
| Accounts | Sessions are per device. There is no silent token refresh.                                            |
| Accounts | Two-factor sign-in with TOTP, compatible with the common authenticator apps.                          |
| Accounts | A recovery key. Recovery still requires the second factor when one is enrolled.                       |
| Accounts | No reset of the second factor by email.                                                               |
| Accounts | A signed-in device plus the re-entered password may enrol a new authenticator.                        |
| Managed  | The `managed` server type will run on this server, with account limits, paid subscriptions and tiers. |
| Managed  | The owner of a space pays for its storage. Collaborators need no paid account.                        |
| Managed  | Limits and the interface that sets them are public. The program that takes payment is private.        |

## Shape

- **One source of truth.** Sessions, membership and commits live in one
  process. A commit publishes the collection and its new stoken, which feeds
  the change feed. A membership change reaches the rooms the same way, so the
  server can close that member's sockets at once.
- **Small chunks in the database, large ones in the blob store.** A note is
  usually one small chunk. The large chunks of one upload are written as a
  single blob, so an attachment costs one write and one flush to disk.
- **Ready for a second node without running one.** Tickets are signed and
  short-lived, not held in memory. The change feed can ride on Postgres
  notifications. Rooms run on one node, and routing by room is the later
  step.
- **A version handshake.** Self-hosters upgrade the app and the server
  separately, so each side learns the other's protocol level and says clearly
  when one of them needs updating.

## Data layout

Each space is one collection. The vault is a collection of type
`mindstream.vault` and each shared folder one of type `mindstream.shared`.
Folders, notes, attachments and signatures are item types inside it. A note
belongs to exactly one space. Moving it into or out of a shared folder deletes
it from one collection and creates it in the other.

The server cannot tell a note from an attachment, because an item's type sits
in its encrypted metadata. Two consequences follow:

- The server cannot leave attachments out of a pull, and it does not try. A
  new device downloads them in the background along with the notes.
- Account limits can only use what the server can count: bytes, spaces, members
  per space, blob size and sessions. It cannot count notes.

Locally a row belongs to a shared folder when its `share_scope_id` is the uid
of the folder's collection. The collection is found by that uid in one fetch,
so there is no list of manifests to search and nothing a second collection
could claim.

The collection's own content is a small manifest: which folder is the root and
who shared it. The folder's name is the collection's name.

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

A write stores its file before the rows that point into it, and removes the
file again when it fails before committing. Whatever is left all the same, by
a crash or by a commit whose answer was lost, is found by a sweep every six
hours: a file older than a day that no row points into goes.

The exception that lets deletions past a full or lapsed plan holds for
deletions only. A revision that is marked deleted and still carries content
is a write.

## Sync

- **An idle check is one request.** A sync opens by asking the collection
  list, for the vault and the shared folders at once, what changed since the
  account's cursor. It then visits the spaces the answer names and the ones
  this device has something to send to, and no others. A visit is a pull,
  then a push. A sync that visits nothing is the one request.

  A collection counts as changed when an item in it did, when its own record
  did (a folder's name, or the key material of its live sessions), when a
  member's rights did, and for an account that has just joined it. A deleted
  collection is named as deleted, and one the account was taken out of is
  reported as lost. `idle_check_names_every_collection_a_device_has_to_visit`
  holds the server to each of these, since a case it missed would be a change
  no device goes to look for.

  Three rules keep the shortcut safe:
  - The account's cursor moves last, and only when everything the answer
    named was applied. A shared folder that failed, or a space still waiting
    for a row to be let go, keeps it where it was, so the next sync hears of
    the same spaces again.
  - The cursor is dropped whenever the app opens its database. The first sync
    of every run asks about everything, visits every space, and removes the
    shared folders the full list no longer has. A change that was somehow
    missed costs one restart at most.
  - What a sync pushed is past the cursor it saves. The next sync is told
    those spaces changed and pulls its own changes back, once. That costs one
    request more than needed.

  The reachability probe goes only while the device does not know the server
  is there: before the first sync of a run, and after one that could not reach
  it. The probe gives up after six seconds, where a sync's own requests wait far
  longer, so being offline costs one short question per tick. Once a sync has
  gone through, the list it opens with is the probe.

- **A change feed makes it zero.** Each device holds one socket on which the
  server names the collections that changed and announces new invitations. It
  carries no data. The client reacts by running a normal sync. The periodic
  tick stays as a fallback, which mobile needs once the app is in the
  background.
- **A push fetches what it builds on by the batch.** A push builds the next
  revision of an item on the item as the server has it, and asks for those by
  name, a batch per request. Notes come as their revision alone when the key of
  their live sessions is already on the device, from this sync's pull or the
  sealed cache. The cached key must name the same item and revision; otherwise
  the content is fetched to read its current key. Folders, attachments,
  signatures and anything about to be deleted come as their revision alone
  too, so replacing an 8 MiB attachment does not download the old 8 MiB first.
  A conflict retry reuses the item it fetched to merge.
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
   cannot hide an update inside a presence frame. Read-only members do send
   presence, so writers see who is watching.
5. A joining client asks the room for the document. Each writer answers the one
   who asked and nobody else, and the server passes on ten requests for state
   per socket in ten seconds and drops the rest.
6. When a member is removed or downgraded, the server closes or downgrades
   their sockets immediately. When a session ends, the sockets it opened close
   with it. When a note or its collection is deleted, which is how an owner
   stops sharing a folder, its rooms close and no ticket opens them again.

The server learns that a session or a membership ended from a notification
on a database connection, and that connection can drop. So it does not rely
on having heard:

- When the connection comes back, it asks the database about the session and
  the membership behind every open socket, room or feed, and whether the note
  behind each room is still there.
- A socket is asked about once more after it is registered, because a session
  can end between being let in and being findable.
- Everything is asked about again every five minutes regardless.
- If nothing can be asked for a minute, every socket is closed with a code
  that tells the client to come back.

A peer that reads too slowly is dropped once more than a set amount is
waiting for it. The amount waiting is judged before a frame is added, so one
frame of the largest size the room accepts cannot by itself drop a peer that
was keeping up.

Frames stay encrypted under the per-note key, which comes from the note alone.
The server relays ciphertext and never reads it. A sync brings every note's key
with the note, and the device keeps it in a table of its own, sealed under a
key derived from the secret the operating system's keystore holds for the
signed-in session. Opening a note reads it there and asks the server for the
ticket alone. Signing out deletes the secret and the rows, so a signed-out
device has nothing it could enter a room with. A backup leaves the table out.
Deriving the room key from the collection's key instead was not taken: it
changes what a key is derived from for a saving the kept key already makes.

**The trust this places in the server.** The server, not the peers, rejects
unauthorised writes, which is the same trust Etebase asks for at rest. A
malicious server working with a read-only member could inject live edits. The
server on its own still cannot read anything. It also learns which user is in
which room.

## Sharing

Sharing a folder is one invitation, one membership and one accept.

- **The name is visible before accepting.** It lives in the collection's own
  metadata. The server returns that metadata with the invitation, and the key
  inside the invitation decrypts it. Reading it accepts nothing.
- **Invitations are pushed** over the change feed, and the app lists them
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
  as it is added, so a second invitation has nothing to move.
- **Member changes are one request** and take effect in open rooms
  immediately.
- **Only an admin changes the folder itself.** The collection's own item
  holds the folder's name and the manifest, and marking it deleted ends the
  share. Writing it takes admin access, as inviting and removing members do,
  not just write access to the folder's notes. Marking it deleted takes the
  owner, who pays for what it holds.
- **Stopping sharing takes everyone else out.** Deleting the collection ends
  every membership but the owner's, the way removing a member does, so the
  server stops serving the others and their devices are told. Invitations
  not yet answered and links not yet used are withdrawn.
- **A deleted collection is gone for good.** Everything in it but its own
  item is dropped in the same transaction, and stops counting against the
  owner, as a space and in bytes. The app has moved the owner's copy into
  the vault by then. Nothing more can be written to it, chunks, invitations
  and links included: the only write it takes is its own item, deleted
  again.
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
  - Inviting someone whose key changed creates and sends nothing until the
    user, shown both keys as digits, says to share with the new key.
  - An invitation from a changed key is shown with the same warning, and the
    backend refuses to accept it without that choice, so the rule does not
    rest on the UI.
  - A key is kept at the moment it is relied on: when an invitation to it is
    sent, or one from it is accepted. Looking at a key keeps nothing.
  - Account settings show the account's own key as the same digits, for two
    people to compare over another channel. A key only changes when an
    account is made again, so a warning is rare and worth reading.
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
  is a deletion in one space and a creation in another. A sync pulls every
  space, then pushes every space's deletions, then everything new. So no
  device ever finds a row in two spaces, and refusing an item whose row is at
  home elsewhere never refuses a row that is legitimately on its way.
- **A refused item is tried again.** Spaces are pulled one after another, so
  a device can meet the creation before the deletion. Refused items are kept
  until every space has been pulled and then applied. If one is still
  refused, the space's cursor stays where it was and the next sync pulls the
  item again, three syncs at most. After that it is dropped and logged: it
  was not a row on its way anywhere.

### Invite links

An invite link lets someone join without the owner knowing their username, and
on a self-hosted server without an account existing beforehand.

- The owner's client creates a random secret and derives a box keypair from
  it, then sends an ordinary invitation to that keypair's public key. The
  server stores it with an expiry and a use limit.
- The link carries the link id and, in its fragment, the secret. The fragment
  never reaches the server.
- The client derives a second key from the secret, one that signs, and gives
  the server its public half. Every request about a link carries a signature
  made with it over the action, the link id and the caller's username. A link
  id alone therefore gets nothing, which matters because ids pass through
  address bars, logs and chat previews.
- To claim, the recipient signs in, derives the keypair from the secret, opens
  the invitation as it would any other, and accepts. The server creates the
  membership and counts the use in one step.
- Looking at a link needs the secret and no account, so the app can show who
  invites the person to what before they sign in or sign up.
- A link gives read or write access and never admin. It stops working when its
  maker stops being an admin of the space.
- The landing page is the same for every link and never looks one up.

Signing up where signup is not open takes one of two things in the signup
request: a code an administrator made on the command line, good for one
account, or proof of a link that was made to allow it. `closed`, the default,
takes codes only; `invite` takes such links too, and any admin of a space may
make one; `open` takes anyone. The app holds back a link for another server
and offers to switch to it, and never opens or joins a link to a collection
that is not a shared folder.

**Opening one from outside the app.** A link is a web address on the server
that made it, so a browser opens it and shows the server's page. That page
offers the same link under the app's own scheme,
`mindstream-notes://join?link=…`, built in the browser and sent nowhere. The
operating system hands such an address to the app: as its argument when that
starts the app, and through the instance already running when there is one.

- Any program on the device can open an address under the scheme, with any
  link inside, so nothing is asked of a server until the user presses
  "Continue". An address that carries no invite link opens nothing.
- The desktop app is a single instance for this: a second launch hands its
  arguments to the first and ends. Builds that run on a data directory of
  their own, as the test suite's devices and a developer's second vault do,
  are left out.
- The installer registers the scheme. The app never registers it at run time,
  so a build run from a checkout cannot take the scheme away from the
  installed app.
- Mobile is not covered. A phone opens links through verified web addresses,
  one domain at a time, which a self-hosted server does not have.

What an invite link and the app's address look like is written down in
[protocol/links](../../protocol/links), with examples that the client library,
the app's window, the app's start-up code and the server's page are each tested
against.

## Accounts

### Device sessions

Signing in creates a session for that device. The server keeps a hash of its
token, a name and when it was last used. A session no device has used for a
number of days ends by itself (`MINDSTREAM_SESSION_IDLE_DAYS`); a running
device syncs, which counts as use.

There is no silent refresh. A rejected token is never answered by logging in
again with the stored main key: the key is equivalent to the password, so
that path would bypass a second factor. A sync that meets a rejected token
signs the device out, keeps its notes, and says so in a notification. That is
`run_session` in [sync/mod.rs](../../src-tauri/src/sync/mod.rs) and
`end_session_locally` in [auth/mod.rs](../../src-tauri/src/auth/mod.rs). The
change feed asks for that sync the moment the server closes its socket, so the
device notices within a second.

Ending a session closes its rooms and its change feed at once. A new password
or a new authenticator ends every other session, since a password is often
changed on the suspicion that someone else knows it. A reset with the recovery
key, or the account being disabled or deleted, ends all of them.

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
  the signed login body, and each signed request answers a challenge of its
  own that the server takes once.
- The server rejects a time step it has already accepted, and stores the
  secret encrypted, since a secret it has to verify cannot be hashed. The key
  for that lives outside the database, so a copy of the database alone does
  not yield anyone's codes.
- After five wrong codes within ten minutes of the first, the account's second
  factor is locked until those ten minutes are up. The counts live in memory
  and reset when the server restarts. Devices already signed in keep working.
- Enrolment takes the password again and is in two steps: the server hands out
  a secret, and nothing changes until a code from it comes back.
- Replacing an authenticator asks for a code, unless the session asking
  signed in with one. That exception is the way back for someone who has lost
  the authenticator and the backup codes and still has a signed-in device.
- Second factors are stored in a generic table so passkeys can be added later.

What it protects: someone who has the password cannot get a session, so they
cannot download ciphertext, push changes or join rooms. It does not protect
content after a server breach, because the password alone still decrypts.

### Recovery key

The account's keys are one blob, a random account key plus the identity private
key, encrypted under a key derived from the password. The recovery key is 32
random bytes. The client derives two keys from it: one wraps a second copy of
that blob, the other signs a recovery request. The server stores the copy and
the public half of the signing key. A password change leaves the recovery copy
valid, because the blob itself does not change.

A reset takes two requests, because the client needs the recovery copy before
it can wrap the account keys under a new password. The first proves the
recovery key and the second factor and returns the copy with a grant good for
ten minutes. The second carries the grant, the new keys and a new recovery
key. The grant exists because a code works once, so the second request could
not show it again. The server then revokes every session and refuses to keep a
recovery key that has been used.

The app sends the recovery key in the signup request itself, so an account it
creates never exists without the one it was shown. The server also accepts a
signup without one. With the password and the recovery key
lost and no signed-in device, the data on the server is unrecoverable, by
design.

## Managed service

The `managed` server type points at a placeholder address that does not
resolve and is not offered in the app. It will point at a deployment of this
server.

- **The owner of a space pays.** The server counts what each space stores,
  ciphertext and the keys, names and references with it, in the same
  transaction as the write and attributes it to the owner. Collaborators spend
  the owner's quota. A self-hosted server treats everyone as unlimited unless
  the operator sets limits.
- **A lapsed subscription means read-only.** Pulls and deletes keep working.
  Nothing is removed.
- **A limit is not a failed sync.** The server answers a write that goes over
  a limit with status 402 and a word for the limit. The app pulls as usual,
  pushes the spaces that have room, and leaves what was refused where it is,
  to go up with the first sync that can take it. It shows one notice for as
  long as the limit holds. In a folder someone else shared it names the folder
  and its owner, because the person typing can only ask them.

  Two things about this are rough. A device that is over a limit asks again
  with every sync, which costs two requests each time. And a push is one
  transaction for each kind of thing, so one attachment that is too large
  holds back the other attachments in the same space until it is removed.

- **Both sides of a share must be on the same server.** A managed account
  cannot share with a self-hosted one.
- **Email verification** is put off until there is a managed deployment to
  verify addresses for.

Running a hosted service also brings duties this design only names: verifying
email addresses, deleting accounts on request, backups that can restore to a
point in time, and limits against abuse of open signup.

### Billing

Billing is a separate program that receives payment webhooks and writes
entitlements through the admin interface. It is not built. What it has to do,
and a stand-in that sets plans by hand, are in
[backend/billing](../../backend/billing/README.md).

The public repository does not carry a working billing program. Enforcing
limits and the interface that sets them stay in the public server, because the
managed service runs that same server and self-hosters can use limits too. The
program that talks to a payment provider will live in a private repository. It
is of no use to someone hosting for themselves, it changes with prices and
tiers that are nobody else's business, and how it catches abuse is better not
published. It reaches the server only over HTTP, as any other program could,
which is why this design treats it as outside the AGPL work. That last point
is a reading of the licence and worth checking with someone qualified before
the service takes money.

## Licensing and layout

- `backend/server` is AGPL. It is written fresh, from the protocol as the
  BSD-licensed client libraries speak it and from the reference server's
  observable behaviour. The owner stays the sole copyright holder, which keeps
  dual licensing possible and does not force the managed service to publish
  every change. Porting the reference server's source would give up both.
- The room protocol is written down once, in [protocol/room](../../protocol/room),
  under MIT OR Apache-2.0. Frames are decoded in the web view, in TypeScript,
  and the fake server the app's unit tests use is TypeScript too, so a shared
  crate would not cover the side that matters. The shared thing is a file with
  the numbers, example frames and one scripted conversation, and each side has
  a test that reads it: the server's hub, the server over real sockets, the
  app's room socket and the fake server. Changing the protocol means changing
  the file first, and the tests say which side has not followed.
- The app never depends on the server crate outside tests.
- Billing stays a separate program, outside the AGPL work.
- Outside contributions to the server need a decision before the first one
  arrives. Without a contributor agreement, relicensing is no longer possible.
- `src-tauri` stays its own Cargo package. A workspace at the repository root
  would move the target directory, which `test.yml` refers to by path.
- CI has a path filter so server-only changes skip the app matrix.

This section is a reading of the licences, not legal advice.

The risks this design accepts are in the
[security review](security-review.md#accepted-not-fixed).

## Not in scope

- Migrating data from an Etebase server
- Compatibility with stock Etebase servers or older app versions
- Sharing between servers
- A second server node
- Passkeys
- Tiers, prices and the payment provider
