import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { createNoteIn } from '$lib/stores/tree.svelte';

type RootNoteKind = 'markdown' | 'freeform' | 'ink' | 'kanban';

function rootNoteTitle(kind: RootNoteKind): string {
  switch (kind) {
    case 'freeform':
      return 'Untitled drawing canvas';
    case 'ink':
      return 'Untitled handwritten note';
    case 'kanban':
      return 'Untitled board';
    case 'markdown':
      return 'Untitled';
  }
}

export async function createRootNote(kind: RootNoteKind) {
  const id = await createNoteIn(null, rootNoteTitle(kind), kind);
  requestOpenNote(id);
}
