import { requestOpenNote } from '$lib/stores/open-note-intent.svelte';
import { createNoteIn } from '$lib/stores/tree.svelte';
import { tUi } from '$lib/settings/i18n.svelte';

type RootNoteKind = 'markdown' | 'freeform' | 'ink' | 'kanban';

function rootNoteTitle(kind: RootNoteKind): string {
  switch (kind) {
    case 'freeform':
      return tUi('fileTree.draft.drawing');
    case 'ink':
      return tUi('fileTree.draft.ink');
    case 'kanban':
      return tUi('fileTree.draft.kanban');
    case 'markdown':
      return tUi('fileTree.fallback.noteTitle');
  }
}

export async function createRootNote(kind: RootNoteKind) {
  const id = await createNoteIn(null, rootNoteTitle(kind), kind);
  requestOpenNote(id);
}
