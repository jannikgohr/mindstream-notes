# The room protocol

What a note's live room says on its socket, written down once.

The server's hub, the app's room socket and the fake server the app's unit
tests use each have their own code for this protocol, in two languages.
Nothing generated ties them together. [room-protocol.json](room-protocol.json)
does: each of the three has a test that reads it and fails when that side has
drifted from it.

This folder has no code and depends on nothing. It is under the app's licence,
MIT or Apache-2.0, and not the server's, so anything may read it.

## Frames

A frame is one binary WebSocket message. Its first byte says what it is.

| From   | Layout                                         | Meaning                    |
| ------ | ---------------------------------------------- | -------------------------- |
| Client | `[hello][ticket, UTF-8]`                       | First frame, and only once |
| Client | `[class][payload]`                             | To everyone else           |
| Client | `[reply][target, 4 bytes big-endian][payload]` | To one member              |
| Server | `[welcome or joined or left or access][JSON]`  | From the server itself     |
| Server | `[class][sender, 4 bytes big-endian][payload]` | A member's frame, relayed  |

The values are under `frames` and `classes`. Every control frame is below every
class, so a receiver tells the two apart by comparing the first byte with
`classes.update`.

The payload is ciphertext the server cannot read. The class is outside it so
that the server can decide who may send it: the classes listed under
`classesThatNeedWriteAccess` are dropped when they come from a member who may
only read. A receiver acts on the class the server relayed and never on
anything inside the payload.

## Control frames

| Frame     | Body                                                | Sent to                    |
| --------- | --------------------------------------------------- | -------------------------- |
| `welcome` | `you`, `accessLevel`, `peers` (each as in `joined`) | The member who just joined |
| `joined`  | `id`, `username`, `accessLevel`                     | Everyone already there     |
| `left`    | `id`                                                | Everyone still there       |
| `access`  | `accessLevel`                                       | The member whose it is     |

A receiver ignores fields it does not know.

## What the file holds

- `frames`, `classes`, `accessLevels`, `closeCodes`, `senderBytes`. The
  numbers.
- `examples`. Single frames with their bytes or their body, for checking an
  encoder or a decoder.
- `exchange`. One conversation in a room, step by step: who joins, sends,
  changes access or leaves, and what every member receives because of it.
  Members and access levels go by name, because a server hands out ids as it
  pleases. A step whose `then` is empty is a frame the server drops. The
  proof is the next step: what arrives then is that step's frame.

## Who checks it

| Side                 | Test                                                       |
| -------------------- | ---------------------------------------------------------- |
| Server hub           | `hub::tests::hub_speaks_the_room_protocol_as_written_down` |
| Server, real sockets | `rooms.rs`, `room_exchange_goes_as_the_protocol_says`      |
| App and its fake     | `src/lib/sync/room-protocol.test.ts`                       |

Changing the protocol means changing this file first. The tests then say
which side has not followed yet.
