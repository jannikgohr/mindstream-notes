import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginTextCheckerContribution } from '$lib/plugins/types';

const contributions = vi.hoisted(
  () => [] as { pluginId: string; checker: PluginTextCheckerContribution }[]
);
const settings = vi.hoisted(() => new Map<string, unknown>());
const registered = vi.hoisted(() => new Map<string, () => void>());
const spellingOwner = vi.hoisted(() => ({
  id: null as string | null,
  label: ''
}));
/** The BCP-47 tags the language selection resolves to, per test. */
const tags = vi.hoisted(() => ({ value: ['de-DE', 'en-US'] as string[] }));
/** Provider options as handed to the factory, so the config closure is reachable. */
const options = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('./http-checker-provider', () => ({
  createHttpCheckerProvider: (opts: Record<string, unknown>) => {
    options.set(opts.id as string, opts);
    return { id: opts.id, kinds: opts.kinds, check: () => null };
  }
}));

vi.mock('$lib/plugins/registry.svelte', () => ({
  pluginTextCheckers: () => contributions,
  // The owner's display name comes from the manifest, so the settings UI
  // can say WHO took spelling over.
  pluginById: (id: string) => ({ manifest: { id, name: 'LanguageTool' } })
}));
vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) => settings.get(id)
}));
vi.mock('./custom-dictionary.svelte', () => ({ isCustomWord: () => false }));
vi.mock('./checker-status.svelte', () => ({
  reportCheckerStatus: () => {},
  clearCheckerStatus: () => {}
}));
vi.mock('./editor-diagnostics.svelte', () => ({
  selectedLanguageTags: () => tags.value,
  setSpellingOwner: (id: string | null, label = '') => {
    spellingOwner.id = id;
    spellingOwner.label = label;
  },
  registerProvider: (provider: { id: string }) => {
    const off = vi.fn();
    registered.set(provider.id, off);
    return () => {
      off();
      registered.delete(provider.id);
    };
  }
}));
vi.mock('$lib/api/spellcheck', () => ({ textCheckerCheck: vi.fn() }));

const checker = (
  over: Partial<PluginTextCheckerContribution> = {}
): PluginTextCheckerContribution => ({
  id: 'grammar',
  kinds: ['grammar'],
  // The shape a manifest declares; the wiring only carries it through.
  protocol: {
    check: { path: '/check', encoding: 'form', fields: { text: 'text' } },
    matches: {
      list: '/matches',
      offset: '/offset',
      length: '/length',
      message: '/message'
    }
  },
  endpointSetting: 'endpoint',
  ...over
});

async function load() {
  vi.resetModules();
  return await import('./plugin-checkers.svelte');
}

beforeEach(() => {
  contributions.length = 0;
  settings.clear();
  registered.clear();
  options.clear();
  spellingOwner.id = null;
  tags.value = ['de-DE', 'en-US'];
});

describe('syncPluginTextCheckers', () => {
  it('registers a contributed checker', async () => {
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect([...registered.keys()]).toEqual(['plugins.com.example.lt.grammar']);
  });

  it('registers nothing when no plugin contributes one', async () => {
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect(registered.size).toBe(0);
  });

  it('is idempotent', async () => {
    // Called on every plugin-state change, so re-registering an unchanged
    // checker would drop its cached findings and re-check every open note.
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();
    const first = registered.get('plugins.com.example.lt.grammar');
    mod.syncPluginTextCheckers();
    expect(registered.get('plugins.com.example.lt.grammar')).toBe(first);
    expect(first).not.toHaveBeenCalled();
  });

  it('unregisters a checker whose plugin went away', async () => {
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();

    contributions.length = 0;
    mod.syncPluginTextCheckers();
    expect(registered.size).toBe(0);
  });

  it('leaves other checkers alone when one departs', async () => {
    contributions.push(
      { pluginId: 'a', checker: checker() },
      { pluginId: 'b', checker: checker() }
    );
    const mod = await load();
    mod.syncPluginTextCheckers();
    const keep = registered.get('plugins.a.grammar');

    contributions.splice(1, 1);
    mod.syncPluginTextCheckers();

    expect([...registered.keys()]).toEqual(['plugins.a.grammar']);
    expect(keep).not.toHaveBeenCalled();
  });

  it('clears everything on teardown', async () => {
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();
    mod.clearPluginTextCheckers();
    expect(registered.size).toBe(0);
  });
});

describe('checkerProviderId', () => {
  it('namespaces the id to its plugin', async () => {
    // Two plugins may both contribute a checker called "grammar".
    const mod = await load();
    expect(mod.checkerProviderId('com.example.lt', 'grammar')).toBe(
      'plugins.com.example.lt.grammar'
    );
  });
});

/**
 * Who owns spelling. Declaring `spelling` in `kinds` says a checker CAN;
 * the plugin's own setting says whether it does — so a user can keep the
 * local dictionary without disabling the plugin.
 */
describe('spelling ownership', () => {
  // Naming the toggle is the plugin's job now — the host no longer assumes a
  // setting called `spelling` exists.
  const spellingChecker = checker({
    kinds: ['grammar', 'spelling'],
    spellingSetting: 'spelling'
  });

  it('claims spelling when the checker declares it', async () => {
    contributions.push({
      pluginId: 'com.example.lt',
      checker: spellingChecker
    });
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect(spellingOwner.id).toBe('plugins.com.example.lt.grammar');
    // Named, so the dictionary panel can explain who has spelling.
    expect(spellingOwner.label).toBe('LanguageTool');
  });

  it('leaves spelling with the dictionary when the setting is off', async () => {
    contributions.push({
      pluginId: 'com.example.lt',
      checker: spellingChecker
    });
    settings.set('plugins.com.example.lt.spelling', false);
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect(spellingOwner.id).toBeNull();
  });

  it('leaves spelling with the dictionary when the checker never claims it', async () => {
    contributions.push({ pluginId: 'com.example.lt', checker: checker() });
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect(spellingOwner.id).toBeNull();
  });

  it('releases spelling when the plugin goes away', async () => {
    contributions.push({
      pluginId: 'com.example.lt',
      checker: spellingChecker
    });
    const mod = await load();
    mod.syncPluginTextCheckers();

    contributions.length = 0;
    mod.syncPluginTextCheckers();
    expect(spellingOwner.id).toBeNull();
  });
});

/**
 * The request config the provider asks for on every check. Read lazily rather
 * than captured at registration, so changing a setting takes effect without
 * re-registering — which would drop the cached findings.
 */
describe('checker request config', () => {
  type Config = {
    endpoint: string;
    apiKey?: string;
    username?: string;
    language: string;
    preferredVariants: string[];
    disabledCategories: string[];
  } | null;

  /** Register one checker and return its `config()` reader. */
  async function configFor(
    over: Partial<PluginTextCheckerContribution> = {}
  ): Promise<() => Config> {
    contributions.push({ pluginId: 'com.example.lt', checker: checker(over) });
    const mod = await load();
    mod.syncPluginTextCheckers();
    const opts = options.get('plugins.com.example.lt.grammar');
    return opts!.config as () => Config;
  }

  it('reads the endpoint from the plugin-namespaced setting', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'https://lt.example.test');
    const config = await configFor();
    expect(config()?.endpoint).toBe('https://lt.example.test');
  });

  it('trims the endpoint the user pasted', async () => {
    settings.set(
      'plugins.com.example.lt.endpoint',
      '  https://lt.example.test  '
    );
    const config = await configFor();
    expect(config()?.endpoint).toBe('https://lt.example.test');
  });

  it('has no opinion until the server is configured', async () => {
    // An unconfigured checker must read as "did not check", not as an error
    // on every paragraph of every note.
    const config = await configFor();
    expect(config()).toBeNull();

    settings.set('plugins.com.example.lt.endpoint', '   ');
    expect(config()).toBeNull();

    settings.set('plugins.com.example.lt.endpoint', 42);
    expect(config()).toBeNull();
  });

  it('picks up a setting changed after registration', async () => {
    const config = await configFor();
    expect(config()).toBeNull();
    settings.set('plugins.com.example.lt.endpoint', 'https://lt.example.test');
    expect(config()?.endpoint).toBe('https://lt.example.test');
  });

  it('sends credentials only for the settings the manifest names', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'https://lt.example.test');
    settings.set('plugins.com.example.lt.api-key', 'secret');
    settings.set('plugins.com.example.lt.username', 'someone');

    const bare = await configFor();
    expect(bare()).toMatchObject({ apiKey: undefined, username: undefined });

    contributions.length = 0;
    const credentialed = await configFor({
      apiKeySetting: 'api-key',
      usernameSetting: 'username'
    });
    expect(credentialed()).toMatchObject({
      apiKey: 'secret',
      username: 'someone'
    });
  });

  it('names the language outright when the user writes only one', async () => {
    tags.value = ['de-DE'];
    settings.set('plugins.com.example.lt.endpoint', 'https://lt.example.test');
    const config = await configFor();
    expect(config()).toMatchObject({
      language: 'de-DE',
      preferredVariants: []
    });
  });

  it('lets the server detect, narrowed to what the user writes', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'https://lt.example.test');
    const config = await configFor();
    expect(config()).toMatchObject({
      language: 'auto',
      preferredVariants: ['de-DE', 'en-US']
    });
  });

  it('preserves the order of the selected languages', async () => {
    // Load-bearing, not incidental. When detection lands on a language that
    // is not in this list, the backend re-asks naming the FIRST entry — so
    // sorting the list, or building it from a Set that happens to reorder,
    // silently changes which dictionary those paragraphs are checked against.
    tags.value = ['en-US', 'de-DE'];
    settings.set('plugins.com.example.lt.endpoint', 'https://lt.example.test');
    const config = await configFor();
    expect(config()?.preferredVariants).toEqual(['en-US', 'de-DE']);
  });

  it('silences the service categories the plugin declared', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'https://lt.example.test');
    const config = await configFor({ disabledCategories: ['WHITESPACE'] });
    expect(config()?.disabledCategories).toEqual(['WHITESPACE']);
  });

  it('also silences its spelling rules while the dictionary owns spelling', async () => {
    settings.set('plugins.com.example.lt.endpoint', 'https://lt.example.test');
    const config = await configFor({
      kinds: ['grammar', 'spelling'],
      spellingSetting: 'spelling',
      disabledCategories: ['WHITESPACE'],
      spellingCategories: ['TYPOS']
    });

    // Handed over: the service checks spelling, so its typo rules stay on.
    expect(config()?.disabledCategories).toEqual(['WHITESPACE']);

    settings.set('plugins.com.example.lt.spelling', false);
    expect(config()?.disabledCategories).toEqual(['WHITESPACE', 'TYPOS']);
  });

  it('maps service categories to diagnostic kinds, defaulting to grammar', async () => {
    contributions.push({
      pluginId: 'com.example.lt',
      checker: checker({ categoryKinds: { TYPOS: 'spelling' } })
    });
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect(
      options.get('plugins.com.example.lt.grammar')!.categoryKinds
    ).toEqual({ map: { TYPOS: 'spelling' }, fallback: 'grammar' });
  });

  it('uses the declared default kind when a category is unmapped', async () => {
    contributions.push({
      pluginId: 'com.example.lt',
      checker: checker({ defaultKind: 'style' })
    });
    const mod = await load();
    mod.syncPluginTextCheckers();
    expect(
      options.get('plugins.com.example.lt.grammar')!.categoryKinds
    ).toEqual({ map: {}, fallback: 'style' });
  });
});
