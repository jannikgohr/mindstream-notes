/**
 * ProseMirror's undo history as JSON, so it outlives the webview when the
 * worker unloads a hidden window (see `$lib/editor/retained-undo`).
 *
 * prosemirror-history exports none of its classes, so this reads its state
 * the way its source lays it out, and takes the constructors from live
 * instances. A restore hands the result back through the plugin's own
 * transaction meta, which is how `undo` installs a new history.
 */

import { Node as ProseNode, Slice } from '@milkdown/kit/prose/model';
import {
  AllSelection,
  type EditorState,
  type Plugin,
  type SelectionBookmark,
  TextSelection,
  type Transaction
} from '@milkdown/kit/prose/state';
import {
  ReplaceStep,
  Step,
  StepMap,
  Transform
} from '@milkdown/kit/prose/transform';
import { minimalDocDiff } from './doc-diff';

interface Item {
  map: StepMap;
  step?: Step;
  selection?: SelectionBookmark;
  mirrorOffset?: number;
}

interface Branch {
  items: {
    length: number;
    forEach(f: (item: Item) => void): void;
    append(items: Item[]): Branch['items'];
  };
  eventCount: number;
  addMaps(maps: readonly StepMap[]): Branch;
  addTransform(
    transform: Transform,
    selection: SelectionBookmark | undefined,
    options: { depth: number },
    preserveItems: boolean
  ): Branch;
}

interface HistoryState {
  done: Branch;
  undone: Branch;
}

type Bookmark = { anchor: number; head: number } | 'all';

interface ItemJSON {
  map: number[];
  inverted: boolean;
  step?: unknown;
  selection?: Bookmark;
  mirrorOffset?: number;
}

interface BranchJSON {
  items: ItemJSON[];
  eventCount: number;
}

export interface ProseMirrorUndoJSON {
  doc: unknown;
  done: BranchJSON;
  undone: BranchJSON;
}

function historyPlugin(state: EditorState): Plugin | undefined {
  return state.plugins.find(
    (plugin) => (plugin as unknown as { key: string }).key === 'history$'
  );
}

function bookmarkJSON(bookmark: SelectionBookmark): Bookmark {
  const { anchor, head } = bookmark as unknown as {
    anchor?: number;
    head?: number;
  };
  if (anchor === undefined) return 'all';
  // A node selection comes back as a cursor at the node.
  return { anchor, head: head ?? anchor };
}

function branchJSON(branch: Branch): BranchJSON {
  const items: ItemJSON[] = [];
  branch.items.forEach((item) => {
    const map = item.map as unknown as { ranges: number[]; inverted: boolean };
    items.push({
      map: [...map.ranges],
      inverted: map.inverted,
      step: item.step?.toJSON(),
      selection: item.selection && bookmarkJSON(item.selection),
      mirrorOffset: item.mirrorOffset
    });
  });
  return { items, eventCount: branch.eventCount };
}

/** The editor's undo and redo history, or null when both are empty. */
export function captureProseMirrorUndo(
  state: EditorState
): ProseMirrorUndoJSON | null {
  const plugin = historyPlugin(state);
  const history = plugin?.getState(state) as HistoryState | undefined;
  if (!history || history.done.eventCount + history.undone.eventCount === 0)
    return null;
  return {
    doc: state.doc.toJSON(),
    done: branchJSON(history.done),
    undone: branchJSON(history.undone)
  };
}

/**
 * A transaction that gives this editor the captured history, or null when
 * it cannot take it. If the document changed since the capture, the history
 * is mapped through that change, as for any edit made outside the history.
 */
export function restoreProseMirrorUndo(
  state: EditorState,
  saved: ProseMirrorUndoJSON
): Transaction | null {
  const plugin = historyPlugin(state);
  const current = plugin?.getState(state) as HistoryState | undefined;
  if (!plugin || !current) return null;
  const { schema } = state;
  let savedDoc: ProseNode;
  try {
    savedDoc = ProseNode.fromJSON(schema, saved.doc);
  } catch {
    return null;
  }

  // Constructors from live instances: an empty branch holds no item, so one
  // is made from a step that changes nothing.
  const Branch = current.done.constructor as {
    new (items: Branch['items'], eventCount: number): Branch;
    empty: Branch;
  };
  const probe = Branch.empty.addTransform(
    new Transform(savedDoc).step(new ReplaceStep(0, 0, Slice.empty)),
    undefined,
    { depth: 1 },
    false
  );
  let ItemClass: (new (...args: unknown[]) => Item) | undefined;
  probe.items.forEach((item) => {
    ItemClass = item.constructor as typeof ItemClass;
  });
  const TextBookmark = TextSelection.atStart(savedDoc).getBookmark()
    .constructor as new (anchor: number, head: number) => SelectionBookmark;
  const allBookmark = new AllSelection(savedDoc).getBookmark();
  const History = current.constructor as new (
    done: Branch,
    undone: Branch,
    prevRanges: null,
    prevTime: number,
    prevComposition: number
  ) => HistoryState;
  if (!ItemClass) return null;
  const Item = ItemClass;

  const branch = (json: BranchJSON) =>
    new Branch(
      Branch.empty.items.append(
        json.items.map(
          (item) =>
            new Item(
              new StepMap(item.map, item.inverted),
              item.step === undefined
                ? undefined
                : Step.fromJSON(schema, item.step),
              item.selection === undefined
                ? undefined
                : item.selection === 'all'
                  ? allBookmark
                  : new TextBookmark(
                      item.selection.anchor,
                      item.selection.head
                    ),
              item.mirrorOffset
            )
        )
      ),
      json.eventCount
    );
  let done: Branch;
  let undone: Branch;
  try {
    done = branch(saved.done);
    undone = branch(saved.undone);
  } catch {
    return null;
  }

  if (!savedDoc.eq(state.doc)) {
    const diff = minimalDocDiff(savedDoc, state.doc);
    if (diff) {
      const map = new ReplaceStep(diff.from, diff.to, diff.slice).getMap();
      done = done.addMaps([map]);
      undone = undone.addMaps([map]);
    }
  }
  return state.tr.setMeta(plugin, {
    redo: false,
    historyState: new History(done, undone, null, 0, -1)
  });
}
