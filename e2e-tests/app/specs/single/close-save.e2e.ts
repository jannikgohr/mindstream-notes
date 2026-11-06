import { expect } from '@wdio/globals';
import {
  byName,
  clickName,
  pressElementKey,
  restartApp,
  setElementValue,
  waitForShell
} from '../../helpers/harness.js';

async function createNote(title: string) {
  await clickName('New note');
  const draft = $('input[placeholder="New note"]');
  await draft.waitForDisplayed();
  await setElementValue(draft, title);
  await pressElementKey(draft, 'Enter');
  await clickName(title);
  await $('.ProseMirror').waitForDisplayed();
}

/** Edit and request native close in one JS turn, inside the save debounce. */
async function editAndClose(text: string) {
  await browser.execute((value: string) => {
    const editor = document.querySelector<HTMLElement>('.ProseMirror');
    if (!editor) throw new Error('The markdown editor is missing');
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('insertText', false, value)) {
      throw new Error('The edit was not inserted');
    }
    if (!editor.textContent?.includes(value)) {
      throw new Error('The edit did not reach the editor');
    }
    const native = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: string } };
          invoke(command: string, args: unknown): Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    // Return to WebDriver before native teardown, without waiting for autosave.
    setTimeout(() => {
      void native.invoke('plugin:window|close', {
        label: native.metadata.currentWindow.label
      });
    }, 0);
  }, text);
}

describe('T3 save before desktop close', function () {
  beforeEach(async () => {
    await waitForShell();
  });

  it('persists the last edit when the main window closes immediately', async () => {
    const title = `Main close ${Date.now()}`;
    const text = `Saved before main window close ${Date.now()}`;
    await createNote(title);
    await editAndClose(text);
    await browser.waitUntil(
      async () =>
        (await browser.getWindowHandles().catch(() => [])).length === 0,
      { timeout: 20_000, timeoutMsg: 'The main window did not finish closing' }
    );
    await restartApp();
    await clickName(title);
    await expect($('.ProseMirror')).toHaveText(expect.stringContaining(text));
  });

  it('saves a popout before returning its note to the main window', async () => {
    const title = `Popout close ${Date.now()}`;
    const text = `Saved before popout close ${Date.now()}`;
    await createNote(title);
    const main = await browser.getWindowHandle();
    await $('.dv-popout-button').click();
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === 2,
      { timeout: 30_000, timeoutMsg: 'The popout did not appear in WebDriver' }
    );
    const popout = (await browser.getWindowHandles()).find(
      (handle) => handle !== main
    )!;
    await browser.switchToWindow(popout);
    await $('.ProseMirror').waitForDisplayed({ timeout: 30_000 });
    await editAndClose(text);
    await browser.waitUntil(
      async () => !(await browser.getWindowHandles()).includes(popout),
      { timeout: 20_000, timeoutMsg: 'The popout did not finish closing' }
    );
    await browser.switchToWindow(main);
    await expect(byName(title)).toBeDisplayed();
    await expect($('.ProseMirror')).toHaveText(expect.stringContaining(text));
    await restartApp();
    await clickName(title);
    await expect($('.ProseMirror')).toHaveText(expect.stringContaining(text));
  });
});
