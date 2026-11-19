/**
 * T3: the bundled Journal plugin end to end. Its calendar is a plugin sidebar
 * view, its exports run in the real Wasmtime host, and the daily note is found
 * or created by the app and filled from a template by the Templates plugin.
 *
 * Run: pnpm test:e2e:app --spec e2e-tests/app/specs/single/journal.e2e.ts
 */

import { expect } from '@wdio/globals';
import {
  byName,
  clickElement,
  clickName,
  closeSettingsDialog,
  restartApp,
  setPluginEnabledByName,
  waitForShell
} from '../../helpers/harness.js';

const JOURNAL = 'com.mindstream.journal';

interface Summary {
  id: string;
  title: string;
  parent_collection_id: string | null;
}

function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return browser.execute(
    (c: string, a: Record<string, unknown>) =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke(c: string, a: Record<string, unknown>): Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__.invoke(c, a),
    command,
    args
  ) as Promise<T>;
}

/** Today in the page's local time, and its English weekday. */
function today(): Promise<{ key: string; weekday: string }> {
  return browser.execute(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      weekday: d.toLocaleDateString('en', { weekday: 'long' })
    };
  });
}

async function dailyNotes(folderId: string): Promise<Summary[]> {
  const notes = await invoke<Summary[]>('list_notes', {
    includeTrashed: false
  });
  return notes.filter((n) => n.parent_collection_id === folderId);
}

/** A day button of the shown month in the calendar. */
function calendarDay(day: number) {
  return $(
    `[data-plugin-view] [data-bits-day]:not([data-outside-month])[data-value$="-${String(day).padStart(2, '0')}"]`
  );
}

describe('Journal plugin', () => {
  let folderId = '';

  before(async () => {
    await waitForShell();
    const folder = await invoke<{ id: string }>('create_collection', {
      input: { name: 'Daily' }
    });
    folderId = folder.id;
    const template = await invoke<{ id: string }>('create_note', {
      input: {
        title: 'Daily template',
        body: '# {{title}}\n\nIt is {{date:dddd}}.'
      }
    });
    // Settings pointing at a folder or note the window's tree hasn't loaded
    // yet are cleared as dangling, so let it load them first.
    await restartApp();
    await waitForShell();
    await invoke('plugins_settings_set', {
      id: JOURNAL,
      key: 'folder',
      value: folderId
    });
    await invoke('plugins_settings_set', {
      id: JOURNAL,
      key: 'template',
      value: template.id
    });
    // The frontend reads plugin settings at startup.
    await restartApp();
    await waitForShell();
  });

  it('opens the calendar and creates today’s note from the template', async () => {
    await clickElement($('nav button[aria-label="Journal"]'));
    await calendarDay(1).waitForDisplayed({ timeout: 15_000 });
    await clickElement($('button[aria-label="Today"]'));

    const { key, weekday } = await today();
    await browser.waitUntil(
      async () => (await dailyNotes(folderId)).some((n) => n.title === key),
      { timeout: 15_000, timeoutMsg: 'today’s daily note was not created' }
    );
    const [note] = (await dailyNotes(folderId)).filter((n) => n.title === key);
    const full = await invoke<{ body: string }>('load_note', { id: note.id });
    expect(full.body).toContain(`# ${key}`);
    expect(full.body).toContain(`It is ${weekday}.`);
  });

  it('steps to the next and previous month', async () => {
    const heading = () =>
      browser.execute(
        () =>
          document.querySelector('[data-plugin-view] header > :first-child')
            ?.textContent
      );
    const shown = await heading();
    await clickElement($('[data-plugin-view] [data-calendar-next-button]'));
    await browser.waitUntil(async () => (await heading()) !== shown, {
      timeoutMsg: 'the next month was not shown'
    });
    const next = await heading();
    // Leaving the view and coming back keeps the month browsed to.
    await clickElement($('nav button[aria-label="Home"]'));
    await clickElement($('nav button[aria-label="Journal"]'));
    await browser.waitUntil(async () => (await heading()) === next, {
      timeoutMsg: 'reopening the view lost the browsed month'
    });
    await clickElement($('[data-plugin-view] [data-calendar-prev-button]'));
    await browser.waitUntil(async () => (await heading()) === shown, {
      timeoutMsg: 'the previous month was not shown'
    });
  });

  it('creates one note for a day however quickly it is clicked', async () => {
    const day = (await today()).key.endsWith('-15') ? 16 : 15;
    const element = await calendarDay(day);
    await browser.execute(
      (el: HTMLElement) => {
        el.click();
        el.click();
      },
      element as unknown as HTMLElement
    );

    const suffix = `-${day}`;
    await browser.waitUntil(
      async () =>
        (await dailyNotes(folderId)).some((n) => n.title.endsWith(suffix)),
      { timeout: 15_000, timeoutMsg: 'the clicked day’s note was not created' }
    );
    // The view sends its events one at a time, so the second click finds
    // the note the first one created.
    expect(
      (await dailyNotes(folderId)).filter((n) => n.title.endsWith(suffix))
    ).toHaveLength(1);
  });

  it('falls back to Home when Journal is disabled while open', async () => {
    const journal = $('nav button[aria-label="Journal"]');
    await clickElement(journal);
    await clickName('Open settings');
    await clickName('Plugins');
    await expect(byName('Enable in this vault')).toBeDisplayed();
    await setPluginEnabledByName('Journal', false);
    await closeSettingsDialog(browser);

    await journal.waitForExist({ reverse: true });
    await expect($('nav button[aria-label="Home"]')).toHaveAttribute(
      'aria-current',
      'page'
    );

    await clickName('Open settings');
    await clickName('Plugins');
    await setPluginEnabledByName('Journal', true);
    await closeSettingsDialog(browser);
    await journal.waitForExist();
  });
});
