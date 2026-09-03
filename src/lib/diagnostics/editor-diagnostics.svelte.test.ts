import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { Diagnostic, DiagnosticProvider, Segment } from './types';

const api = vi.hoisted(() => ({
  unknownWords: vi.fn(async (_languages: string[], words: string[]) =>
    words.filter((word) => word === 'teh')
  ),
  suggest: vi.fn(async (_languages: string[], _word: string) => ['tea', 'the']),
  wordChars: vi.fn(async (_languages: string[]) => "'"),
  available: vi.fn(async () => [
    {
      id: 'de_DE_frami',
      bcp47: 'de-DE',
      license: 'GPL-3.0',
      sourceUrl: 'https://example.test/de',
      installed: true
    },
    {
      id: 'en_US',
      bcp47: 'en-US',
      license: 'MIT',
      sourceUrl: 'https://example.test/en',
      installed: true
    }
  ])
}));
const settings = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  /** Replaced below with a rune read, so effects can track settings writes. */
  track: (): unknown => undefined,
  get: vi.fn((id: string) => {
    settings.track();
    return settings.values.get(id);
  })
}));
const custom = vi.hoisted(() => ({
  isCustomWord: vi.fn((_word: string) => false)
}));

vi.mock('$lib/api/spellcheck', () => ({
  spellcheckUnknownWords: api.unknownWords,
  spellcheckSuggest: api.suggest,
  spellcheckWordChars: api.wordChars,
  spellcheckAvailableDictionaries: api.available
}));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: settings.get
}));
vi.mock('$lib/settings/i18n.svelte', () => ({
  tUi: (key: string) => key
}));
vi.mock('./custom-dictionary.svelte', () => ({
  isCustomWord: custom.isCustomWord
}));

/**
 * The settings watcher's tests use this statically imported instance rather
 * than `load()`. `vi.resetModules()` re-evaluates Svelte's client runtime
 * along with the module under test, so a freshly imported copy keeps its
 * effects in a runtime the test file's `$state` and `flushSync` know nothing
 * about — the effect would simply never re-run.
 */
import * as watched from './editor-diagnostics.svelte';

/**
 * Reloaded per test: the bus, the owner and the cached WORDCHARS are module
 * state shared by every editor surface, so one test's registration would
 * otherwise still be on the bus in the next.
 */
async function load() {
  vi.resetModules();
  return await import('./editor-diagnostics.svelte');
}

/**
 * Stands in for the real store's reactivity: the mock is a plain Map, so
 * writes need something an `$effect` can subscribe to.
 */
let revision = $state(0);
settings.track = () => revision;

/** Write a setting the way the settings dialog does — reactively. */
function setSetting(id: string, value: unknown): void {
  settings.values.set(id, value);
  revision += 1;
}

const segment = (text: string, from = 0): Segment => ({
  text,
  from,
  to: from + text.length
});

/** A stub checker that flags the whole segment with the given kind. */
function stubProvider(
  id: string,
  kind: Diagnostic['kind'],
  message = id
): DiagnosticProvider {
  return {
    id,
    kinds: [kind],
    check: ({ text }) => [
      { from: 0, to: text.length, kind, message, replacements: [], source: id }
    ]
  };
}

beforeEach(() => {
  settings.values = new Map<string, unknown>([
    ['language.spellcheck.enabled', true],
    ['language.spellcheck.languages', ['de_DE_frami']]
  ]);
  settings.get.mockClear();
  custom.isCustomWord.mockReturnValue(false);
  for (const fn of Object.values(api)) fn.mockClear();
});

describe('spellcheck settings readers', () => {
  it('defaults to enabled when the setting is unset', async () => {
    settings.values.delete('language.spellcheck.enabled');
    const mod = await load();
    expect(mod.spellcheckEnabled()).toBe(true);
  });

  it('reads the stored enabled flag', async () => {
    settings.values.set('language.spellcheck.enabled', false);
    const mod = await load();
    expect(mod.spellcheckEnabled()).toBe(false);
  });

  it('reads the selected languages, treating a non-array as none', async () => {
    const mod = await load();
    expect(mod.spellcheckLanguages()).toEqual(['de_DE_frami']);

    settings.values.set('language.spellcheck.languages', 'de_DE_frami');
    expect(mod.spellcheckLanguages()).toEqual([]);
  });
});

describe('checkSegments', () => {
  it('checks segments through the built-in dictionary', async () => {
    const mod = await load();
    const out = await mod.checkSegments(
      [segment('teh cat')],
      new AbortController().signal
    );
    expect(out).toEqual([
      {
        from: 0,
        to: 3,
        kind: 'spelling',
        message: 'language.spellcheck.unknownWord',
        replacements: [],
        source: 'spellcheck'
      }
    ]);
  });

  it('rebases diagnostics onto the document offsets', async () => {
    const mod = await load();
    const out = await mod.checkSegments(
      [segment('ok', 0), segment('teh cat', 100)],
      new AbortController().signal
    );
    expect(out.map((d) => [d.from, d.to])).toEqual([[100, 103]]);
  });

  it('reports nothing when spellcheck is off', async () => {
    settings.values.set('language.spellcheck.enabled', false);
    const mod = await load();
    expect(
      await mod.checkSegments([segment('teh')], new AbortController().signal)
    ).toEqual([]);
    expect(api.unknownWords).not.toHaveBeenCalled();
  });

  it('reports nothing when no language is selected', async () => {
    settings.values.set('language.spellcheck.languages', []);
    const mod = await load();
    expect(
      await mod.checkSegments([segment('teh')], new AbortController().signal)
    ).toEqual([]);
    expect(api.unknownWords).not.toHaveBeenCalled();
  });

  it('skips words the user accepted into their personal dictionary', async () => {
    custom.isCustomWord.mockImplementation((word: string) => word === 'teh');
    const mod = await load();
    expect(
      await mod.checkSegments([segment('teh')], new AbortController().signal)
    ).toEqual([]);
  });

  it('draws partial results as providers finish', async () => {
    const mod = await load();
    const partial = vi.fn();
    await mod.checkSegments(
      [segment('teh cat')],
      new AbortController().signal,
      partial
    );
    expect(partial).toHaveBeenCalled();
  });
});

describe('registerProvider', () => {
  it('adds a provider to the shared bus and removes it again', async () => {
    const mod = await load();
    const off = mod.registerProvider(stubProvider('style-bot', 'style'));

    const withProvider = await mod.checkSegments(
      [segment('teh cat')],
      new AbortController().signal
    );
    expect(withProvider.map((d) => d.source).sort()).toEqual([
      'spellcheck',
      'style-bot'
    ]);

    off();
    const without = await mod.checkSegments(
      [segment('teh cat')],
      new AbortController().signal
    );
    expect(without.map((d) => d.source)).toEqual(['spellcheck']);
  });

  it('re-checks text already on screen when a checker appears', async () => {
    const mod = await load();
    const recheck = vi.fn();
    mod.subscribeDiagnosticsInvalidated(recheck);

    const off = mod.registerProvider(stubProvider('style-bot', 'style'));
    expect(recheck).toHaveBeenCalledTimes(1);
    off();
    expect(recheck).toHaveBeenCalledTimes(2);
  });
});

describe('spelling ownership', () => {
  it('starts with the built-in dictionary owning spelling', async () => {
    const mod = await load();
    expect(mod.spellingOwner()).toBeNull();
  });

  it('lets a handed-over owner suppress the dictionary squiggle', async () => {
    const mod = await load();
    mod.registerProvider(stubProvider('lt', 'spelling', 'from the server'));
    mod.setSpellingOwner('lt', 'LanguageTool');

    expect(mod.spellingOwner()).toEqual({ id: 'lt', label: 'LanguageTool' });
    const out = await mod.checkSegments(
      [segment('teh cat')],
      new AbortController().signal
    );
    expect(out.map((d) => d.source)).toEqual(['lt']);
  });

  it('hands spelling back to the dictionary', async () => {
    const mod = await load();
    mod.setSpellingOwner('lt', 'LanguageTool');
    mod.setSpellingOwner(null);
    expect(mod.spellingOwner()).toBeNull();
  });
});

describe('reloadSpellcheckConfig', () => {
  it('reloads word chars and language tags, and clears the cache', async () => {
    const mod = await load();
    await mod.checkSegments([segment('teh')], new AbortController().signal);
    expect(api.unknownWords).toHaveBeenCalledTimes(1);

    // Same text again: served from the bus cache, no second backend call.
    await mod.checkSegments([segment('teh')], new AbortController().signal);
    expect(api.unknownWords).toHaveBeenCalledTimes(1);

    await mod.reloadSpellcheckConfig();
    expect(api.wordChars).toHaveBeenCalled();
    expect(api.available).toHaveBeenCalled();

    await mod.checkSegments([segment('teh')], new AbortController().signal);
    expect(api.unknownWords).toHaveBeenCalledTimes(2);
  });

  it('finishes loading before anyone is told to re-check', async () => {
    const mod = await load();
    const order: string[] = [];
    api.wordChars.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      order.push('word-chars');
      return "'";
    });
    mod.subscribeDiagnosticsInvalidated(() => order.push('re-check'));

    await mod.reloadSpellcheckConfig();

    // The re-check reads the cached word characters, so a re-check that runs
    // first tokenizes with the previous selection's.
    expect(order).toEqual(['word-chars', 're-check']);
  });

  it('still invalidates when the backend refuses', async () => {
    const mod = await load();
    api.wordChars.mockRejectedValueOnce(new Error('not installed'));
    const recheck = vi.fn();
    mod.subscribeDiagnosticsInvalidated(recheck);

    await expect(mod.reloadSpellcheckConfig()).resolves.toBeUndefined();
    // Leaving the old squiggles up would describe a selection the user has
    // already changed.
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('skips the word-chars call when no language is selected', async () => {
    settings.values.set('language.spellcheck.languages', []);
    const mod = await load();
    await mod.reloadSpellcheckConfig();
    expect(api.available).toHaveBeenCalled();
    expect(api.wordChars).not.toHaveBeenCalled();
  });

  it('does not refetch the configuration on a plain invalidation', async () => {
    const mod = await load();
    mod.invalidateDiagnostics();
    expect(api.wordChars).not.toHaveBeenCalled();
  });
});

describe('startSpellcheckSettingsWatcher', () => {
  let stopWatcher: (() => void) | null = null;
  let offListener: (() => void) | null = null;

  afterEach(() => {
    // In afterEach rather than at the end of each test: a watcher left
    // running by a failing assertion would react to the NEXT test's writes.
    stopWatcher?.();
    stopWatcher = null;
    offListener?.();
    offListener = null;
  });

  /**
   * Start the watcher and wait out its startup reload, so what a test
   * observes afterwards is only what its own settings write caused.
   */
  async function started(): Promise<void> {
    const startup = vi.fn();
    const off = watched.subscribeDiagnosticsInvalidated(startup);
    stopWatcher = watched.startSpellcheckSettingsWatcher();
    flushSync();
    await vi.waitFor(() => expect(startup).toHaveBeenCalledTimes(1));
    off();
    api.wordChars.mockClear();
  }

  /** Subscribe for the rest of the test, torn down in `afterEach`. */
  function listen(): ReturnType<typeof vi.fn> {
    const recheck = vi.fn();
    offListener = watched.subscribeDiagnosticsInvalidated(recheck);
    return recheck;
  }

  it('reloads and re-checks when the selected languages change', async () => {
    await started();
    const recheck = listen();

    setSetting('language.spellcheck.languages', ['en_US']);
    flushSync();

    await vi.waitFor(() => expect(recheck).toHaveBeenCalledTimes(1));
    // The reload has to be for the NEW selection, not the one the squiggles
    // on screen were produced from.
    expect(api.wordChars).toHaveBeenCalledWith(['en_US']);
  });

  it('re-checks when the feature is switched off, to clear the squiggles', async () => {
    await started();
    const recheck = listen();

    setSetting('language.spellcheck.enabled', false);
    flushSync();

    await vi.waitFor(() => expect(recheck).toHaveBeenCalledTimes(1));
  });

  it('ignores writes to unrelated settings', async () => {
    await started();
    const recheck = listen();

    // Reading any setting subscribes to the whole store, so the effect does
    // re-run here; throwing away every open note's results over an unrelated
    // toggle is what it must not do.
    setSetting('editor.autoPair', false);
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recheck).not.toHaveBeenCalled();
    expect(api.wordChars).not.toHaveBeenCalled();
  });

  it('stops watching once torn down', async () => {
    await started();
    stopWatcher?.();
    stopWatcher = null;

    setSetting('language.spellcheck.languages', ['en_US']);
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.wordChars).not.toHaveBeenCalled();
  });
});

describe('selectedLanguageTags', () => {
  it('is empty until the catalogue has loaded', async () => {
    const mod = await load();
    expect(mod.selectedLanguageTags()).toEqual([]);
  });

  it('maps selected dictionary ids to BCP-47 tags', async () => {
    const mod = await load();
    await mod.reloadSpellcheckConfig();
    expect(mod.selectedLanguageTags()).toEqual(['de-DE']);
  });

  it('drops selections the catalogue does not know', async () => {
    settings.values.set('language.spellcheck.languages', [
      'de_DE_frami',
      'xx_ZZ'
    ]);
    const mod = await load();
    await mod.reloadSpellcheckConfig();
    expect(mod.selectedLanguageTags()).toEqual(['de-DE']);
  });
});

describe('suggestFor', () => {
  it('ranks the backend suggestions', async () => {
    const mod = await load();
    await expect(mod.suggestFor('teh')).resolves.toEqual(['the', 'tea']);
    expect(api.suggest).toHaveBeenCalledWith(['de_DE_frami'], 'teh');
  });

  it('suggests nothing when no language is selected', async () => {
    settings.values.set('language.spellcheck.languages', []);
    const mod = await load();
    await expect(mod.suggestFor('teh')).resolves.toEqual([]);
    expect(api.suggest).not.toHaveBeenCalled();
  });
});
