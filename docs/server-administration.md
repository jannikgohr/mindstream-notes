# Sync server administration

Running a sync server once it is up: accounts, who may sign up, account
security, storage limits, backups and upgrades. To set one up, follow the
[self-hosting quick start](self-hosting.md). Every setting is listed in
[Server configuration](server-configuration.md).

The commands below run from `backend/server` against the compose stack. The
server binary manages accounts too, and needs the database variable and nothing
else.

## Accounts

```sh
docker compose exec server mindstream-server user list
docker compose exec server mindstream-server user disable <username>
docker compose exec server mindstream-server user enable <username>
docker compose exec server mindstream-server user delete <username>
```

Disabling an account ends its sessions and keeps its data. Deleting one removes
everything it owns on the server, shared folders included, for everyone they
are shared with too. The server never holds a
password or a key, so it cannot reset a password.

## Signing up

`MINDSTREAM_SIGNUP` says who may create an account.

| Value    | Who can sign up                                                         |
| -------- | ----------------------------------------------------------------------- |
| `closed` | Someone you gave a signup code                                          |
| `invite` | That, and someone holding an invite link that was made to allow signups |
| `open`   | Anyone who can reach the server                                         |

You cannot create an account for someone, because an account's keys are made on
that person's own device. A signup code is how you let one person in:

```sh
docker compose exec server mindstream-server signup-code create --note "for Ann"
docker compose exec server mindstream-server signup-code list
docker compose exec server mindstream-server signup-code revoke <id>
```

The code is printed once. It is good for one signup within a week, or within
`--days` of your choosing.

With `invite`, anyone with **Admin** access to a shared folder can make a link
that also lets its
holder sign up. Choose it when the people on your server should be able to
bring in others without asking you.

## Invite links

A shared folder can be shared by link as well as by username. A link is an address on
this server, `/join/<id>#<secret>`. Browsers keep the part after the `#` to
themselves, so the server never sees the secret and cannot open what the link
carries.

Opened in a browser, a link shows a page that tells the person to paste it into
the app. Route `/join/` through your reverse proxy along with `/api/`, or that
page will be missing.

## Account security

An account can require a code from an authenticator app when signing in. The
codes are standard TOTP, so Google Authenticator, Bitwarden, Aegis and the rest
all work. Setting it up returns ten single-use backup codes.

The authenticator secrets are the one thing the server stores that it can read
back, because checking a code takes the secret itself. They are sealed under a
key that is kept outside the database. Give it as `MINDSTREAM_SECRET_KEY`, 32
bytes as URL-safe base64, or let the server create one on first start in
`MINDSTREAM_SECRET_KEY_FILE`, which defaults to `secret.key` in the blob
directory.

Back that key up. Without it every authenticator set up so far stops working and
each of those accounts needs the reset below. Keep its backup apart from the
database's if you can. Someone holding both can make valid codes, though they
still need a password to use one.

Someone who has lost the authenticator and the backup codes, and has no device
still signed in, needs you:

```sh
docker compose exec server mindstream-server user reset-2fa <username>
```

Signing in then takes the password alone. Be sure the person asking owns the
account before you run it.

An account can also have a recovery key, which sets a new password when the old
one is forgotten. The server never sees it. It stores a public key and a second
copy of the account's keys that only the recovery key opens, and a reset with it
still asks for the code when the account has an authenticator. Without a
recovery key or a signed-in device, a forgotten password means the data on the
server cannot be read by anyone.

Each device that signs in gets its own session, which the user can list and end.
A new password or a new authenticator signs every other device out. A session
that no device has used for `MINDSTREAM_SESSION_IDLE_DAYS` ends by itself, so a
device that was put away or lost does not stay signed in for ever. A device that
is running syncs, and that counts as use.

## Limits

An account has no limits until it is given some:

```sh
docker compose exec server mindstream-server user limit <username> \
  --plan basic --storage-mib 1024 --max-spaces 10 --max-members 5 --max-item-mib 50
docker compose exec server mindstream-server user usage <username>
docker compose exec server mindstream-server user unlimit <username>
```

On the server, each vault that syncs to an account and each folder the account
shares is a collection, and `--max-spaces` limits how many the account may
own. A collection counts against its owner, whoever writes into it, and
`--max-members` counts the people in one, the owner included. Once a limit is
reached the server refuses what would add to it with status 402 and a code that
says which limit: `storage_full`, `item_too_large`, `space_limit`,
`member_limit`, or `plan_lapsed` for an account set to `--read-only`. Deletions
are always accepted, and nothing is ever removed to bring an account back under
a limit.

The server can only limit what it can count. It cannot tell a note from an
attachment, so there is no limit on the number of notes.

The app keeps what was refused on the device and sends it once there is room.
Until then it shows a notice that names the limit, and in a shared folder the
owner whose plan it is.

Storage that is no longer needed is given back. An item keeps its current
revision and the `MINDSTREAM_KEEP_REVISIONS` before it. Older revisions go when
a new one arrives, and a deleted item keeps only the record that it was deleted.
Content goes with the last revision that used it, from the database or the blob
directory, and stops counting against the owner at that moment. The exception
for deletions covers deletions only: a write that calls itself one and carries
content is held to the limits like any other.

### From another program

A billing system sets the same limits over HTTP. Set `MINDSTREAM_ADMIN_TOKEN`
and send it as a bearer token; without the variable the routes do not exist.

```sh
curl -X PUT http://localhost:3735/admin/v1/account/<username>/entitlements/ \
  -H "Authorization: Bearer $MINDSTREAM_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"plan":"basic","storageLimitBytes":1073741824,"maxSpaces":10,
       "maxMembersPerSpace":5,"maxItemBytes":52428800,"readOnly":false}'
curl http://localhost:3735/admin/v1/account/<username>/ \
  -H "Authorization: Bearer $MINDSTREAM_ADMIN_TOKEN"
curl -X DELETE http://localhost:3735/admin/v1/account/<username>/entitlements/ \
  -H "Authorization: Bearer $MINDSTREAM_ADMIN_TOKEN"
```

A field left out of the body is a limit not applied. This interface can set
limits and read usage, and nothing else: it cannot reach anything an account
stores. Keep it off the public internet all the same, by not routing `/admin/`
through the reverse proxy.

`MINDSTREAM_ADMIN_TOKEN` should be long and random (32 bytes from a generator,
base64-encoded); the admin interface answers unlimited guessing with nothing but
time, so entropy is the whole of its protection. Keep a copy where the billing
system reads it, and nowhere else.

The app reads the signed-in account's usage from `GET /api/v1/mindstream/usage/`.

## Backups

A server's data is in two compose volumes, and each is useless without the
other. Docker prefixes their names with the folder, so from `backend/server`
they are `server_postgres` and `server_blobs`.

- `postgres` holds the accounts, the encrypted items, and the chunks up to
  `MINDSTREAM_INLINE_CHUNK_BYTES`.
- `blobs` holds chunks larger than `MINDSTREAM_INLINE_CHUNK_BYTES`, and the
  authenticator secret key unless you gave one as `MINDSTREAM_SECRET_KEY`.

Take both at the same moment, for example with the server stopped
(`docker compose stop server`, then `docker compose start server`). Keep a copy
of `.env` too, and of the secret key if you set it there. See
[Account security](#account-security) for why the key matters.

## Upgrading

The steps are in the
[quick start](self-hosting.md#4-operations-and-backups): back up, pull, then
`docker compose up -d --build`.

Changes that need you to act before an upgrade will be listed here, newest
first. There are none yet.

## Threat model notes

What the server deliberately does not defend, so nobody is surprised:

- Usernames are enumerable: signing in names an account that either exists or
  not, and any signed-in account can look up others to address invitations.
  Usernames appear in sharing dialogs anyway.
- A removed member keeps the ciphertext they already synced. The server stops
  serving them anything new; forward secrecy needs the shared folder's key
  rotated among the remaining members, which the server cannot do for you.
- Live editing messages are opaque to the server. It enforces who may send
  which class of frame, but a malicious member with **Can view** access can
  stuff document bytes into
  presence frames; receivers must act on the frame class, never on anything
  inside the payload.
- Password guessing is held back per address (10 a minute by default) and per
  account (10 wrong passwords in 10 minutes). A botnet that spreads a few
  guesses per address per account stays under both; length and a second factor
  are what stop it.
