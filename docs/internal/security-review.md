# Security review

The trust boundaries, and the risks we accepted instead of fixing. Every finding
from the September 2026 codebase audit and the October 2026 sync server pen test
is fixed, apart from the residuals below. `git log` on this file and on the
removed `docs/internal/audit-2026-09.md` and `docs/internal/pen-test-2026-10.md`
has the original reports and the reasoning behind each fix.

For the by-design trade-offs the sync/history model carries see
[limitations.md](limitations.md); for how the pieces fit together
see [architecture.md](architecture.md).

## Trust boundaries

The three that matter:

1. **Server operator** — sees ciphertext and all routing metadata.
2. **A share recipient** — holds the room key and can author content your
   client ingests.
3. **A revoked/downgraded member** — someone who _used_ to hold the above.

## Accepted, not fixed

- **Random 96-bit IVs under a long-lived room key.** Reaching the birthday bound
  needs ~2^32 frames under one key, which an editing session will never
  approach. Revisit only if key lifetimes change.
- **The server sees who edits what, and when.** It knows which account is in
  which room, and frame timing and sizes reveal editing activity per room,
  though contents are ciphertext. Inherent to a server you self-host.
- **The server enforces write permission in rooms**, as it does at rest. A
  malicious server working with a read-only member could inject live edits. The
  server on its own still cannot read anything; what the member can read, they
  can hand over anyway.
- **A removed member keeps the keys they already had**, the key of each note's
  room among them. The server stops serving them the folder and its rooms. A
  server working with a removed member could let them go on reading. Ruling
  that out means a new key for the folder, everything in it encrypted again
  and every remaining member invited again, which Etebase has no way to do.
- **Storage limits leave out collection uids and Postgres's per-row
  overhead.** Both are small and bounded by the collection limit, unlike the
  keys and names a client chooses, which are counted.
- **An invite link grants access to whoever holds it**, until it is used up or
  expires.
- **A managed account can be locked out for good.** With the authenticator
  and the backup codes lost and no signed-in device, there is no way to add a
  device again. A self-hosted administrator can reset the second factor.
- **A signed-in account can tell which usernames exist.** Inviting someone needs
  their public key, so the profile lookup and `POST /invitation/outgoing/` have
  to answer differently for a name nobody has. Both count against
  `MINDSTREAM_LOOKUP_RATE_PER_MINUTE` (30) and
  `MINDSTREAM_UNKNOWN_NAMES_PER_DAY` (20) per account, and past either they
  answer `429` for any name. Guessing runs out after 20 misses; a list of mostly
  real names goes on at 30 a minute. Both limits live in memory and reset when
  the server restarts. Tests: `looking_up_names_is_held_to_a_rate` and
  `guessing_names_runs_out` in `backend/server/tests/access.rs`.
- **Signup says whether a username is taken.** Sign-in answers the same for a
  missing name as for a wrong password, with a decoy salt and a 100 ms floor,
  but on a server with open signup, taking a name still answers
  `409 user_exists`. Closed and invite-only servers give that answer only to
  someone holding a signup code or an invite link that may create accounts.
  Someone watching one name sees its salt change when an account takes it, and
  the timing was only measured over loopback.
