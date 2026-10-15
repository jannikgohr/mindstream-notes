# Invite links

What an invite link looks like, and the address the app is opened with,
written down once.

Four pieces of code read or build these: the client library, the app's
window, the app's start-up code and the page the server shows for a link.
Two languages, and nothing generated. [invite-links.json](invite-links.json)
holds examples that each of them has a test against.

Like [the room protocol](../room/README.md), this folder has no code and is
under the app's licence, MIT or Apache-2.0.

## An invite link

```
https://notes.example.com/join/<uid>#<secret>
```

- Everything before `join/` is the server, which may itself live under a
  path.
- `<uid>` names the link on the server. It is not a secret.
- `<secret>` is 32 bytes as URL-safe base64 without padding, 43 characters.
  It comes after the `#`, so a browser keeps it to itself: it is in no
  request and in no server log.

Only `http` and `https` addresses are links. Space around a pasted link is
ignored.

## The address that opens the app

```
mindstream-notes://join?link=<the invite link, percent-encoded>
```

A browser opens an invite link, since it is a web address on any server. The
page it lands on builds this second address from the first and offers it as a
button. The operating system hands an address under the app's scheme to the
app, on the same device, and to nobody else.

The link is one percent-encoded parameter, `#` included. An address written
by hand that leaves the `#` bare is read as well.

The app does nothing with a link it is handed but show it: it opens the
dialog for joining with the link filled in. Any program on the device can
open such an address, with any link inside, so nothing is asked of a server
until the user goes on.

## Who checks it

| Side           | Test                                                             |
| -------------- | ---------------------------------------------------------------- |
| Client library | `deep_links::tests::client_library_reads_the_links_written_down` |
| App window     | `src/lib/sharing/invite-link.test.ts`                            |
| App start-up   | `deep_links::tests`                                              |
| Server's page  | `join::tests::scheme_is_the_one_written_down_for_the_app`        |
