export type LazyNoteKind = string | null | undefined;
export type LazyNoteComponent = unknown;

type ComponentModule = {
  default: LazyNoteComponent;
};

type ComponentLoader = () => Promise<ComponentModule>;

const loaders = {
  markdown: () => import('$lib/components/NoteEditor.svelte'),
  freeform: () => import('$lib/components/FreeformNoteEditor.svelte'),
  ink: () => import('$lib/components/DrawingNoteEditor.svelte'),
  pdf: () => import('$lib/components/PdfNoteViewer.svelte'),
  unknown: () => import('$lib/components/UnknownNoteKindError.svelte')
} satisfies Record<string, ComponentLoader>;

export function noteKindLoader(kind: LazyNoteKind): ComponentLoader {
  switch (kind) {
    case 'markdown':
      return loaders.markdown;
    case 'freeform':
      return loaders.freeform;
    case 'ink':
      return loaders.ink;
    case 'pdf':
      return loaders.pdf;
    default:
      return loaders.unknown;
  }
}

export async function loadNoteKindComponent(
  kind: LazyNoteKind
): Promise<LazyNoteComponent> {
  const mod = await noteKindLoader(kind)();
  return mod.default;
}
