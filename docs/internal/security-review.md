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
  `409 user_exists`. The protection holds for closed and invite-only servers.
  Someone watching one name sees its salt change when an account takes it, and
  the timing was only measured over loopback.
