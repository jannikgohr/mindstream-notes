# E2E backlog: tests still to be written

The queue of end-to-end tests we know we want and have not written yet, plus the
harness work each one is waiting on.

How this fits the other e2e docs:

| Doc                        | Answers                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| [strategy.md](strategy.md) | which tier a test belongs in, and why                            |
| [flows.md](flows.md)       | the catalogue of flows worth covering (§1–§5), defined not built |
| [status.md](status.md)     | what has actually landed, and the harness gaps blocking more     |
| **this doc**               | what to write next, and what has to exist first                  |

New flows are numbered §6 onward so they can be promoted into `flows.md`
verbatim once written. Priorities follow that doc: **P1** core/ship-blocking,
**P2** important, **P3** nice to have. Entries keep its _Why e2e / Steps /
Proves_ shape.

---

## 6. Account session & token lifecycle

`auth/mod.rs` is excluded from unit coverage (network + keyring), and
`sync::run_with_reauth` / `auth::refresh_token` need a live `Account` — there is
no mock-runtime harness for etebase in this repo. So the silent-re-auth feature
shipped with **zero automated coverage**; it was verified by hand on an Android
device. That is the gap this section closes.

Background on the mechanism is in the doc comments on `auth::refresh_token` and
`sync::run_with_reauth`.

### Shared blocker: invalidating a token without breaking credentials

Most of §6 needs a token the server rejects _while the account's password and
main key stay valid_ — that is the state that triggers a refresh. Reproducing it
from the outside is awkward: the live token is inside the encrypted session
blob, so the harness cannot simply replay it to the server's logout endpoint.

Proposed hook, mirroring the existing `e2e_*` commands in `sharing/`:

```rust
#[cfg(feature = "e2e-data-dir")]
e2e_invalidate_session_token   // rewrite the stored blob's auth_token with garbage
```

That reproduces a forgotten token exactly (the server 401s it) while leaving
`main_key` intact, which is precisely the refreshable case. It is one small
command and it unblocks 6.1, 6.2 and 6.3.

The alternative — deleting the DRF token row inside the backend container — also
works and needs no product code, but couples the specs to the server's schema.
Prefer the command.

### 6.1 Silent re-auth when the server forgets the token (P1, T4)

- **Why e2e:** `fetch_token` is a real challenge/signature handshake against a
  real Etebase server. Nothing below T4 can execute it.
- **Steps:** sign in → create a note and sync → invalidate the stored token
  (hook above) → `sync_now` → assert the sync **succeeds** and the note still
  round-trips, with no sign-in prompt and no user-visible error.
- **Proves:** the 401 → refresh → retry path in `run_with_reauth`, end to end.

### 6.2 The refreshed token is persisted (P1, T4)

- **Why e2e:** the write-back goes through the keyring and the on-disk session
  file. If it silently failed, every sync would still _work_ — it would just pay
  a hidden extra round trip forever, which no assertion in 6.1 would catch.
- **Steps:** after 6.1, restart the app and sync again → assert the second sync
  performs **no** refresh.
- **Proves:** `persist_session_blob` wrote the new token back, and the other
  restore sites (live collab, repair, sharing) inherit it.
- **Note:** needs a way to observe "did a refresh happen". A counter on the sync
  report is cheaper and less brittle than scraping logs.

### 6.3 A refused refresh tells the user to sign in (P2, T4)

- **Why e2e:** this is the only path that should surface
  `SESSION_EXPIRED_MESSAGE`, and getting it wrong means advising a sign-in the
  app could have avoided — the exact regression 6.1 guards the other side of.
- **Steps:** change the account password from a second client (which invalidates
  key-based login, so the stored `main_key` can no longer sign a challenge) →
  `sync_now` → assert the surfaced message is the "could not be renewed
  automatically" one.
- **Proves:** refresh failure is distinguished from refresh success; paired with
  6.1 asserting that message is _absent_, it pins the whole policy.

### 6.4 Same-server sign-out/sign-in does not duplicate the vault (P1, T4)

- **Why e2e:** `reset_sync_cursors` NULLs every `etebase_uid` on logout. That the
  vault re-converges instead of duplicating depends on four things lining up —
  `ensure_collection` adopting rather than creating, `run` pulling before
  pushing, `apply_note_payload` re-linking by our own payload id, and
  `push_notes` taking its update branch. Only the third has unit coverage
  (`apply_note_relinks_a_row_whose_etebase_uid_was_cleared`).
- **Steps:** sign in → create N notes and sync → sign out → sign back into the
  **same** account → sync → assert the server holds N items, not 2N, and no
  duplicate titles appear locally.
- **Proves:** the re-adopt/re-link chain end to end. Worth having because the
  code comment here was wrong for a long time and only reading four files
  disproved it.

### 6.5 A Tauri rejection renders its message, not `[object Object]` (P2, T2)

- **Why e2e:** Tauri rejects commands with a plain `{ code, message }` object,
  not an `Error`. `String(err)` on that renders `[object Object]`, which is what
  shipped on the sign-in panel until it was found by hand.
- **Steps:** make the browser-fallback mock store reject a command with a
  `CommandError`-shaped object → assert the UI shows `message` verbatim and the
  string `[object Object]` appears nowhere.
- **Proves:** `toErrorMessage` stays wired at the call sites. Cheapest possible
  tier for the regression that started all of this — no backend, no device.
- **Note:** a lint rule banning `String(err)` in catch blocks would cover more
  ground than one spec; the six deliberate exceptions are listed in the
  `refactor(errors)` commit.

---

## 7. Android

### Where we actually are

There is **no Android execution tier**. `mobile-editor-stability.spec.ts` and
`mobile-kanban.spec.ts` set an Android user-agent and a 412×915 viewport, but
they run in desktop Chromium under Playwright. They prove mobile _layout and
component logic_ — worth having, and not evidence about Android.

Nothing in any tier runs on an Android runtime. The consequences are not
hypothetical: the `[object Object]` sign-in error and the dead-token sync
failure were both found by driving a physical tablet by hand, and recent fixes
in this area (mobile text selection, the slash menu in a scrolling pane,
spellcheck settings on mobile) are all WebView-behaviour bugs that no current
tier could have caught.

### How far can we actually go?

Honestly: **further than nothing, well short of parity — and none of it is
prototyped.** Everything below is a plan, not a verified path. Flagged
accordingly.

**Reusable as-is.** The WebdriverIO runner, mocha framework and spec reporter
are already dependencies, and the T3 specs are written against ARIA selectors.
An Android tier is a new config plus capabilities, not a new framework, and
selectors should largely port.

**Not reusable.** `tauri-driver` is desktop-only — it cannot drive Android at
all. The path is Appium with the UiAutomator2 driver, switching into the
`WEBVIEW_com.jannikgohr.mindstream_notes` context so the Chromium-backed
System WebView is driven by chromedriver. That is a second driver stack to
install and keep working, and **chromedriver/WebView version skew is the classic
failure mode** — the device's WebView updates itself from the Play Store, out of
our control.

#### Blocker 1 — per-spec isolation (the real one)

T3/T4 isolate each run with the **data-dir env override**, gated by
`profiles::dir_override_allowed()`. Android apps do not inherit arbitrary
process environment, so that mechanism simply does not reach them. Options:

- `adb shell pm clear com.jannikgohr.mindstream_notes` between specs. Works
  today with no product change, wipes the keyring too (which makes state
  deterministic), but is slow and all-or-nothing.
- Read the same override from an **intent extra** at boot, gated exactly as the
  env var is. More work, but it gives Android the isolation the other tiers
  already have.

This is the highest-leverage piece of harness work in the section; almost
everything else is blocked behind it.

#### Blocker 2 — prerequisites to confirm before committing to the plan

- **WebView debugging must be on** for Appium to attach a webview context
  (`setWebContentsDebuggingEnabled`). Tauri debug builds are expected to enable
  it and release builds are not — **this has not been verified here** and should
  be the first thing checked, because the whole approach depends on it.
- **Session injection** is already an open desktop gap ([status.md](status.md));
  on Android the blob lives in app-private storage and the key in
  `android-native-keyring-store`, so seeding a signed-in state is harder. `pm
clear` plus a real UI sign-in is the fallback, at a cost of ~seconds per spec.
- **Backend reachability** for a T4-equivalent: an emulator reaches the host at
  `10.0.2.2`; a physical device needs the stack on a routable address. Pick one
  before writing specs — it changes the config.

#### Blocker 3 — CI

T3/T4 do not run in CI yet at all, so Android lands behind them. An emulator on
Linux runners is possible but slow; realistically this is local/manual first,
matching where T3/T4 sit today.

### Staged plan

Each stage is independently useful; stop wherever the value runs out.

| Stage  | Scope                                                                                   | Needs                      |
| ------ | --------------------------------------------------------------------------------------- | -------------------------- |
| **A1** | Smoke: launch, webview attaches, tree renders, open a note, type, reopen                | Appium + webview debugging |
| **A2** | The mobile-specific journeys — text selection, IME, slash menu, mobile settings, sheets | A1 + isolation (blocker 1) |
| **A3** | Restart persistence, Android keyring round-trip, backgrounding / process death          | A2                         |
| **A4** | Sync against the backend stack, including §6 re-auth on-device                          | A3 + reachable backend     |

### 7.1 Android smoke (P1, A1)

- **Why e2e:** nothing currently executes on Android; a launch/render regression
  ships silently today.
- **Steps:** install the debug APK → launch → attach the webview context →
  assert the note tree renders → open a note, type, reopen, assert content.
- **Proves:** the Android build boots and its IPC round-trips.

### 7.2 Mobile editor interaction (P1, A2)

- **Why e2e:** native selection handles, the IME and touch scrolling exist only
  on a real WebView. The T2 mobile specs emulate a viewport, not any of that.
- **Steps:** long-press to select → assert the native copy/paste menu appears →
  open the slash menu inside a scrolled pane → assert it stays anchored.
- **Proves:** the recent mobile fixes stay fixed. These are the bugs this app
  actually has.

### 7.3 Android keyring + session across restart (P2, A3)

- **Why e2e:** `android-native-keyring-store` is a distinct backend from the
  desktop ones and is exercised on no tier.
- **Steps:** sign in → force-stop → relaunch → assert the session restores
  without a prompt.
- **Proves:** the Android half of flow 3.5, which today is desktop-only.

### 7.4 On-device re-auth (P2, A4)

- **Why e2e:** this is where the bug was found. §6.1 covers the logic on
  desktop; this covers it on the platform whose keyring and storage differ.
- **Steps:** as 6.1, against a device pointed at the test stack.
- **Proves:** refresh + persistence work through the Android keyring.

### What Android should not try to prove

Per [strategy.md](strategy.md), test at the lowest tier that can prove the
thing. Sync convergence, sharing, history and CRDT semantics are all platform-
independent and belong in T4 on desktop, where the harness already exists and
runs faster. Android's job is the surface that is genuinely different: the
WebView, touch and IME, the platform keyring, and the app lifecycle.

---

## Harness work these depend on

Consolidated, in rough dependency order. Existing desktop gaps stay in
[status.md](status.md); these are the ones §6/§7 add.

- [ ] **`e2e_invalidate_session_token`** behind `e2e-data-dir` — unblocks 6.1,
      6.2, 6.3.
- [ ] **Refresh counter on the sync report** so 6.2 can assert "no refresh
      happened" without scraping logs.
- [ ] **Confirm WebView debugging** is enabled in Tauri Android debug builds.
      Everything in §7 depends on it; check it first.
- [ ] **Android data-dir isolation** — `pm clear` to start, an intent-extra
      override to do it properly.
- [ ] **Appium + UiAutomator2 config** reusing the existing wdio runner.
- [ ] **Backend reachability decision** for Android T4 (emulator `10.0.2.2` vs a
      routable host).
