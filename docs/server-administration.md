# Sync server administration

Running a sync server once it is up: accounts, who may sign up, account
security, storage limits, backups and upgrades. To set one up, follow the
[self-hosting quick start](self-hosting.md). Every setting is listed in
[Server configuration](server-configuration.md).

Run the commands below from `backend/server` on the host. `docker compose exec`
runs the binary inside the server container, where its settings are. The
account and signup-code commands bring the database schema up to date, open
`MINDSTREAM_BLOB_DIR` and load the secret key, creating the blob directory and
the key when they are missing. Run outside the container with only the database
address, they use the wrong blob directory, and `user delete` leaves the
account's files on disk.

## Accounts

```sh
docker compose exec server mindstream-server user list
docker compose exec server mindstream-server user disable <username>
docker compose exec server mindstream-server user enable <username>
docker compose exec server mindstream-server user delete <username>
```

Disabling an account ends its sessions and keeps its data, including its place
in folders others share with it and any invite links it made. Those links stop
working and start again if the account is enabled, so to end them for good, have
an admin of the folder remove the account from it. Deleting one removes
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
bytes as URL-safe base64, or let the server create one on first start; see
[What is on disk](server-configuration.md#what-is-on-disk) for where.

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

A session that no device has used for `MINDSTREAM_SESSION_IDLE_DAYS` ends by
itself, so a device that was put away or lost does not stay signed in for ever.
A device that is running syncs, and that counts as use.

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

Storage counts everything a collection holds, whoever wrote it: content, and the
keys, names and references that come with it. Someone joining adds their copy of
the keys to it, so a person accepting an invitation to a full or lapsed
account's folder gets the same refusal.

The server can only limit what it can count. It cannot tell a note from an
attachment, so there is no limit on the number of notes.

The app keeps what was refused on the device and sends it once there is room.
Until then it shows a notice that names the limit, and in a shared folder the
owner whose plan it is.

An item keeps its current revision and the `MINDSTREAM_KEEP_REVISIONS` before
it, and a deleted item keeps only the record that it was deleted. What goes
stops counting against the owner straight away.

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
base64-encoded). Requests to the admin interface count against the sign-in limit
of the address they come from, and nothing else slows down guessing, so with
`MINDSTREAM_AUTH_RATE_PER_MINUTE=0` the token's length is all that protects it.
Keep a copy where the billing system reads it, and nowhere else.

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

Changes that need you to act before an upgrade are listed here, newest first.

**Coming from a server older than 0.3.0.** Storage counts keys, names and
references besides content, so the first start recounts every collection and
accounts show a little more in use. An account close to its limit may end up
over it. Nothing is removed, but only deletions go through until there is room,
so raise the limit first if that matters. Accounts without limits are not
affected. Signing in no longer says that a username does not exist, so app
versions before 0.3.0 show "Wrong password." for a mistyped name.

## Threat model notes

What the server deliberately does not defend, so nobody is surprised:

- Signing in does not say whether a username exists, but on a server with open
  signup, taking a name does. Any signed-in account can look up others to address
  invitations, at 30 names a minute and with 20 names that turn out to be nobody's
  a day by default. Usernames appear in sharing dialogs anyway.
- A removed member keeps the ciphertext they already synced. The server stops
  serving them anything new, but cannot take back what they have.
- Password guessing is held back per address (10 a minute by default) and per
  account (10 wrong passwords in 10 minutes). A botnet that spreads a few
  guesses per address per account stays under both; length and a second factor
  are what stop it.
