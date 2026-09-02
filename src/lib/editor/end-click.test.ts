import { describe, expect, it } from 'vitest';
import { isEditorEndClick } from './end-click';

/** A block whose box sits at [top, bottom] with a non-zero height. */
function block(top: number, bottom: number): HTMLElement {
  const el = document.createElement('p');
  Object.defineProperty(el, 'offsetHeight', { value: bottom - top });
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom,
      left: 0,
      right: 100,
      width: 100,
      height: bottom - top
    }) as DOMRect;
  return el;
}

function prose(...blocks: HTMLElement[]) {
  const pane = document.createElement('div');
  const dom = document.createElement('div');
  for (const b of blocks) dom.appendChild(b);
  pane.appendChild(dom);
  return { pane, dom };
}

describe('isEditorEndClick', () => {
  it('claims a click below the last block', () => {
    const { dom } = prose(block(0, 40));
    expect(isEditorEndClick(dom, dom, 60)).toBe(true);
  });

  it('leaves a click on the content alone', () => {
    const { dom } = prose(block(0, 40));
    expect(isEditorEndClick(dom, dom.firstChild, 20)).toBe(false);
  });

  it('claims any click in an empty document', () => {
    const { dom } = prose();
    expect(isEditorEndClick(dom, dom, 5)).toBe(true);
  });

  it('claims the padding around the content, below the last block', () => {
    const { pane, dom } = prose(block(0, 40));
    expect(isEditorEndClick(dom, pane, 60)).toBe(true);
    expect(isEditorEndClick(dom, pane, 20)).toBe(false);
  });

  it('ignores a floating widget rendered beside the editor', () => {
    // Crepe's selection toolbar and block handle live in the pane but
    // outside ProseMirror; claiming their pointerdown cancelled the
    // button and moved the caret to the end of the note.
    const { pane, dom } = prose(block(0, 40));
    const toolbar = document.createElement('div');
    toolbar.className = 'milkdown-toolbar';
    const button = document.createElement('button');
    toolbar.appendChild(button);
    pane.appendChild(toolbar);
    expect(isEditorEndClick(dom, button, 60)).toBe(false);
    expect(isEditorEndClick(dom, toolbar, 60)).toBe(false);
  });

  it('ignores a missing target', () => {
    const { dom } = prose(block(0, 40));
    expect(isEditorEndClick(dom, null, 60)).toBe(false);
  });

  it('skips remote-cursor widgets when finding the last block', () => {
    const { dom } = prose(block(0, 40));
    const cursor = document.createElement('span');
    cursor.className = 'ProseMirror-yjs-cursor';
    Object.defineProperty(cursor, 'offsetHeight', { value: 12 });
    cursor.getBoundingClientRect = () => ({ top: 200, bottom: 212 }) as DOMRect;
    dom.appendChild(cursor);
    expect(isEditorEndClick(dom, dom, 60)).toBe(true);
  });
});
