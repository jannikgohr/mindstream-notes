/**
 * Shared harness for the real-app (T3) and collaboration (T4) e2e tiers.
 *
 * These tests drive the **packaged Tauri binary** over WebDriver (tauri-driver),
 * not the browser-fallback SPA. They are gated behind capability flags so the
 * suite skips cleanly when the binary / backend isn't available:
 *
 *   - `MINDSTREAM_E2E_APP=1`     — the packaged app + tauri-driver are runnable
 *   - `MINDSTREAM_E2E_BACKEND=1` — the backend/ compose stack is up (T4 only)
 *
 * The per-test isolation seam is `MINDSTREAM_PROFILE_DIR` (see
 * src-tauri/src/profiles.rs::dir_override, gated to dev builds and the
 * `e2e-data-dir` cargo feature). A relaunch against the *same* dir is how the
 * restart assertions work; a *fresh* dir per spec keeps runs from leaking.
 *
 * NOTE: this harness is a scaffold. The profile-dir + restart seam is wired to
 * the documented env override, but two things still need a real environment to
 * finish and validate (tracked in docs/e2e-strategy.md §3 / §7):
 *   - per-spec profile-dir injection requires respawning tauri-driver with new
 *     env (see `freshProfileDir` / wdio.conf `beforeSession`);
 *   - native file dialogs need a Rust-side test hook — `requireDialogHook`
 *     skips the specs that depend on it until that lands.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A Mocha test context (`this`) — enough to call `.skip()`. */
export interface Skippable {
  skip(): void;
}

export const APP_E2E = process.env.MINDSTREAM_E2E_APP === '1';
export const BACKEND_E2E = process.env.MINDSTREAM_E2E_BACKEND === '1';

/**
 * Native-dialog test hook (export/import/PDF pickers). Not yet implemented on
 * the Rust side — see e2e-strategy.md §3. Flip on via env once a hook exists so
 * the backup/PDF specs stop self-skipping.
 */
export const DIALOG_HOOK = process.env.MINDSTREAM_E2E_DIALOG_HOOK === '1';

/** Skip the calling suite unless the packaged app is runnable. */
export function requireAppE2E(ctx: Skippable): void {
  if (!APP_E2E) ctx.skip();
}

/** Skip the calling suite unless the backend stack is up (T4). */
export function requireBackendE2E(ctx: Skippable): void {
  if (!APP_E2E || !BACKEND_E2E) ctx.skip();
}

/** Skip suites that drive a native file dialog until the Rust hook lands. */
export function requireDialogHook(ctx: Skippable): void {
  if (!APP_E2E || !DIALOG_HOOK) ctx.skip();
}

/**
 * Allocate a throwaway profile directory for an isolated run. The value must be
 * exported as `MINDSTREAM_PROFILE_DIR` to the app process — done in
 * wdio.conf.ts `beforeSession` for the run-level dir; a spec that needs its own
 * dir respawns the driver with this value (see `restartAppWithProfile`).
 */
export function freshProfileDir(): string {
  return mkdtempSync(join(tmpdir(), 'mindstream-e2e-'));
}

/**
 * Restart the app against the **same** on-disk profile — the restart that
 * "persists across relaunch" assertions hang on. tauri-driver tears down and
 * recreates the WebView session; the Rust side rehydrates from the same dir.
 */
export async function restartApp(): Promise<void> {
  // `browser` is a wdio global available inside a session.
  await browser.reloadSession();
}

// ---- Accessible-name selectors (mirror the browser-fallback role queries) ----
// The same SvelteKit UI renders inside WebView2/WebKit, so the accessible names
// used by the Playwright T2 specs apply verbatim here. wdio's `aria/` strategy
// queries by computed accessible name.

export function byName(name: string): ChainablePromiseElement {
  return $(`aria/${name}`);
}

export function allByName(name: string): ChainablePromiseArray {
  return $$(`aria/${name}`);
}

export function treeItem(name: string): ChainablePromiseElement {
  return byName('File tree').$(`aria/${name}`);
}

export async function clickElement(
  element: ChainablePromiseElement,
  opts: { button?: 'left' | 'right' } = {}
): Promise<void> {
  const resolved = await element;
  await resolved.waitForDisplayed({ timeout: 30_000 });
  await browser.execute(
    (el: HTMLElement, button: 'left' | 'right') => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX,
        clientY,
        button: button === 'right' ? 2 : 0,
        buttons: button === 'right' ? 2 : 1
      };

      el.focus?.();
      if (button === 'right') {
        el.dispatchEvent(new MouseEvent('mousedown', base));
        el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('contextmenu', base));
        return;
      }

      el.dispatchEvent(new MouseEvent('mousedown', base));
      el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
      el.click();
    },
    resolved,
    opts.button ?? 'left'
  );
}

export async function setElementValue(
  element: ChainablePromiseElement,
  value: string
): Promise<void> {
  const resolved = await element;
  await resolved.waitForDisplayed({ timeout: 30_000 });
  await browser.execute(
    (el: HTMLElement, next: string) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      input.scrollIntoView({ block: 'center', inline: 'center' });
      input.focus();
      input.value = next;
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, data: next })
      );
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    resolved,
    value
  );
}

export async function pressElementKey(
  element: ChainablePromiseElement,
  key: string,
  opts: { ctrlKey?: boolean } = {}
): Promise<void> {
  const resolved = await element;
  await resolved.waitForDisplayed({ timeout: 30_000 });
  await browser.execute(
    (el: HTMLElement, pressed: string, ctrlKey: boolean) => {
      el.focus?.();
      const init = {
        key: pressed,
        code: pressed,
        bubbles: true,
        cancelable: true,
        ctrlKey
      };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    },
    resolved,
    key,
    opts.ctrlKey === true
  );
}

export async function insertText(
  element: ChainablePromiseElement,
  text: string
): Promise<void> {
  const resolved = await element;
  await clickElement(resolved);
  await browser.execute(
    (el: HTMLElement, value: string) => {
      el.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('insertText', false, value);
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value
        })
      );
    },
    resolved,
    text
  );
}

export async function clickName(
  name: string,
  opts: { button?: 'left' | 'right' } = {}
): Promise<void> {
  await clickElement(byName(name), opts);
}

export async function clickMenuItem(label: string): Promise<void> {
  const escaped = label.replace(/"/g, '\\"');
  await clickElement(
    $(
      `//button[@role="menuitem" and .//*[normalize-space(text())="${escaped}"]]`
    )
  );
}

/** Wait for the seeded shell to hydrate (the Welcome note in the tree). */
export async function waitForShell(): Promise<void> {
  await byName('Welcome').waitForDisplayed({ timeout: 30_000 });
}

/** Credentials for driving the Settings → Account sign-in form. */
export interface LoginInput {
  serverUrl: string;
  username: string;
  password: string;
}

/**
 * Sign one client into a self-hosted server through the Settings → Account UI
 * — the real user flow, since `withGlobalTauri` is off so we can't invoke the
 * `etebase_login` IPC directly from the WebView.
 *
 * Scoped to a SINGLE `client` (a wdio instance) on purpose: under multiremote
 * the global `$`/`byName` fan out to every browser, but each client signs into
 * its own account, so every query and click here goes through `client`.
 *
 * Accessible names are taken verbatim from src/lib/settings (the label-wrapped
 * inputs in SignInForm.svelte and the section labels in i18n/en.json):
 *   "Open settings" → "Account & Sync" → "Self-hosted" →
 *   "Server URL" / "Username or email" / "Password" → "Sign in".
 *
 * NOTE: written to the confirmed labels but not yet validated against a live
 * app session — see e2e/app/README.md ("Not yet validated end-to-end").
 */
export async function loginClient(
  client: WebdriverIO.Browser,
  input: LoginInput
): Promise<void> {
  // Route every interaction through the execute-based helpers: WebKitWebDriver
  // (Linux `wry`) rejects the native `element/click` and send-keys commands with
  // "unsupported operation", so clicks/fills must be synthesized as DOM events.
  const h = clientHelpers(client);

  await h.click('Open settings');
  await h.click('Account & Sync');
  await h.click('Self-hosted');
  await h.setValue('Server URL', input.serverUrl);
  await h.setValue('Username or email', input.username);
  await h.setValue('Password', input.password);
  await h.click('Sign in');

  // The signed-in card renders the username once the Rust login resolves.
  await client
    .$(`aria/${input.username}`)
    .waitForDisplayed({ timeout: 60_000 });
}

/**
 * Per-instance versions of the global `aria/` helpers, bound to ONE wdio client.
 *
 * The module-level `byName`/`treeItem`/`clickElement`/`clickMenuItem` above use
 * the global `$`/`browser`, which under wdio **multiremote** fan out to *every*
 * client at once. In the T4 two-client suites each browser is a distinct user's
 * device, so every query and click must target a single client — that's what
 * this factory provides. It mirrors the global helpers verbatim (same DOM-event
 * synthesis, same accessible-name strategy) but routes them through `client`.
 *
 * The tree-seed helpers (`newRootFolder`, `newNoteInFolder`) drive the same UI
 * flow the browser-fallback T2 specs validate in e2e/browser/tree-operations
 * .spec.ts: the toolbar "New folder"/"New note" buttons and the folder context
 * menu's "New folder inside"/"New note in folder" items, each opening an inline
 * draft input whose accessible name is its placeholder ("New folder"/"New note").
 */
export interface ClientHelpers {
  byName(name: string): ChainablePromiseElement;
  allByName(name: string): ChainablePromiseArray;
  treeItem(name: string): ChainablePromiseElement;
  click(name: string, opts?: { button?: 'left' | 'right' }): Promise<void>;
  clickElement(
    element: ChainablePromiseElement,
    opts?: { button?: 'left' | 'right' }
  ): Promise<void>;
  setValue(name: string, value: string): Promise<void>;
  pressKey(
    element: ChainablePromiseElement,
    key: string,
    opts?: { ctrlKey?: boolean }
  ): Promise<void>;
  clickMenuItem(label: string): Promise<void>;
  openNotifications(): Promise<void>;
  newRootFolder(name: string): Promise<void>;
  newNoteInFolder(folder: string, note: string): Promise<void>;
}

export function clientHelpers(client: WebdriverIO.Browser): ClientHelpers {
  const byName = (name: string) => client.$(`aria/${name}`);
  const allByName = (name: string) => client.$$(`aria/${name}`);
  const treeItem = (name: string) =>
    client.$('aria/File tree').$(`aria/${name}`);

  const clickElement = async (
    element: ChainablePromiseElement,
    opts: { button?: 'left' | 'right' } = {}
  ): Promise<void> => {
    const resolved = await element;
    await resolved.waitForDisplayed({ timeout: 30_000 });
    await client.execute(
      (el: HTMLElement, button: 'left' | 'right') => {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        const base = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
          button: button === 'right' ? 2 : 0,
          buttons: button === 'right' ? 2 : 1
        };
        el.focus?.();
        if (button === 'right') {
          el.dispatchEvent(new MouseEvent('mousedown', base));
          el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
          el.dispatchEvent(new MouseEvent('contextmenu', base));
          return;
        }
        el.dispatchEvent(new MouseEvent('mousedown', base));
        el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
        el.click();
      },
      resolved,
      opts.button ?? 'left'
    );
  };

  const click = (name: string, opts: { button?: 'left' | 'right' } = {}) =>
    clickElement(byName(name), opts);

  const setValue = async (name: string, value: string): Promise<void> => {
    const resolved = await byName(name);
    await resolved.waitForDisplayed({ timeout: 30_000 });
    await client.execute(
      (el: HTMLElement, next: string) => {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        input.scrollIntoView({ block: 'center', inline: 'center' });
        input.focus();
        input.value = next;
        input.dispatchEvent(
          new InputEvent('input', { bubbles: true, data: next })
        );
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      resolved,
      value
    );
  };

  const pressKey = async (
    element: ChainablePromiseElement,
    key: string,
    opts: { ctrlKey?: boolean } = {}
  ): Promise<void> => {
    const resolved = await element;
    await resolved.waitForDisplayed({ timeout: 30_000 });
    await client.execute(
      (el: HTMLElement, pressed: string, ctrlKey: boolean) => {
        el.focus?.();
        const init = {
          key: pressed,
          code: pressed,
          bubbles: true,
          cancelable: true,
          ctrlKey
        };
        el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
      },
      resolved,
      key,
      opts.ctrlKey === true
    );
  };

  const clickMenuItem = async (label: string): Promise<void> => {
    const escaped = label.replace(/"/g, '\\"');
    await clickElement(
      client.$(
        `//button[@role="menuitem" and .//*[normalize-space(text())="${escaped}"]]`
      )
    );
  };

  const openNotifications = () => click('Open notifications');

  // Draft-input flow: a toolbar/context-menu action opens an inline <input>
  // whose accessible name is its placeholder; fill it and press Enter to commit.
  const commitDraft = async (
    placeholder: string,
    value: string
  ): Promise<void> => {
    await setValue(placeholder, value);
    await pressKey(byName(placeholder), 'Enter');
    await treeItem(value).waitForDisplayed({ timeout: 30_000 });
  };

  const newRootFolder = async (name: string): Promise<void> => {
    await click('New folder');
    await commitDraft('New folder', name);
  };

  const newNoteInFolder = async (
    folder: string,
    note: string
  ): Promise<void> => {
    await clickElement(treeItem(folder), { button: 'right' });
    await clickMenuItem('New note in folder');
    await commitDraft('New note', note);
  };

  return {
    byName,
    allByName,
    treeItem,
    click,
    clickElement,
    setValue,
    pressKey,
    clickMenuItem,
    openNotifications,
    newRootFolder,
    newNoteInFolder
  };
}
