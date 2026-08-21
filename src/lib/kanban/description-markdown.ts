/**
 * Milkdown-backed renderer for compact Kanban descriptions.
 *
 * One detached editor is shared by every card. It provides the same CommonMark
 * parser and ProseMirror DOM serializer as the note editor without mounting an
 * editor per card. Generated HTML is cached in the board document on save.
 */

import {
  Editor,
  getDoc,
  parserCtx,
  rootCtx,
  schemaCtx
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { DOMSerializer } from 'prosemirror-model';

const ALLOWED_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'em',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'ul'
]);

let rendererPromise: Promise<Editor> | null = null;

function renderer(): Promise<Editor> {
  if (rendererPromise) return rendererPromise;
  rendererPromise = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, document.createElement('div'));
    })
    .use(commonmark)
    .create();
  return rendererPromise;
}

function safeHref(value: string): boolean {
  return /^(https?:|mailto:)/i.test(value.trim());
}

function sanitizeElement(element: Element): void {
  for (const child of [...element.children]) sanitizeElement(child);

  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const paragraph = element.ownerDocument.createElement('p');
    paragraph.append(...element.childNodes);
    element.replaceWith(paragraph);
    return;
  }

  if (!ALLOWED_TAGS.has(tag)) {
    element.replaceWith(...element.childNodes);
    return;
  }

  const href = tag === 'a' ? (element.getAttribute('href') ?? '') : '';
  for (const attribute of [...element.attributes]) {
    element.removeAttribute(attribute.name);
  }
  if (tag === 'a') {
    if (safeHref(href)) {
      element.setAttribute('href', href);
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noreferrer');
    } else {
      element.replaceWith(...element.childNodes);
    }
  }
}

/** Sanitize cached HTML before it enters Svelte's `{@html}` block. */
export function sanitizeKanbanDescriptionHtml(html: string): string {
  if (!html || typeof document === 'undefined') return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const child of [...template.content.children]) sanitizeElement(child);
  return template.innerHTML;
}

export async function renderKanbanDescription(
  markdown: string
): Promise<string> {
  if (!markdown.trim() || typeof document === 'undefined') return '';
  const editor = await renderer();
  const html = editor.action((ctx) => {
    const schema = ctx.get(schemaCtx);
    const doc = getDoc(markdown, ctx.get(parserCtx), schema);
    const host = document.createElement('div');
    host.append(
      DOMSerializer.fromSchema(schema).serializeFragment(doc.content, {
        document
      })
    );
    return host.innerHTML;
  });
  return sanitizeKanbanDescriptionHtml(html);
}
