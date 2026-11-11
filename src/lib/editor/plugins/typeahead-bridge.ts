import type { TypeaheadState } from './prose/typeahead';

export function createTypeaheadHandlers<T, S extends TypeaheadState>(
  state: S,
  insert: (item: T) => void
) {
  let insertItem = insert;
  let cancel = () => {};
  let commit = () => {};
  return {
    insert: (item: T) => insertItem(item),
    cancel: () => cancel(),
    commitFromPopup: () => commit(),
    setHandlers(handlers: { insert: (item: T) => void; cancel: () => void }) {
      insertItem = handlers.insert;
      cancel = handlers.cancel;
    },
    setCommitFromPopup(handler: () => void) {
      commit = handler;
    },
    state
  };
}
