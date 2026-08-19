import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args)
}));

import {
  customDictionaryAdd,
  customDictionaryList,
  customDictionaryRemove,
  spellcheckAvailableDictionaries,
  spellcheckInstallDictionary,
  spellcheckRemoveDictionary,
  spellcheckSuggest,
  spellcheckUnknownWords,
  spellcheckWordChars,
  textCheckerCheck,
  textCheckerTestConnection
} from './spellcheck';
import type { PluginCheckerProtocol } from '$lib/plugins/types';

function setTauri(on: boolean): void {
  if (on)
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

const PROTOCOL: PluginCheckerProtocol = {
  check: {
    path: '/v2/check',
    encoding: 'form',
    fields: { text: 'text', language: 'language' }
  },
  matches: {
    list: '/matches',
    offset: '/offset',
    length: '/length',
    message: '/message'
  }
};

beforeEach(() => {
  invoke.mockReset();
  setTauri(true);
});

afterEach(() => {
  setTauri(false);
});

describe('spellcheck API — desktop path', () => {
  it('passes languages and words through and returns the unknown subset', async () => {
    invoke.mockResolvedValueOnce(['teh']);

    await expect(
      spellcheckUnknownWords(['en-US'], ['the', 'teh'])
    ).resolves.toEqual(['teh']);
    expect(invoke).toHaveBeenCalledWith('spellcheck_unknown_words', {
      languages: ['en-US'],
      words: ['the', 'teh']
    });
  });

  it('asks for suggestions one word at a time', async () => {
    invoke.mockResolvedValueOnce(['the', 'tea']);

    await expect(spellcheckSuggest(['en-US'], 'teh')).resolves.toEqual([
      'the',
      'tea'
    ]);
    expect(invoke).toHaveBeenCalledWith('spellcheck_suggest', {
      languages: ['en-US'],
      word: 'teh'
    });
  });

  it('maps the available-dictionary catalogue', async () => {
    invoke.mockResolvedValueOnce([
      {
        id: 'de_DE',
        bcp47: 'de-DE',
        license: 'GPL-3.0',
        sourceUrl: 'https://example.test/de_DE',
        installed: true
      }
    ]);

    await expect(spellcheckAvailableDictionaries()).resolves.toEqual([
      {
        id: 'de_DE',
        bcp47: 'de-DE',
        license: 'GPL-3.0',
        sourceUrl: 'https://example.test/de_DE',
        installed: true
      }
    ]);
    expect(invoke).toHaveBeenCalledWith(
      'spellcheck_available_dictionaries',
      undefined
    );
  });

  it('rejects a catalogue that is not an array', async () => {
    invoke.mockResolvedValueOnce({ id: 'de_DE' });

    await expect(spellcheckAvailableDictionaries()).rejects.toThrow(
      /must be an array/
    );
  });

  it('rejects a catalogue entry with a malformed field', async () => {
    invoke.mockResolvedValueOnce([
      {
        id: 'de_DE',
        bcp47: 'de-DE',
        license: 'GPL-3.0',
        sourceUrl: 'https://example.test/de_DE',
        installed: 'yes'
      }
    ]);

    await expect(spellcheckAvailableDictionaries()).rejects.toThrow(
      /dictionary\[0\]\.installed/
    );
  });

  it('installs and removes dictionaries by id', async () => {
    invoke.mockResolvedValue(null);

    await spellcheckInstallDictionary('de_DE');
    await spellcheckRemoveDictionary('de_DE');

    expect(invoke).toHaveBeenNthCalledWith(1, 'spellcheck_install_dictionary', {
      id: 'de_DE'
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'spellcheck_remove_dictionary', {
      id: 'de_DE'
    });
  });

  it('returns the WORDCHARS union', async () => {
    invoke.mockResolvedValueOnce("'-");

    await expect(spellcheckWordChars(['en-US', 'de-DE'])).resolves.toBe("'-");
    expect(invoke).toHaveBeenCalledWith('spellcheck_word_chars', {
      languages: ['en-US', 'de-DE']
    });
  });

  it('rejects word chars that are not a string', async () => {
    invoke.mockResolvedValueOnce(42);

    await expect(spellcheckWordChars(['en-US'])).rejects.toThrow(
      /must be a string/
    );
  });

  it('nulls out omitted credentials and defaults preferred variants', async () => {
    invoke.mockResolvedValueOnce([]);

    await textCheckerCheck({
      endpoint: 'https://lt.example.test',
      language: 'auto',
      text: 'Ein Satz.',
      disabledCategories: ['TYPOS'],
      protocol: PROTOCOL
    });

    expect(invoke).toHaveBeenCalledWith('text_checker_check', {
      endpoint: 'https://lt.example.test',
      apiKey: null,
      username: null,
      language: 'auto',
      text: 'Ein Satz.',
      disabledCategories: ['TYPOS'],
      preferredVariants: [],
      protocol: PROTOCOL
    });
  });

  it('forwards credentials and preferred variants when supplied', async () => {
    invoke.mockResolvedValueOnce([]);

    await textCheckerCheck({
      endpoint: 'https://lt.example.test',
      apiKey: 'k',
      username: 'u',
      language: 'auto',
      text: 'text',
      disabledCategories: [],
      preferredVariants: ['de-DE'],
      protocol: PROTOCOL
    });

    expect(invoke).toHaveBeenCalledWith(
      'text_checker_check',
      expect.objectContaining({
        apiKey: 'k',
        username: 'u',
        preferredVariants: ['de-DE']
      })
    );
  });

  it('maps checker matches', async () => {
    invoke.mockResolvedValueOnce([
      {
        from: 4,
        to: 9,
        message: 'Possible typo',
        replacements: ['Satz'],
        category: 'TYPOS'
      }
    ]);

    await expect(
      textCheckerCheck({
        endpoint: 'https://lt.example.test',
        language: 'de-DE',
        text: 'Ein Satzz.',
        disabledCategories: [],
        protocol: PROTOCOL
      })
    ).resolves.toEqual([
      {
        from: 4,
        to: 9,
        message: 'Possible typo',
        replacements: ['Satz'],
        category: 'TYPOS'
      }
    ]);
  });

  it('rejects a match list that is not an array', async () => {
    invoke.mockResolvedValueOnce({ matches: [] });

    await expect(
      textCheckerCheck({
        endpoint: 'https://lt.example.test',
        language: 'de-DE',
        text: 'x',
        disabledCategories: [],
        protocol: PROTOCOL
      })
    ).rejects.toThrow(/must be an array/);
  });

  it('rejects a match with a non-numeric offset', async () => {
    invoke.mockResolvedValueOnce([
      {
        from: '4',
        to: 9,
        message: 'Possible typo',
        replacements: [],
        category: 'TYPOS'
      }
    ]);

    await expect(
      textCheckerCheck({
        endpoint: 'https://lt.example.test',
        language: 'de-DE',
        text: 'x',
        disabledCategories: [],
        protocol: PROTOCOL
      })
    ).rejects.toThrow(/match\[0\]\.from/);
  });

  it('probes a connection with the wanted languages', async () => {
    invoke.mockResolvedValueOnce({
      ok: true,
      detail: 'LanguageTool 6.4',
      missingLanguages: ['de-AT']
    });

    await expect(
      textCheckerTestConnection({
        endpoint: 'https://lt.example.test',
        wantedLanguages: ['de-DE', 'de-AT'],
        protocol: PROTOCOL
      })
    ).resolves.toEqual({
      ok: true,
      detail: 'LanguageTool 6.4',
      missingLanguages: ['de-AT']
    });
    expect(invoke).toHaveBeenCalledWith('text_checker_test_connection', {
      endpoint: 'https://lt.example.test',
      apiKey: null,
      username: null,
      wantedLanguages: ['de-DE', 'de-AT'],
      protocol: PROTOCOL
    });
  });

  it('defaults the wanted languages to none', async () => {
    invoke.mockResolvedValueOnce({
      ok: false,
      detail: 'connection refused',
      missingLanguages: []
    });

    await textCheckerTestConnection({
      endpoint: 'https://lt.example.test',
      apiKey: 'k',
      username: 'u',
      protocol: PROTOCOL
    });

    expect(invoke).toHaveBeenCalledWith(
      'text_checker_test_connection',
      expect.objectContaining({
        wantedLanguages: [],
        apiKey: 'k',
        username: 'u'
      })
    );
  });

  it('rejects a malformed test-connection response', async () => {
    invoke.mockResolvedValueOnce({
      ok: 'yes',
      detail: '',
      missingLanguages: []
    });

    await expect(
      textCheckerTestConnection({
        endpoint: 'https://lt.example.test',
        protocol: PROTOCOL
      })
    ).rejects.toThrow(/testConnection\.ok/);
  });

  it('reads, adds to and removes from the personal dictionary', async () => {
    invoke.mockResolvedValueOnce(['Mindstream']);
    await expect(customDictionaryList()).resolves.toEqual(['Mindstream']);

    invoke.mockResolvedValue(null);
    await customDictionaryAdd('Mindstream');
    await customDictionaryRemove('Mindstream');

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      'custom_dictionary_list',
      undefined
    );
    expect(invoke).toHaveBeenNthCalledWith(2, 'custom_dictionary_add', {
      word: 'Mindstream'
    });
    expect(invoke).toHaveBeenNthCalledWith(3, 'custom_dictionary_remove', {
      word: 'Mindstream'
    });
  });
});

describe('spellcheck API — browser fallback', () => {
  beforeEach(() => {
    setTauri(false);
  });

  it('reports no opinion rather than fake squiggles', async () => {
    await expect(spellcheckUnknownWords(['en-US'], ['teh'])).resolves.toEqual(
      []
    );
    await expect(spellcheckSuggest(['en-US'], 'teh')).resolves.toEqual([]);
    await expect(spellcheckAvailableDictionaries()).resolves.toEqual([]);
    await expect(spellcheckWordChars(['en-US'])).resolves.toBe('');
    await expect(customDictionaryList()).resolves.toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('makes dictionary and personal-word mutations no-ops', async () => {
    await expect(spellcheckInstallDictionary('de_DE')).resolves.toBeUndefined();
    await expect(spellcheckRemoveDictionary('de_DE')).resolves.toBeUndefined();
    await expect(customDictionaryAdd('Mindstream')).resolves.toBeUndefined();
    await expect(customDictionaryRemove('Mindstream')).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns no matches and an unavailable connection result', async () => {
    await expect(
      textCheckerCheck({
        endpoint: 'https://lt.example.test',
        language: 'de-DE',
        text: 'Ein Satzz.',
        disabledCategories: [],
        protocol: PROTOCOL
      })
    ).resolves.toEqual([]);

    await expect(
      textCheckerTestConnection({
        endpoint: 'https://lt.example.test',
        protocol: PROTOCOL
      })
    ).resolves.toEqual({
      ok: false,
      detail: 'unavailable outside the desktop app',
      missingLanguages: []
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});
