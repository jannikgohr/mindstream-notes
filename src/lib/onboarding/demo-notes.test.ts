/**
 * Demo notes are named after the document they start from (see
 * ./demo-notes.ts and src-tauri/src/demo_notes.rs). That only works if
 *
 *   - the same text always renders to the same bytes, and
 *   - opening the note in the real editor writes nothing: an edit made on
 *     open would carry each device's own client id, and two devices holding
 *     the same note would merge two copies of it (a second trailing
 *     paragraph, say).
 *
 * These run the editor the app runs, on every file under `./demo-notes/`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { DemoNote } from '$lib/api/onboarding';
import {
  editorViewCtx,
  getDoc,
  parserCtx,
  schemaCtx,
  serializerCtx
} from '@milkdown/kit/core';
import { collabServiceCtx } from '@milkdown/plugin-collab';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { buildCrepe } from '$lib/editor/crepe-setup';
import {
  createMarkdownSearchBridge,
  createUserMentionBridge,
  createWikilinkBridge
} from '$lib/editor/plugins';
import { AVAILABLE_LANGUAGES } from '$lib/settings/i18n.svelte';
import {
  demoNotes,
  demoSources,
  parseDemoSource,
  renderDemoNote
} from './demo-notes';
import { demoNoteId } from './demo-note-id';

/** Every node a demo note may use: plain Markdown that every version of the
 *  app knows. An editor deletes a node it doesn't know, and the deletion
 *  syncs. Images need attachments, which demo notes don't have. */
const PLAIN_NODES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'code_block',
  'hr',
  'hardbreak',
  'bullet_list',
  'ordered_list',
  'list_item',
  'table',
  'table_header_row',
  'table_row',
  'table_header',
  'table_cell'
]);

function nodeNames(state: number[]): Set<string> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Uint8Array.from(state));
  const names = new Set<string>();
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        names.add(child.nodeName);
        walk(child);
      }
    }
  };
  walk(doc.getXmlFragment('prosemirror'));
  doc.destroy();
  return names;
}

/** Open a note's state the way NoteEditor does, with every plugin on, and
 *  count what the editor writes back to the document. */
async function open(
  state: Uint8Array,
  mathEnabled: boolean
): Promise<{ updates: number; markdown: string }> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const host = document.createElement('div');
  document.body.append(host);
  const crepe = buildCrepe({
    host,
    mobile: false,
    mathEnabled,
    autoPairEnabled: true,
    mermaidEnabled: true,
    wikilinksEnabled: true,
    wikilinkOpenOnClick: () => true,
    wikilinkBridge: createWikilinkBridge(),
    userMentionsEnabled: true,
    userMentionBridge: createUserMentionBridge(),
    currentUsername: () => 'ada',
    searchBridge: createMarkdownSearchBridge(),
    assetBridge: {
      uploadFile: async () => '',
      resolveUrl: (url) => url,
      invalidate: () => [],
      dispose: () => {}
    }
  });
  await crepe.create();
  let updates = 0;
  doc.on('update', () => updates++);
  crepe.editor.action((ctx) => {
    const collab = ctx.get(collabServiceCtx);
    collab.bindDoc(doc);
    collab.connect();
  });
  // y-prosemirror renders on a zero-delay timer, and the plugins answer
  // that render.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const markdown = crepe.editor.action((ctx) =>
    ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc)
  );
  await crepe.destroy();
  host.remove();
  doc.destroy();
  return { updates, markdown };
}

describe('the demo-notes directory', () => {
  const rendered = new Map<string, DemoNote[]>();
  beforeAll(async () => {
    for (const lang of AVAILABLE_LANGUAGES)
      rendered.set(lang, await demoNotes(lang));
  });
  it('holds notes, each with an English file to fall back to', () => {
    expect(demoSources('en').length).toBeGreaterThan(0);
    expect(demoSources('xx').map((note) => note.lang)).toEqual(
      demoSources('en').map(() => 'en')
    );
  });

  it.each(AVAILABLE_LANGUAGES)('has every note in %s', (lang) => {
    const notes = demoSources(lang);
    expect(notes.map((note) => note.lang)).toEqual(notes.map(() => lang));
    expect(notes.map((note) => note.slug)).toEqual(
      demoSources('en').map((note) => note.slug)
    );
  });

  it.each(AVAILABLE_LANGUAGES.flatMap((lang) => demoSources(lang)))(
    '$slug in $lang opens without a change and uses plain Markdown',
    async ({ slug, lang }) => {
      const note = rendered.get(lang)!.find((note) => note.slug === slug)!;
      for (const node of nodeNames(note.yrsState)) {
        expect(PLAIN_NODES, node).toContain(node);
      }
      for (const mathEnabled of [false, true]) {
        const opened = await open(Uint8Array.from(note.yrsState), mathEnabled);
        expect(opened.updates).toBe(0);
        expect(opened.markdown).toBe(note.body);
      }
    }
  );
});

describe('renderDemoNote', () => {
  it('renders the same text to the same bytes', async () => {
    const markdown = '# Title\n\nSome **text**.\n\n- a list\n';
    const first = await renderDemoNote(markdown);
    const second = await renderDemoNote(markdown);
    expect(second).toEqual(first);
    expect(first.body).toContain('# Title');
    expect((await renderDemoNote('# Other\n')).yrsState).not.toEqual(
      first.yrsState
    );
  });

  it('settles what opening would otherwise change', async () => {
    // The check above would pass for nothing if opening never wrote
    // anything. Unsettled, this text gets a heading id and a trailing
    // paragraph on open.
    const markdown = '# Title\n\n- ends in a list\n';
    const host = document.createElement('div');
    const crepe = buildCrepe({
      host,
      mobile: true,
      mathEnabled: false,
      autoPairEnabled: false,
      mermaidEnabled: false,
      wikilinksEnabled: false,
      wikilinkOpenOnClick: () => false,
      wikilinkBridge: null,
      userMentionsEnabled: false,
      userMentionBridge: null,
      currentUsername: () => null,
      searchBridge: createMarkdownSearchBridge(),
      assetBridge: {
        uploadFile: async () => '',
        resolveUrl: (url) => url,
        invalidate: () => [],
        dispose: () => {}
      }
    });
    await crepe.create();
    const raw = new Y.Doc();
    crepe.editor.action((ctx) => {
      const node = getDoc(markdown, ctx.get(parserCtx), ctx.get(schemaCtx))!;
      prosemirrorToYXmlFragment(node, raw.getXmlFragment('prosemirror'));
    });
    await crepe.destroy();
    expect(
      (await open(Y.encodeStateAsUpdate(raw), false)).updates
    ).toBeGreaterThan(0);
    const settled = await renderDemoNote(markdown);
    expect((await open(Uint8Array.from(settled.yrsState), false)).updates).toBe(
      0
    );
  });
});

describe('demoSources', () => {
  const files = {
    './demo-notes/welcome/en.md': '---\ntitle: Welcome\n---\n\n# Hi\n',
    './demo-notes/welcome/de.md':
      '---\r\ntitle: Willkommen\r\n---\r\n\r\n# Hallo\r\n',
    './demo-notes/basics/en.md': '---\ntitle: Basics\n---\nText\n'
  };

  it('picks the language, falls back to English and opens welcome first', () => {
    expect(demoSources('de', files)).toEqual([
      {
        slug: 'welcome',
        lang: 'de',
        title: 'Willkommen',
        markdown: '\n# Hallo\n'
      },
      { slug: 'basics', lang: 'en', title: 'Basics', markdown: 'Text\n' }
    ]);
  });

  it('refuses a file outside the rules', () => {
    expect(() =>
      parseDemoSource('/demo-notes/Welcome/en.md', '---\ntitle: A\n---\n')
    ).toThrow(/expected demo-notes/);
    expect(() =>
      parseDemoSource('/demo-notes/welcome/en-GB.md', '---\ntitle: A\n---\n')
    ).toThrow(/expected demo-notes/);
    expect(() =>
      parseDemoSource('/demo-notes/welcome/en.md', '# No front matter\n')
    ).toThrow(/front matter/);
    expect(() =>
      parseDemoSource(
        '/demo-notes/welcome/en.md',
        '---\ntitle: A\nauthor: B\n---\n'
      )
    ).toThrow(/front matter/);
  });
});

describe('demoNotes', () => {
  it.each(AVAILABLE_LANGUAGES)(
    'renders linked notes in %s for the backend',
    async (lang) => {
      const notes = await demoNotes(lang);
      expect(notes.map(({ slug, lang }) => ({ slug, lang }))).toEqual(
        demoSources(lang).map(({ slug, lang }) => ({ slug, lang }))
      );
      expect(notes[0].slug).toBe('welcome');
      const ids = new Set(await Promise.all(notes.map(demoNoteId)));
      for (const note of notes) {
        expect(note.title).not.toBe('');
        expect(note.yrsState.length).toBeGreaterThan(0);
        expect(note.body).toContain('#');
        expect(note.body).not.toContain('](demo:');
        for (const match of note.body.matchAll(
          /mindstream:\/\/note\/([^\s)]+)/g
        ))
          expect(ids.has(match[1]), `${note.slug} links to ${match[1]}`).toBe(
            true
          );
      }
      const sync = notes.find((note) => note.slug === 'sync')!;
      expect(notes[0].body).toContain(
        `mindstream://note/${await demoNoteId(sync)}`
      );
    }
  );

  const files = {
    './demo-notes/welcome/de.md':
      '---\ntitle: Willkommen\n---\n[Sync](demo:sync)\n\n`[Example](demo:missing)`\n',
    './demo-notes/welcome/en.md':
      '---\ntitle: Welcome\n---\n[Sync](demo:sync)\n',
    './demo-notes/sync/en.md': '---\ntitle: Sync\n---\n# Offline edits\n'
  };

  it('links to the English fallback and leaves code examples untouched', async () => {
    const notes = await demoNotes('de', files);
    expect(notes.map((note) => note.lang)).toEqual(['de', 'en']);
    expect(notes[0].body).toContain(
      `mindstream://note/${await demoNoteId(notes[1])}`
    );
    expect(notes[0].body).toContain('`[Example](demo:missing)`');
    expect(await demoNotes('de', files)).toEqual(notes);
  });

  it('updates links and the source ID when the target content changes', async () => {
    const first = await demoNotes('en', files);
    const changed = await demoNotes('en', {
      ...files,
      './demo-notes/sync/en.md':
        '---\ntitle: Sync\n---\n# Updated explanation\n'
    });
    expect(changed[0].body).toContain(
      `mindstream://note/${await demoNoteId(changed[1])}`
    );
    expect(await demoNoteId(changed[0])).not.toBe(await demoNoteId(first[0]));
  });

  it.each([
    ['[Missing](demo:missing)', 'unknown demo note'],
    ['[Self](demo:welcome)', 'cyclic demo link'],
    ['[Sync](demo:sync)', 'cyclic demo link']
  ])('rejects invalid links: %s', async (markdown, error) => {
    await expect(
      demoNotes('en', {
        './demo-notes/welcome/en.md': `---\ntitle: Welcome\n---\n${markdown}\n`,
        './demo-notes/sync/en.md':
          '---\ntitle: Sync\n---\n[Welcome](demo:welcome)\n'
      })
    ).rejects.toThrow(error);
  });
});
