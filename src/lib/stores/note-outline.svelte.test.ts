import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  noteOutline,
  registerNoteOutline,
  scrollToNoteHeading
} from './note-outline.svelte';

const cleanups: Array<() => void> = [];

function editor(markup: string) {
  const root = document.createElement('div');
  root.innerHTML = `<div class="ProseMirror">${markup}</div>`;
  return root;
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe('note outline', () => {
  it('tracks heading text, hierarchy, and deletion as the editor changes', async () => {
    const root = editor('<h1>Title</h1><h2>Section</h2><h2></h2><p>Body</p>');
    cleanups.push(registerNoteOutline('note', root));
    expect(noteOutline.byNote.note).toEqual([
      { title: 'Title', level: 1 },
      { title: 'Section', level: 2 }
    ]);

    root.querySelector('h2')!.textContent = 'Revised';
    root.querySelector('h1')!.remove();
    await vi.waitFor(() => {
      expect(noteOutline.byNote.note).toEqual([{ title: 'Revised', level: 2 }]);
    });
  });

  it('scrolls within the requested note and clears closed editors', () => {
    const first = editor('<h2>First note</h2>');
    const second = editor('<h2>Second note</h2>');
    const firstScroll = vi.fn();
    const secondScroll = vi.fn();
    first.querySelector('h2')!.scrollIntoView = firstScroll;
    second.querySelector('h2')!.scrollIntoView = secondScroll;
    cleanups.push(registerNoteOutline('first', first));
    const closeSecond = registerNoteOutline('second', second);
    cleanups.push(closeSecond);

    scrollToNoteHeading('second', 0);
    expect(secondScroll).toHaveBeenCalledWith({ block: 'start' });
    expect(firstScroll).not.toHaveBeenCalled();
    closeSecond();
    expect(noteOutline.byNote.second).toBeUndefined();
    scrollToNoteHeading('second', 0);
    expect(secondScroll).toHaveBeenCalledTimes(1);
  });

  it('does not let an older editor overwrite or clear a replacement', async () => {
    const oldRoot = editor('<h1>Old</h1>');
    const closeOld = registerNoteOutline('same', oldRoot);
    cleanups.push(
      closeOld,
      registerNoteOutline('same', editor('<h1>New</h1>'))
    );
    oldRoot.querySelector('h1')!.textContent = 'Stale';
    await Promise.resolve();
    closeOld();
    expect(noteOutline.byNote.same).toEqual([{ title: 'New', level: 1 }]);
  });
});
