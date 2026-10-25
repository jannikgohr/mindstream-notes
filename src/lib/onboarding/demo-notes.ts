/**
 * Demo notes: the example notes setup can add to a new vault.
 *
 * Their text lives alongside this file under `demo-notes/<slug>/<lang>.md`.
 * The build picks up every file there. At setup the editor turns each file into
 * the document the note starts from, and the backend names the note after a
 * hash of that document (src-tauri/src/demo_notes.rs). Two devices that render
 * the same bytes therefore hold the same note and sync merges their edits,
 * while changed text or another editor version makes a separate note. An app
 * update never touches a note that exists.
 */

import {
  editorViewCtx,
  getDoc,
  parserCtx,
  schemaCtx,
  serializerCtx
} from '@milkdown/kit/core';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import type { DemoNote } from '$lib/api/onboarding';
import type { AssetBridge } from '$lib/assets/bridge';
import { buildCrepe } from '$lib/editor/crepe-setup';
import { createMarkdownSearchBridge } from '$lib/editor/plugins';
import { TEMPLATE_ORIGIN_CLIENT_ID } from '$lib/editor/seed-template';
import { noteHref } from '$lib/editor/plugins/wikilink-href';
import { demoNoteId } from './demo-note-id';

/** A note without a file in the chosen language comes in this one. */
const FALLBACK_LANGUAGE = 'en';

const FILES = import.meta.glob<string>('./demo-notes/*/*.md', {
  query: '?raw',
  import: 'default',
  eager: true
});

// A demo note has no attachments, but the editor wants a bridge.
const NO_ASSETS: AssetBridge = {
  uploadFile: () => Promise.reject(new Error('demo notes have no attachments')),
  resolveUrl: (url) => url,
  invalidate: () => [],
  dispose: () => {}
};

export interface DemoSource {
  slug: string;
  lang: string;
  title: string;
  markdown: string;
}

/**
 * Read one file. A path or front matter outside the rules throws, so a bad
 * file fails the tests rather than someone's setup.
 */
export function parseDemoSource(path: string, raw: string): DemoSource {
  const place = /\/demo-notes\/([a-z0-9-]+)\/([a-z]{2,3})\.md$/.exec(path);
  if (!place) throw new Error(`${path}: expected demo-notes/<slug>/<lang>.md`);
  // A Windows checkout can turn the line endings into CRLF.
  const text = raw.replace(/\r\n?/g, '\n');
  const front = /^---\ntitle: (.+)\n---\n/.exec(text);
  if (!front) throw new Error(`${path}: expected front matter with a title`);
  return {
    slug: place[1],
    lang: place[2],
    title: front[1].trim(),
    markdown: text.slice(front[0].length)
  };
}

/** Every demo note in `lang`, welcome first and then in slug order. */
export function demoSources(
  lang: string,
  files: Record<string, string> = FILES
): DemoSource[] {
  const bySlug = new Map<string, Map<string, DemoSource>>();
  for (const [path, raw] of Object.entries(files)) {
    const source = parseDemoSource(path, raw);
    const languages = bySlug.get(source.slug) ?? new Map();
    languages.set(source.lang, source);
    bySlug.set(source.slug, languages);
  }
  const slugs = [...bySlug.keys()].sort();
  if (bySlug.has('welcome')) {
    slugs.splice(slugs.indexOf('welcome'), 1);
    slugs.unshift('welcome');
  }
  return slugs.flatMap((slug) => {
    const languages = bySlug.get(slug)!;
    const source = languages.get(lang) ?? languages.get(FALLBACK_LANGUAGE);
    return source ? [source] : [];
  });
}

/**
 * The editor document a demo note starts from, and its markdown.
 *
 * Nothing here may depend on the device or the user's settings, or two
 * devices would name the same text differently. Math stays off, so a `$` in
 * the text never becomes a node that an editor without math would delete.
 */
export async function renderDemoNote(
  markdown: string,
  resolveLink?: (slug: string) => Promise<string>
): Promise<{ yrsState: number[]; body: string }> {
  const crepe = buildCrepe({
    host: document.createElement('div'),
    // Only what shapes the document matters here. `mobile` spares a hidden
    // editor its block handle and toolbar.
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
    assetBridge: NO_ASSETS
  });
  await crepe.create();
  try {
    const doc = crepe.editor.action((ctx) =>
      getDoc(markdown, ctx.get(parserCtx), ctx.get(schemaCtx))
    );
    if (!doc) throw new Error('demo note has no content');
    const links = new Map<string, string>();
    doc.descendants((node) => {
      for (const mark of node.marks) {
        const href: unknown = mark.attrs.href;
        if (
          mark.type.name === 'link' &&
          typeof href === 'string' &&
          href.startsWith('demo:')
        )
          links.set(href, href.slice('demo:'.length));
      }
    });
    for (const [href, slug] of links) {
      if (!resolveLink) throw new Error(`unresolved demo link: ${href}`);
      links.set(href, noteHref(await resolveLink(slug)));
    }
    return crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // Load it the way y-prosemirror does when a note opens: one
      // transaction that replaces the document. The editor's plugins answer
      // it (heading ids, a trailing paragraph), so the stored document is one
      // that opening the note leaves as it is.
      const transaction = view.state.tr.replaceWith(
        0,
        view.state.doc.content.size,
        doc.content
      );
      transaction.doc.descendants((node, pos) => {
        for (const mark of node.marks) {
          const href = links.get(mark.attrs.href);
          if (mark.type.name !== 'link' || !href) continue;
          transaction.removeMark(pos, pos + node.nodeSize, mark);
          transaction.addMark(
            pos,
            pos + node.nodeSize,
            mark.type.create({ ...mark.attrs, href })
          );
        }
      });
      view.dispatch(transaction);
      const yDoc = new Y.Doc();
      yDoc.clientID = TEMPLATE_ORIGIN_CLIENT_ID;
      prosemirrorToYXmlFragment(
        view.state.doc,
        yDoc.getXmlFragment('prosemirror')
      );
      const yrsState = Array.from(Y.encodeStateAsUpdate(yDoc));
      yDoc.destroy();
      return { yrsState, body: ctx.get(serializerCtx)(view.state.doc) };
    });
  } finally {
    await crepe.destroy();
  }
}

/** The demo notes for a new vault in `lang`, ready for `finishOnboarding`. */
export async function demoNotes(
  lang: string,
  files: Record<string, string> = FILES
): Promise<DemoNote[]> {
  const sources = demoSources(lang, files);
  const bySlug = new Map(sources.map((source) => [source.slug, source]));
  const notes = new Map<string, DemoNote>();
  const ids = new Map<string, string>();
  const visiting = new Set<string>();
  async function build(slug: string): Promise<string> {
    const id = ids.get(slug);
    if (id) return id;
    const source = bySlug.get(slug);
    if (!source) throw new Error(`unknown demo note: ${slug}`);
    if (visiting.has(slug)) throw new Error(`cyclic demo link: ${slug}`);
    visiting.add(slug);
    try {
      const rendered = await renderDemoNote(source.markdown, build);
      const note = {
        slug,
        lang: source.lang,
        title: source.title,
        ...rendered
      };
      const id = await demoNoteId(note);
      notes.set(slug, note);
      ids.set(slug, id);
      return id;
    } finally {
      visiting.delete(slug);
    }
  }
  for (const source of sources) await build(source.slug);
  return sources.map(({ slug }) => notes.get(slug)!);
}
