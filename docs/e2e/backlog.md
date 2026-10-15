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

## 6. Account sessions and security

`auth/mod.rs` is excluded from unit coverage (network + keyring), and anything
that needs a live `Account` can only run against a server: there is no
mock-runtime harness for the client library in this repo. The pure parts are
unit-tested where they live. The server's own suite drives every account
route through the client library (`backend/server/tests/client_account.rs`).
What is left for this tier is the app end to end.

The app no longer signs itself back in when the server rejects its session.
The three entries that used to stand here were about that silent
re-authentication, which is gone with the move to device sessions, see
[server-design.md](../server-design.md#device-sessions). A rejected session
now signs the device out, and that is what 6.1 and 6.2 cover.

### 6.1 A new device is asked for a code (written, T4)

`specs/multi/account-security.e2e.ts`. Device A creates an account and turns
two-factor sign-in on. Device B signs in through the real form: the password
alone brings up the code field, and a backup code lets it in. Proves the
form's second step and the sign-in command's handling of the server's
"a code is needed".

### 6.2 An ended session signs the device out (written, T4)

Same spec. A ends B's session from the device list, then changes the
password. Each time B is signed out without being asked, keeps its notes, and
shows "Signed out on this device". A's list of devices then holds one, which
is what shows B did not sign itself back in.

### 6.3 Recovery through the form (P2, T4)

- **Why e2e:** recovery is two requests with keys derived on the device in
  between, and it ends by showing a new recovery key before the window
  reloads. The server suite covers the requests. Nothing covers the form
  holding the reload back until the key is acknowledged.
- **Steps:** sign up → note the recovery key → sign out → "Forgot your
  password?" → type the key in lower case with spaces, and a new password →
  assert the new key is shown and the window has not reloaded → acknowledge →
  assert the device is signed in and the old password is refused.
- **Proves:** the form's recovery path and the pending-key store.

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
| **A4** | Sync against the backend stack, including the §6 session flows on-device                | A3 + reachable backend     |

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

### 7.4 On-device sign-out (P2, A4)

- **Why e2e:** §6.2 covers the logic on desktop; this covers it on the
  platform whose keyring and storage differ.
- **Steps:** as 6.2, against a device pointed at the test stack.
- **Proves:** an ended session clears the Android keyring entry and the
  session file, and the device can sign in again afterwards.

### 7.5 Spellcheck on Android (P2, A2)

- **Why e2e:** the mobile half of spellcheck had never run anywhere. The
  settings were filtered to `platforms: ["desktop"]`, so the dictionary
  installer was unreachable on a phone, and the popover is opened by a
  long-press — a gesture no tier below this one can produce.
- **Steps:** open Settings → Language → Spelling → assert the section renders →
  install `en_US` → assert it reports installed → type a misspelling →
  long-press it → assert the popover opens BELOW the word rather than over it
  → pick a suggestion → assert the text changed and the squiggle cleared.
- **Proves:** the dictionary lands under `app_data_root` on Android, and the
  correction journey works with touch instead of a right-click.

**What this should NOT try to prove.** The bug that actually shipped —
`spellcheck_unknown_words` reporting every word as unknown when no dictionary
loaded — was not Android-specific; it hit any device with nothing installed,
which is every device before its first download. It is covered by Rust unit
tests on `unknown_words`, which is the right tier: it needed no webview, no
device and no dictionary. Android surfaced it only because mobile was the one
platform that could not reach the installer. Prefer a unit test for anything
that can be decided without touch.

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

- [ ] **Confirm WebView debugging** is enabled in Tauri Android debug builds.
      Everything in §7 depends on it; check it first.
- [ ] **Android data-dir isolation** — `pm clear` to start, an intent-extra
      override to do it properly.
- [ ] **Appium + UiAutomator2 config** reusing the existing wdio runner.
- [ ] **Backend reachability decision** for Android T4 (emulator `10.0.2.2` vs a
      routable host).
