import {
  definePlugin,
  notes,
  type Context,
  type Effect,
  type MenuItem,
  type TemplateInput,
  type TemplateResult
} from '../../typescript/src/index';
import { render } from './template';

function isUnder(
  folder: string,
  target: string,
  parents: Map<string, string | null>
): boolean {
  let current: string | null | undefined = folder;
  const seen = new Set<string>();
  while (current != null && !seen.has(current)) {
    if (current === target) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
}

function newFromTemplate(ctx: Context): Effect {
  const settings = ctx.settings ?? {};
  const folder = settings['source-folder'];
  const tag = settings['source-tag'];
  const folderId =
    typeof folder === 'string' && folder !== '' ? folder : undefined;
  const sourceTag = typeof tag === 'string' && tag !== '' ? tag : undefined;
  if (!folderId && !sourceTag) {
    return {
      effect: 'toast',
      message: 'Set a template folder or tag in Settings → Plugins → Templates.'
    };
  }
  const parents = new Map(
    (ctx.folders ?? []).map((folder) => [folder.id, folder.parentId])
  );
  const items: MenuItem[] = [];
  for (const note of notes.all()) {
    if (
      (sourceTag && note.tags.includes(sourceTag)) ||
      (folderId && note.folderId && isUnder(note.folderId, folderId, parents))
    ) {
      items.push({
        label: note.title,
        run: { effect: 'createNoteFromNote', sourceNoteId: note.id }
      });
    }
  }
  if (items.length === 0)
    return { effect: 'toast', message: 'No template notes found.' };
  // Match the old byte ordering, independent of the host's locale.
  items.sort((a, b) => {
    let left = 0;
    let right = 0;
    while (left < a.label.length && right < b.label.length) {
      const x = a.label.codePointAt(left)!;
      const y = b.label.codePointAt(right)!;
      if (x !== y) return x - y;
      left += x > 0xffff ? 2 : 1;
      right += y > 0xffff ? 2 : 1;
    }
    return a.label.length - b.label.length;
  });
  return { effect: 'openMenu', items };
}

function renderTemplate(input: TemplateInput): TemplateResult {
  const vars = { ...input.vars };
  const ctx = { now: input.now, vars, locale: input.locale };
  const title = render(input.title ?? '', ctx);
  vars.title = title;
  return { title, body: render(input.body ?? '', ctx) };
}

export const invoke = definePlugin({ newFromTemplate, renderTemplate });
