/**
 * Crepe's block-handle "+" button (BlockEdit feature) inserts a new
 * block on a bare `pointerup` — it never checks where the gesture
 * started. Finish a text-selection drag with the pointer over the
 * button (it appears on hover next to the block you started selecting
 * in) and you get a stray empty paragraph.
 *
 * The handler lives inside Crepe's Vue component, so we can't patch it
 * directly. Instead this guard listens in the capture phase on the
 * document, remembers whether the last `pointerdown` landed on the add
 * button, and swallows any `pointerup` on the button that doesn't pair
 * with it — Crepe's own listener (target phase) then never fires.
 */

const installedDocs = new WeakSet<Document>();

let downOnAddButton = false;

function isAddButton(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    // The handle renders two `.operation-item`s: add button first,
    // drag grip second. Only the add button inserts on pointerup.
    target.closest('.milkdown-block-handle .operation-item:first-child') !==
      null
  );
}

/** Idempotent per document; listeners are passive-cheap so they stay. */
export function installBlockHandleGuard(doc: Document): void {
  if (installedDocs.has(doc)) return;
  installedDocs.add(doc);
  doc.addEventListener(
    'pointerdown',
    (event) => {
      downOnAddButton = isAddButton(event.target);
    },
    true
  );
  doc.addEventListener(
    'pointerup',
    (event) => {
      if (isAddButton(event.target) && !downOnAddButton) {
        event.stopPropagation();
      }
      downOnAddButton = false;
    },
    true
  );
}
