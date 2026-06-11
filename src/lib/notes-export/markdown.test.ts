import { describe, expect, it } from 'vitest';
import type { Note } from '$lib/api';
import {
  extractAssetIds,
  renderFrontmatter,
  renderMarkdownFile,
  rewriteAssetUrls
} from './markdown';

describe('renderFrontmatter', () => {
  it('emits a YAML block with all required keys', () => {
    const out = renderFrontmatter({
      title: 'Hello',
      id: 'note_abc',
      kind: 'markdown',
      created: '2026-06-10T14:00:00Z',
      modified: '2026-06-11T15:00:00Z',
      tags: [],
      favourite: false
    });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('title: Hello');
    expect(out).toContain('id: note_abc');
    expect(out).toContain('kind: markdown');
    expect(out).toContain('created: 2026-06-10T14:00:00Z');
    expect(out).toContain('modified: 2026-06-11T15:00:00Z');
    // Omits the favourite field when false.
    expect(out).not.toContain('favourite:');
    // Omits the tags block when empty.
    expect(out).not.toContain('tags:');
    expect(out.trim().endsWith('---')).toBe(true);
  });

  it('includes favourite + tags when present', () => {
    const out = renderFrontmatter({
      title: 'Hello',
      id: 'note_x',
      kind: 'markdown',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-02T00:00:00Z',
      tags: ['work', 'urgent'],
      favourite: true
    });
    expect(out).toContain('favourite: true');
    expect(out).toContain('tags:');
    expect(out).toContain('  - work');
    expect(out).toContain('  - urgent');
  });

  it('quotes strings that would confuse a YAML parser', () => {
    const out = renderFrontmatter({
      title: 'Title with: colon and "quotes"',
      id: 'note_x',
      kind: 'markdown',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-01T00:00:00Z',
      tags: ['has: colon'],
      favourite: false
    });
    // Title with the colon must be double-quoted with the inner
    // quotes escaped.
    expect(out).toMatch(/title: "Title with: colon and \\"quotes\\""/);
    expect(out).toMatch(/  - "has: colon"/);
  });
});

describe('extractAssetIds', () => {
  it('returns unique ids in encounter order', () => {
    const body =
      'See ![](mindstream-asset://asset_a) and ![](mindstream-asset://asset_b) and again ![](mindstream-asset://asset_a).';
    expect(extractAssetIds(body)).toEqual(['asset_a', 'asset_b']);
  });

  it('returns an empty list when no references exist', () => {
    expect(extractAssetIds('plain markdown, no images')).toEqual([]);
  });
});

describe('rewriteAssetUrls', () => {
  it('rewrites known ids to relative paths under the subdir', () => {
    const body =
      '![alt](mindstream-asset://asset_a) and ![alt](mindstream-asset://asset_b)';
    const filenames = new Map([
      ['asset_a', 'asset_a.png'],
      ['asset_b', 'asset_b.jpg']
    ]);
    const out = rewriteAssetUrls(body, '_assets', (id) => filenames.get(id));
    expect(out).toContain('![alt](_assets/asset_a.png)');
    expect(out).toContain('![alt](_assets/asset_b.jpg)');
  });

  it('leaves unknown ids untouched so nothing is silently dropped', () => {
    const body = 'orphan ![](mindstream-asset://asset_missing)';
    const out = rewriteAssetUrls(body, '_assets', () => undefined);
    expect(out).toContain('mindstream-asset://asset_missing');
  });
});

describe('renderMarkdownFile', () => {
  it('prepends frontmatter to the rewritten body', () => {
    const note = {
      id: 'note_x',
      title: 'My note',
      note_kind: 'markdown',
      created: '2026-01-01T00:00:00Z',
      modified: '2026-01-02T00:00:00Z',
      tags: ['work'],
      favourite: false,
      body: '# Heading',
      yrs_state: [],
      payload_schema: 2,
      parent_collection_id: null,
      position: 0,
      trashed: false,
      pushed: false
    } as unknown as Note;
    const out = renderMarkdownFile(note, '# Heading');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('title: My note');
    expect(out).toContain('# Heading');
    expect(out.indexOf('---', 3)).toBeLessThan(out.indexOf('# Heading'));
  });
});
