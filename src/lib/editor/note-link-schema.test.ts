/**
 * Integration test for the note-link href neutraliser, driven through a
 * real Milkdown editor (commonmark preset) so the schema override is
 * exercised exactly the way Crepe wires it: registered via `editor.config`
 * before `create()` builds the ProseMirror schema.
 *
 * The regression it guards: a note link's rendered `<a>` must NOT carry a
 * navigable `mindstream://` href (which white-screens the Android WebView),
 * while the markdown round-trip keeps the sentinel URL intact.
 */

import { describe, expect, it } from 'vitest';
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
  serializerCtx
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { useNoteLinkHrefNeutralizer } from './note-link-schema';

async function makeEditor(markdown: string): Promise<Editor> {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark);
  useNoteLinkHrefNeutralizer(editor);
  await editor.create();
  return editor;
}

function anchorIn(editor: Editor): HTMLAnchorElement | null {
  let el: HTMLAnchorElement | null = null;
  editor.action((ctx) => {
    el = ctx.get(editorViewCtx).dom.querySelector('a');
  });
  return el;
}

function serialize(editor: Editor): string {
  let out = '';
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    out = ctx.get(serializerCtx)(view.state.doc);
  });
  return out;
}

describe('note-link href neutraliser', () => {
  it('drops the href on a note-link anchor and stashes it on data-note-href', async () => {
    const editor = await makeEditor('[Title](mindstream://note/abc-123)');
    const a = anchorIn(editor);
    expect(a).not.toBeNull();
    expect(a!.hasAttribute('href')).toBe(false);
    expect(a!.getAttribute('data-note-href')).toBe('mindstream://note/abc-123');
    await editor.destroy();
  });

  it('keeps the sentinel url in the markdown round-trip', async () => {
    const editor = await makeEditor('[Title](mindstream://note/abc-123)');
    expect(serialize(editor)).toContain('mindstream://note/abc-123');
    await editor.destroy();
  });

  it('leaves ordinary external links navigable', async () => {
    const editor = await makeEditor('[Docs](https://example.com/page)');
    const a = anchorIn(editor);
    expect(a).not.toBeNull();
    expect(a!.getAttribute('href')).toBe('https://example.com/page');
    expect(a!.hasAttribute('data-note-href')).toBe(false);
    await editor.destroy();
  });
});
