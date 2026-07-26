import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  language: 'de',
  isTauri: vi.fn(() => true),
  readDoc: vi.fn<(id: string, file: string) => Promise<string | null>>()
}));

vi.mock('$lib/api/core', () => ({ isTauri: h.isTauri }));
vi.mock('$lib/api/plugins', () => ({ pluginsReadDoc: h.readDoc }));
vi.mock('$lib/settings/i18n.svelte', () => ({
  get i18n() {
    return { language: h.language };
  }
}));

import {
  docCandidates,
  extractDocTitle,
  loadDocSection,
  loadPluginDocs
} from './docs-loader';

beforeEach(() => {
  h.language = 'de';
  h.isTauri.mockReturnValue(true);
  h.readDoc.mockReset();
});

describe('docCandidates', () => {
  it('prefers the active-locale variant, then the base file', () => {
    expect(docCandidates('docs/guide.md', 'de')).toEqual([
      'docs/guide.de.md',
      'docs/guide.md'
    ]);
  });
});

describe('extractDocTitle', () => {
  it('uses the first H1', () => {
    expect(extractDocTitle('# Getting started\n\nText', 'docs/x.md')).toBe(
      'Getting started'
    );
  });

  it('falls back to a prettified filename (locale + order prefix stripped)', () => {
    expect(
      extractDocTitle('no heading here', 'docs/01-getting-started.de.md')
    ).toBe('getting started');
  });
});

describe('loadDocSection', () => {
  it('loads the localized variant when present', async () => {
    h.readDoc.mockImplementation(async (_id, file) =>
      file === 'docs/guide.de.md' ? '# Anleitung' : null
    );
    const s = await loadDocSection('com.x', { file: 'docs/guide.md' });
    expect(h.readDoc).toHaveBeenCalledWith('com.x', 'docs/guide.de.md');
    expect(s?.title).toBe('Anleitung');
    expect(s?.markdown).toBe('# Anleitung');
  });

  it('falls back to the base file when the locale variant is missing', async () => {
    h.readDoc.mockImplementation(async (_id, file) =>
      file === 'docs/guide.md' ? '# Guide' : null
    );
    const s = await loadDocSection('com.x', { file: 'docs/guide.md' });
    expect(s?.title).toBe('Guide');
  });

  it('returns null when no candidate resolves', async () => {
    h.readDoc.mockResolvedValue(null);
    expect(
      await loadDocSection('com.x', { file: 'docs/missing.md' })
    ).toBeNull();
  });
});

describe('loadPluginDocs', () => {
  it('keeps declaration order and drops unresolved sections', async () => {
    h.readDoc.mockImplementation(async (_id, file) =>
      file === 'docs/a.md' ? '# A' : file === 'docs/c.md' ? '# C' : null
    );
    const out = await loadPluginDocs('com.x', [
      { file: 'docs/a.md' },
      { file: 'docs/b.md' }, // resolves to nothing → dropped
      { file: 'docs/c.md' }
    ]);
    expect(out.map((s) => s.title)).toEqual(['A', 'C']);
  });
});
