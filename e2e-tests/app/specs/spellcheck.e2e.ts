/**
 * T3 — flows 5.1, 5.2, 5.3, 5.5 and 5.6 (docs/e2e/flows.md): the spellchecking
 * pipeline end to end.
 *
 * There is no browser-fallback slice for this one and there cannot be: outside
 * Tauri the spellcheck API answers "no opinion" by design (see
 * `src/lib/api/spellcheck.ts`), so the mock store shows no squiggles at all.
 * Everything below needs the real thing — a dictionary loaded off disk by
 * `spellbook`, the `spellcheck_*` commands over IPC, the personal dictionary in
 * SQLite — plus the two editor surfaces, which are excluded from unit coverage
 * (`editor/plugins/**`).
 *
 * The dictionary is SEEDED rather than downloaded. The catalogue points at an
 * upstream repository and a real pair is megabytes; a run that downloaded one
 * would be slow, networked and at the mercy of an external host. The fixture
 * below is a real Hunspell pair, just a very small one, written into the
 * disposable directory the run was launched against
 * (`MINDSTREAM_DICTIONARY_DIR`, see `helpers/harness.ts::dictionaryDir`).
 *
 * Order matters here: the last block removes the dictionary, so it runs after
 * everything that needs one.
 *
 * Run: pnpm test:e2e:app
 */

import { expect } from '@wdio/globals';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  byName,
  clickElement,
  clickName,
  closeSettings,
  dictionaryDir,
  insertText,
  pressElementKey,
  restartApp,
  setElementValue,
  waitForSaved,
  waitForShell
} from '../helpers/harness.js';

/** The default language selection is `["en_US"]`, so that is what we seed. */
const DICTIONARY_ID = 'en_US';
/** The settings panel labels the dictionary by language, not by id. */
const DICTIONARY_LABEL = 'English (US)';

/**
 * A real, minimal Hunspell pair.
 *
 * `TRY` is the alphabet spellbook permutes when it looks for corrections, so
 * it has to be present for the suggestion flow to have anything to offer.
 */
function seedDictionary(): void {
  const dir = dictionaryDir();
  mkdirSync(dir, { recursive: true });
  const words = ['hello', 'world', 'note', 'spelling', 'checker', 'paragraph'];
  writeFileSync(
    join(dir, `${DICTIONARY_ID}.aff`),
    ['SET UTF-8', "TRY esianrtolcdugmphbyfvkwz'", "WORDCHARS '", ''].join('\n'),
    'utf8'
  );
  writeFileSync(
    join(dir, `${DICTIONARY_ID}.dic`),
    [`${words.length}`, ...words, ''].join('\n'),
    'utf8'
  );
}

async function createRootNote(title: string): Promise<void> {
  await clickName('New note');
  const draft = $('input[placeholder="New note"]');
  await draft.waitForDisplayed();
  await setElementValue(draft, title);
  await pressElementKey(draft, 'Enter');
  await expect(byName(title)).toBeDisplayed();
}

/**
 * The words currently carrying a spelling squiggle, in document order.
 *
 * Matched on the class both surfaces emit: the ProseMirror decoration also
 * carries `data-diagnostic-source`, the CodeMirror one does not, and the class
 * is the contract the shared stylesheet is written against.
 */
async function flaggedWords(selector = '.ProseMirror'): Promise<string[]> {
  return browser.execute((root: string) => {
    const nodes = document.querySelectorAll(`${root} .diagnostic-spelling`);
    return Array.from(nodes).map((node) => node.textContent ?? '');
  }, selector);
}

/**
 * Checking is debounced and asynchronous, so every assertion about squiggles
 * has to wait for the pipeline rather than sample it once.
 */
async function waitForFlagged(
  expected: string[],
  selector = '.ProseMirror'
): Promise<void> {
  try {
    await browser.waitUntil(
      async () => {
        const found = await flaggedWords(selector);
        return (
          found.length === expected.length &&
          expected.every((word, i) => found[i] === word)
        );
      },
      { timeout: 45_000 }
    );
  } catch {
    // Reported after the wait, not before it: wdio builds `timeoutMsg`
    // eagerly, so a message composed there describes the state the wait
    // STARTED from — which is never the interesting one.
    throw new Error(
      `expected ${JSON.stringify(expected)} to be flagged in ${selector}, ` +
        `still ${JSON.stringify(await flaggedWords(selector))} after 45s`
    );
  }
}

/** Right-click a squiggle and wait for its suggestion popover. */
async function openPopoverOnFirstSquiggle(
  selector = '.ProseMirror'
): Promise<void> {
  await clickElement($(`${selector} .diagnostic-spelling`), {
    button: 'right'
  });
  await $('[data-diagnostic-popover]').waitForDisplayed({ timeout: 15_000 });
}

/**
 * The whole dictionary row for one language, as one line of text.
 *
 * Read through the DOM rather than asserted per element: the row carries its
 * state (Install / Remove, and the "selected but not installed" warning) as
 * sibling text, and reading it whole means a failure says what the row
 * actually said.
 */
async function dictionaryRow(label: string): Promise<string> {
  return browser.execute((name: string) => {
    const named = Array.from(document.querySelectorAll('span')).find(
      (span) => span.textContent?.trim() === name
    );
    const row = named?.closest('div.rounded-md');
    return (row?.textContent ?? '<row not found>').replace(/\s+/g, ' ').trim();
  }, label);
}

async function openSpellingSettings(): Promise<void> {
  await clickName('Open settings');
  await clickName('Editor');
  await expect(byName('Check spelling')).toBeDisplayed();
}

describe('T3 spellchecking', function () {
  /** The note the markdown assertions run against, reopened after a restart. */
  let noteTitle = '';

  before(async () => {
    seedDictionary();
    // Relaunched so the app boots with the dictionary already on disk, rather
    // than racing the pipeline against a directory that filled up mid-run.
    await restartApp();
    await waitForShell();
  });

  beforeEach(async () => {
    await waitForShell();
  });

  describe('flow 5.1 — a seeded dictionary flags a misspelling', () => {
    it('reports the dictionary as installed', async () => {
      // Proves `installed_dictionaries` read the pair off disk over IPC: the
      // panel only offers Remove for something it found.
      await openSpellingSettings();
      await expect(byName(`Remove ${DICTIONARY_LABEL}`)).toBeDisplayed();
      await closeSettings();
    });

    it('underlines the unknown word and leaves the known one alone', async () => {
      noteTitle = `Spellcheck ${Date.now()}`;
      await createRootNote(noteTitle);
      await insertText($('.ProseMirror'), 'Helo world');

      // One squiggle, on the word the dictionary does not know. "world" is in
      // the fixture, so a second squiggle would mean the dictionary never
      // loaded and everything is being reported unknown.
      await waitForFlagged(['Helo']);
    });
  });

  describe('flow 5.2 — correcting a word from the popover', () => {
    it('applies a suggestion and clears the squiggle', async () => {
      await openPopoverOnFirstSquiggle();

      // The popover names the word it is about, and offers corrections only
      // once `spellcheck_suggest` has answered — it is never precomputed.
      await expect($('[data-diagnostic-popover]')).toHaveText(
        expect.stringContaining('Helo')
      );
      const suggestions = $$('[data-diagnostic-action="replace"]');
      await browser.waitUntil(async () => (await suggestions.length) > 0, {
        timeout: 30_000,
        timeoutMsg: 'the popover offered no corrections'
      });

      const chosen = await suggestions[0].getText();
      await clickElement(suggestions[0]);

      await expect($('.ProseMirror')).toHaveText(
        expect.stringContaining(chosen)
      );
      await expect($('.ProseMirror')).not.toHaveText(
        expect.stringContaining('Helo')
      );
      await waitForFlagged([]);
    });
  });

  describe('flow 5.3 — the personal dictionary', () => {
    const WORD = 'Mindstreem';

    it('accepts a word, and the acceptance survives a restart', async () => {
      await insertText($('.ProseMirror'), ` ${WORD}`);
      await waitForFlagged([WORD]);

      await openPopoverOnFirstSquiggle();
      await clickElement($('[data-diagnostic-action="add-to-dictionary"]'));

      // Accepted words are filtered in the frontend before a word is ever
      // sent for checking, so this takes effect without a dictionary reload.
      await waitForFlagged([]);

      // Saving is debounced: relaunching before it lands would reopen the
      // note as it was two edits ago and assert against the wrong document.
      await waitForSaved();
      await restartApp();
      await waitForShell();
      // Back to the note under test: the seeded fixture knows six words, so
      // any other note's prose would be flagged from end to end.
      await clickName(noteTitle);
      await waitForFlagged([]);
    });

    it('lists the accepted word and flags it again once removed', async () => {
      await openSpellingSettings();
      await expect(byName(`Remove ${WORD}`)).toBeDisplayed();
      await clickName(`Remove ${WORD}`);
      await closeSettings();

      // Removal invalidates the diagnostics, so the word comes back without
      // needing a restart.
      await waitForFlagged([WORD]);
    });
  });

  describe('flow 5.6 — syntax-aware checking in the source editor', () => {
    it('checks prose and skips what the markdown syntax masks', async () => {
      await createRootNote(`Source spellcheck ${Date.now()}`);
      await switchToSourceView();

      // `Helo` sits inside a code span, which the markdown scanner masks —
      // code is not prose, and flagging it is the false-positive flood the
      // scanners exist to stop. `Wrogn` is ordinary prose.
      //
      // Typed through the keyboard rather than execCommand: CodeMirror builds
      // its document from key input, and the browser-tier source specs drive
      // it the same way.
      await clickElement($('.cm-content'));
      // Everything around the target is in the fixture dictionary — with six
      // known words, an ordinary sentence would be flagged end to end and the
      // assertion would prove nothing about masking.
      await browser.keys('hello `Helo` world Wrogn');

      await waitForFlagged(['Wrogn'], '.cm-editor');
    });

    it('offers the same popover on the source surface', async () => {
      await openPopoverOnFirstSquiggle('.cm-editor');
      await expect($('[data-diagnostic-popover]')).toHaveText(
        expect.stringContaining('Wrogn')
      );
      await browser.keys('Escape');
    });
  });

  describe('flow 5.5 — removing a dictionary', () => {
    it('takes effect immediately and stays removed after a restart', async () => {
      await openSpellingSettings();
      await clickName(`Remove ${DICTIONARY_LABEL}`);

      // The panel flips back to offering the download, and says why the
      // still-selected language now does nothing.
      await expect(byName(`Remove ${DICTIONARY_LABEL}`)).not.toBeDisplayed();
      await browser.waitUntil(
        async () => (await dictionaryRow(DICTIONARY_LABEL)).includes('Install'),
        {
          timeout: 15_000,
          timeoutMsg: `row after removal: ${await dictionaryRow(DICTIONARY_LABEL)}`
        }
      );
      expect(await dictionaryRow(DICTIONARY_LABEL)).toContain(
        'Selected but not installed'
      );
      await closeSettings();

      await restartApp();
      await waitForShell();
      await openSpellingSettings();
      // The files really left the disk — a fresh boot rescans the directory.
      await expect(byName(`Remove ${DICTIONARY_LABEL}`)).not.toBeDisplayed();
      expect(await dictionaryRow(DICTIONARY_LABEL)).toContain('Install');
      await closeSettings();
    });
  });
});

/**
 * Cycle the editor's view-mode button until the CodeMirror pane is up. The
 * label is localised and the cycle order differs by viewport width, so the
 * pane itself is the condition rather than the mode name.
 */
async function switchToSourceView(): Promise<void> {
  const button = $('button[aria-label^="Editor view mode:"]');
  await button.waitForDisplayed({ timeout: 15_000 });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await $('.cm-content').isDisplayed()) return;
    await clickElement(button);
    await browser.pause(250);
  }
  await expect($('.cm-content')).toBeDisplayed();
}
