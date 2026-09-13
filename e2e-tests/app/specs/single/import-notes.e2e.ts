/**
 * T3 vault import through the packaged app. The source picker is fed by the
 * e2e-only Rust seam, then every other step uses the real UI, IPC and SQLite.
 */

import { expect } from '@wdio/globals';
import {
  IMPORT_BODY_CANARY,
  IMPORT_DESTINATION,
  IMPORT_HOME,
  IMPORT_PLACEHOLDER,
  IMPORT_PLAN,
  IMPORT_PNG_BYTES,
  IMPORT_TAG
} from '../../helpers/import-fixture.js';
import {
  byName,
  clickLastButtonText,
  clickName,
  closeSettings,
  restartApp,
  setElementValue,
  textInPage,
  waitForShell
} from '../../helpers/harness.js';

interface CollectionRow {
  id: string;
  name: string;
  parent_collection_id: string | null;
}

interface NoteRow {
  id: string;
  title: string;
  body: string;
  parent_collection_id: string | null;
  tags: string[];
}

interface AssetRow {
  id: string;
  mime_type: string;
  bytes: number[];
}

const startedAt = Date.now();

/**
 * Timestamped progress, because this spec's only CI failure mode so far has
 * been a silent 180s hang: the spec reporter prints nothing but the Mocha
 * timeout, so the log has to say which step was in flight.
 */
function step(label: string): void {
  console.log(
    `[import-e2e +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${label}`
  );
}

/** Ceiling for one page-side IPC round trip. */
const INVOKE_TIMEOUT_MS = 30_000;

async function invokeTauri<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  step(`invoke ${command}`);
  // The race runs inside the page: an IPC call that never answers would
  // otherwise leave the WebDriver `execute` outstanding until Mocha's own
  // timeout, which reports nothing about where the run stopped.
  const result = (await browser.execute(
    async (
      cmd: string,
      invokeArgs: Record<string, unknown> | undefined,
      timeoutMs: number
    ) => {
      const tauri = window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: <R>(
            command: string,
            args?: Record<string, unknown>
          ) => Promise<R>;
        };
      };
      const invoke = tauri.__TAURI_INTERNALS__?.invoke;
      if (!invoke) throw new Error('Tauri invoke is not exposed in WebView');
      return Promise.race([
        invoke(cmd, invokeArgs),
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`invoke ${cmd} did not answer`)),
            timeoutMs
          );
        })
      ]);
    },
    command,
    args,
    INVOKE_TIMEOUT_MS
  )) as T;
  step(`invoke ${command} answered`);
  return result;
}

async function importedNotes(): Promise<NoteRow[]> {
  const summaries = await invokeTauri<Array<{ id: string; title: string }>>(
    'list_notes',
    { includeTrashed: false }
  );
  const wanted = new Set([IMPORT_HOME, IMPORT_PLAN, IMPORT_PLACEHOLDER]);
  const notes: NoteRow[] = [];
  for (const note of summaries.filter((item) => wanted.has(item.title))) {
    // One WebDriver session is one protocol connection. WebView2 happens to
    // queue concurrent execute commands, while WebKitWebDriver can leave one
    // waiting forever. Read each imported note in order so this verification
    // behaves the same on Windows and Linux.
    notes.push(await invokeTauri<NoteRow>('load_note', { id: note.id }));
  }
  return notes;
}

/**
 * Click without waiting for the handler.
 *
 * Every other click in this suite goes through `clickElement`, which
 * dispatches the synthetic events inside a `browser.execute`. On WebKitGTK the
 * IPC that "Import" kicks off runs in the same main-thread callback as the
 * script, so that one execute never came back and the whole spec sat there
 * until Mocha's timeout. Handing the dispatch to a timer lets the script
 * return first; the import then starts on its own.
 */
async function clickDeferred(name: string): Promise<void> {
  const element = await byName(name);
  await element.waitForDisplayed({ timeout: 30_000 });
  await browser.execute((el: HTMLElement) => {
    setTimeout(() => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0
      };
      el.dispatchEvent(new MouseEvent('mousedown', base));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
    }, 0);
  }, element);
}

/** Log what the dialog is showing, to place a stall inside the import. */
async function traceDialog(label: string): Promise<void> {
  const text = await browser.execute(
    () =>
      document
        .querySelector('[role="alertdialog"]')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) ?? '(no dialog)'
  );
  step(`${label}: ${text}`);
}

describe('T3 notes importer', function () {
  this.timeout(180_000);

  beforeEach(async () => {
    step('wait for the shell');
    await waitForShell();
    step('shell ready');
  });

  it('imports an Obsidian vault with correct data and restart persistence', async () => {
    step('open the import dialog');
    await clickName('Open settings');
    await clickName('Data & Backup');
    await clickLastButtonText(browser, 'Import notes');
    step('pick the source folder (e2e seam, no native dialog)');
    await clickName('Choose a folder');

    step('wait for the detected format');
    await byName('Format').waitForDisplayed({ timeout: 30_000 });
    const detectedFormat = await browser.execute(
      (label: HTMLElement) => {
        const select = label.matches('select')
          ? label
          : (label.querySelector('select') ??
            label.closest('label')?.querySelector('select'));
        return (select as HTMLSelectElement | null)?.value ?? null;
      },
      await byName('Format')
    );
    expect(detectedFormat).toBe('obsidian');
    await setElementValue(
      byName('Import into a new folder called'),
      IMPORT_DESTINATION
    );
    await setElementValue(
      byName("Links to notes that aren't in the import"),
      'create-placeholder'
    );
    step('start the import');
    await clickDeferred('Import');
    for (let poll = 0; poll < 5; poll += 1) {
      await browser.pause(2_000);
      await traceDialog(`poll ${poll + 1}`);
    }

    step('wait for the import report');
    await byName('Import finished').waitForDisplayed({ timeout: 30_000 });
    const resultText = await textInPage($('[role="alertdialog"]'));
    expect(resultText).toContain('2 Notes imported');
    expect(resultText).toContain('1 Folder created');
    expect(resultText).toContain('3 links connected');
    expect(resultText).toContain(
      '1 empty note created for missing link targets'
    );
    expect(resultText).toContain('1 Attachment imported');
    expect(resultText).toContain(
      '1 Attachment already stored, so not duplicated'
    );

    step('close the report and settings');
    await clickLastButtonText(browser, 'Close');
    await closeSettings();

    const collections = await invokeTauri<CollectionRow[]>('list_collections');
    const destination = collections.find(
      (collection) => collection.name === IMPORT_DESTINATION
    );
    const projects = collections.find(
      (collection) =>
        collection.name === 'Projects' &&
        collection.parent_collection_id === destination?.id
    );
    expect(destination?.parent_collection_id).toBeNull();
    expect(projects).toBeDefined();

    const notes = await importedNotes();
    expect(notes).toHaveLength(3);
    const home = notes.find((note) => note.title === IMPORT_HOME);
    const plan = notes.find((note) => note.title === IMPORT_PLAN);
    const placeholder = notes.find((note) => note.title === IMPORT_PLACEHOLDER);
    expect(home?.parent_collection_id).toBe(destination?.id);
    expect(plan?.parent_collection_id).toBe(projects?.id);
    expect(placeholder?.parent_collection_id).toBe(destination?.id);
    expect(placeholder?.body).toBe('');
    expect(home?.tags).toContain(IMPORT_TAG);
    expect(home?.body).toContain(IMPORT_BODY_CANARY);
    expect(home?.body).toContain(`[the plan](mindstream://note/${plan?.id})`);
    expect(home?.body).toContain(
      `[Missing Note](mindstream://note/${placeholder?.id})`
    );
    expect(plan?.body).toContain(`[Home](mindstream://note/${home?.id})`);

    const homeAssetId = home?.body.match(
      /asset:mindstream\/(asset_[A-Za-z0-9_-]+)/
    )?.[1];
    const planAssetId = plan?.body.match(
      /asset:mindstream\/(asset_[A-Za-z0-9_-]+)/
    )?.[1];
    expect(homeAssetId).toBeDefined();
    expect(planAssetId).toBe(homeAssetId);
    if (!homeAssetId) throw new Error('Imported home note has no asset ID');
    const asset = await invokeTauri<AssetRow>('fetch_drawing_asset', {
      id: homeAssetId
    });
    expect(asset.mime_type).toBe('image/png');
    expect(asset.bytes).toEqual([...IMPORT_PNG_BYTES]);

    step('walk the imported tree');
    await expect(byName(IMPORT_DESTINATION)).toBeDisplayed();
    await clickName(IMPORT_DESTINATION);
    await expect(byName(IMPORT_HOME)).toBeDisplayed();
    await expect(byName('Projects')).toBeDisplayed();
    await clickName('Projects');
    await expect(byName(IMPORT_PLAN)).toBeDisplayed();

    step('restart the app');
    await restartApp();
    step('app restarted, wait for the shell');
    await waitForShell();
    expect(await importedNotes()).toHaveLength(3);
    await expect(byName(IMPORT_DESTINATION)).toBeDisplayed();
    step('done');
  });
});
