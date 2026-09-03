/**
 * The dictionary panel groups a fifteen-entry catalogue into "needs
 * attention", "installed" and "everything else", and only the first two are
 * shown up front. The e2e suite (`spellcheck.e2e.ts`) covers the install and
 * remove round-trips against a real dictionary on disk; what it cannot cheaply
 * reach is the grouping itself, because seeding one dictionary says nothing
 * about where the other fourteen went. That is what this covers.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const availableDictionaries = vi.fn();

vi.mock('$lib/api/spellcheck', () => ({
  spellcheckAvailableDictionaries: () => availableDictionaries(),
  spellcheckInstallDictionary: vi.fn(async () => {}),
  spellcheckRemoveDictionary: vi.fn(async () => {})
}));

const selectedLanguages = vi.fn<() => string[]>();

vi.mock('$lib/settings/store.svelte', () => ({
  getSettingValue: (id: string) =>
    id === 'language.spellcheck.languages' ? selectedLanguages() : undefined
}));

vi.mock('$lib/diagnostics/editor-diagnostics.svelte', () => ({
  reloadSpellcheckConfig: vi.fn(async () => {}),
  spellingOwner: () => null
}));

import SpellcheckDictionaries from './SpellcheckDictionaries.svelte';

/** `de_DE_frami` is selected but missing — the silent-failure combination. */
const CATALOGUE = [
  {
    id: 'en_US',
    bcp47: 'en-US',
    license: 'MIT',
    sourceUrl: 'https://example.invalid/en',
    installed: true
  },
  {
    id: 'de_DE_frami',
    bcp47: 'de-DE',
    license: 'GPL-2.0',
    sourceUrl: 'https://example.invalid/de',
    installed: false
  },
  {
    id: 'fr',
    bcp47: 'fr-FR',
    license: 'MPL-2.0',
    sourceUrl: 'https://example.invalid/fr',
    installed: false
  }
];

/**
 * The panel loads its catalogue in an effect, so nothing is on screen until
 * that resolves. `settled` is a label the finished render is guaranteed to
 * carry — which one depends on what the search leaves visible.
 */
async function renderPanel(searchQuery = '', settled = 'English (US)') {
  render(SpellcheckDictionaries, { searchQuery });
  await screen.findByText(settled);
}

describe('SpellcheckDictionaries', () => {
  beforeEach(() => {
    availableDictionaries.mockResolvedValue(CATALOGUE);
    selectedLanguages.mockReturnValue(['en_US', 'de_DE_frami']);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows installed and unmet languages, and hides the rest of the catalogue', async () => {
    await renderPanel();

    expect(
      screen.getByRole('button', { name: 'Remove English (US)' })
    ).toBeTruthy();
    expect(screen.getByText('German (Germany)')).toBeTruthy();
    expect(screen.getByText('Selected but not installed')).toBeTruthy();

    // Neither selected nor installed: catalogue material, not state.
    expect(screen.queryByText('French')).toBeNull();
    expect(
      screen.getByRole('button', { name: /Browse more languages \(1\)/ })
    ).toBeTruthy();
  });

  it('reveals the rest of the catalogue on request', async () => {
    await renderPanel();

    await fireEvent.click(
      screen.getByRole('button', { name: /Browse more languages/ })
    );

    expect(screen.getByText('French')).toBeTruthy();
    // The licence rides along with every row that still offers a download.
    expect(screen.getByText('MPL-2.0')).toBeTruthy();
  });

  it('opens the catalogue while a settings search is active', async () => {
    await renderPanel('french', 'French');

    expect(screen.getByText('French')).toBeTruthy();
    expect(screen.queryByText('German (Germany)')).toBeNull();
  });

  it('says so when this device has no dictionaries at all', async () => {
    selectedLanguages.mockReturnValue([]);
    availableDictionaries.mockResolvedValue([
      { ...CATALOGUE[0], installed: false }
    ]);
    render(SpellcheckDictionaries, { searchQuery: '' });

    expect(
      await screen.findByText('No dictionaries installed on this device yet.')
    ).toBeTruthy();
  });
});
