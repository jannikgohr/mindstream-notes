export interface NoteOutlineHeading {
  title: string;
  level: number;
}

export const noteOutline = $state<{
  byNote: Record<string, NoteOutlineHeading[]>;
}>({ byNote: {} });

// Internal DOM registrations are deliberately non-reactive; only the heading list is UI state.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- DOM registrations must not subscribe editor effects.
const editors = new Map<string, { headings: HTMLElement[] }>();

/** Observe rendered headings so the outline follows edits and collaboration. */
export function registerNoteOutline(noteId: string, root: HTMLElement) {
  const editor = { headings: [] as HTMLElement[] };
  editors.set(noteId, editor);

  function update() {
    if (editors.get(noteId) !== editor) return;
    editor.headings = Array.from(
      root.querySelectorAll<HTMLElement>(
        '.ProseMirror :is(h1, h2, h3, h4, h5, h6)'
      )
    ).filter((heading) => heading.textContent?.trim());
    noteOutline.byNote[noteId] = editor.headings.map((heading) => ({
      title: heading.textContent!.trim(),
      level: Number(heading.tagName.slice(1))
    }));
  }

  update();
  const observer = new MutationObserver(update);
  observer.observe(root, {
    childList: true,
    characterData: true,
    subtree: true
  });

  return () => {
    observer.disconnect();
    if (editors.get(noteId) !== editor) return;
    editors.delete(noteId);
    delete noteOutline.byNote[noteId];
  };
}

export function scrollToNoteHeading(noteId: string, index: number) {
  editors.get(noteId)?.headings[index]?.scrollIntoView({ block: 'start' });
}
