/**
 * Bidirectional binding between a tldraw `TLStore` and a Yjs `Y.Doc`.
 *
 * Tldraw's store is a flat keyed collection of `TLRecord`s (shapes,
 * bindings, pages, instance state, …). We mirror that onto a single
 * `Y.Map<TLRecord>` keyed by record id. Each side observes the other and
 * applies changes; an echo-suppression flag prevents infinite ping-pong
 * (tldraw fires its `store.listen` callback when WE put a remote-applied
 * record back into the store, so we have to ignore those frames).
 *
 * Lifecycle: call `bindStoreToYDoc(...)`, get back a disposer. Call the
 * disposer when the editor unmounts (Svelte `onDestroy`). The Y.Doc and
 * the store can outlive each other in either direction — the disposer
 * is idempotent.
 *
 * Out of scope for this slice (and easy to layer on later):
 *   - Presence / collaborator cursors. Tldraw's `TLInstancePresence`
 *     records aren't in the document scope, and we'd want to map them
 *     onto `y-protocols/awareness` rather than into the doc itself
 *     (otherwise every keystroke broadcasts a presence frame). The
 *     existing `Awareness` instance the caller threads through is
 *     reserved for that pass.
 *   - Asset bytes. Records that reference assets (`asset:foo`) replicate
 *     fine — only the byte payload is missing. The companion `assetStore`
 *     in the React island stubs uploads for now.
 *
 * Adapted from BrianHung/tldraw-yjs's `useYjsStore` (tldraw 2.x), ported
 * to tldraw 5.x APIs. The shapes diverged considerably so this is more
 * "inspired by" than "ported":
 *   - tldraw 5 added `bindings` as a first-class record type — handled
 *     here implicitly because we treat ALL document-scope records
 *     uniformly (no per-type code path).
 *   - tldraw 5's `store.listen` takes a `{ source, scope }` filter that
 *     replaces the manual source/scope inspection BrianHung did inline.
 *   - tldraw 5's `mergeRemoteChanges(fn)` is the maintained way to apply
 *     remote-flavoured edits; it sets `source: 'remote'` on the resulting
 *     listener entry so our filter naturally skips them.
 */

import * as Y from 'yjs';
import type { Store, HistoryEntry } from '@tldraw/store';
import type { TLRecord } from 'tldraw';

/** Name of the Y.Map that holds the entire tldraw store. Stable so other
 *  clients open the same map and so future schema migrations have a
 *  well-known entry point. */
const YJS_RECORDS_KEY = 'tldraw:records';

export interface BindOptions {
  /** Mutated in both directions. Caller owns its lifecycle. */
  yDoc: Y.Doc;
  /** Tldraw store created with `createTLStore(...)`. */
  store: Store<TLRecord>;
}

export interface BindHandle {
  /** Idempotent. Tears down both directions, leaves yDoc + store alone. */
  destroy(): void;
}

export function bindStoreToYDoc({ yDoc, store }: BindOptions): BindHandle {
  const yRecords: Y.Map<TLRecord> = yDoc.getMap(YJS_RECORDS_KEY);

  // Echo suppression. Both directions set this around their writes so the
  // peer observer skips frames it just produced itself. Yjs and tldraw
  // both fire change observers synchronously inside their write methods,
  // so a simple boolean is enough — no race window.
  let applyingRemote = false;

  // ---------------------------------------------------------------------
  // Initial hydration: pick whichever side has data.
  // ---------------------------------------------------------------------
  //
  // Two real scenarios:
  //   A) Fresh note, empty yRecords, empty store. Nothing to do — tldraw
  //      will seed instance/page records itself once it mounts (those
  //      get caught by the store listener below and pushed into Yjs).
  //   B) Existing note opened after a sync, yRecords populated, store
  //      empty (because Svelte just created the TLStore one tick ago).
  //      Copy yRecords → store inside `mergeRemoteChanges` so tldraw
  //      treats them as remote-applied and our listener skips them.
  //
  // We never face the inverse ("store has data, Y.Doc empty") because
  // the caller always hydrates the Y.Doc from yrs_state before
  // constructing the store. Treating that as "Y.Doc wins" would silently
  // erase a user's drawing on a hydration race.
  if (yRecords.size > 0) {
    applyingRemote = true;
    try {
      store.mergeRemoteChanges(() => {
        store.put(Array.from(yRecords.values()), 'initialize');
      });
    } finally {
      applyingRemote = false;
    }
  }

  // ---------------------------------------------------------------------
  // tldraw → Yjs: every local edit becomes a Yjs map mutation.
  // ---------------------------------------------------------------------
  //
  // Filter `source: 'user'` skips remote-applied edits (the ones we
  // injected via mergeRemoteChanges above), so this listener only fires
  // for changes the user made through the editor. `scope: 'document'`
  // skips presence/session/instance records that aren't part of the
  // sharable doc; presence will be re-introduced via Awareness later.
  const unsubStore = store.listen(
    (entry: HistoryEntry<TLRecord>) => {
      if (applyingRemote) return;
      const { added, updated, removed } = entry.changes;
      // One transaction so the peer applies the whole frame atomically
      // (no half-applied delete/update visible mid-frame).
      yDoc.transact(() => {
        for (const record of Object.values(added)) {
          yRecords.set(record.id, record);
        }
        for (const [, next] of Object.values(updated)) {
          yRecords.set(next.id, next);
        }
        for (const record of Object.values(removed)) {
          yRecords.delete(record.id);
        }
      }, 'tldraw-local');
    },
    { source: 'user', scope: 'document' }
  );

  // ---------------------------------------------------------------------
  // Yjs → tldraw: every remote map mutation becomes a store put/remove.
  // ---------------------------------------------------------------------
  //
  // `observeDeep` because we mutate yRecords (which contains TLRecord
  // objects) via `set`/`delete` — a shallow `observe` on the map catches
  // those. If we ever shard TLRecords across nested Y.Maps for per-field
  // CRDT merging, observeDeep already covers that without re-plumbing.
  //
  // We ignore events whose `transaction.origin === 'tldraw-local'` —
  // those are the echoes from this client's own writes. The `applyingRemote`
  // flag handles the reverse direction (Yjs → store → store.listen),
  // origin checks handle this direction.
  const yObserver = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    // Coalesce all events from a single transaction into one
    // mergeRemoteChanges call so tldraw applies them as one atomic remote
    // frame and runs side effects once.
    const recordsToPut: TLRecord[] = [];
    const idsToRemove: TLRecord['id'][] = [];
    let sawLocalOrigin = false;
    for (const ev of events) {
      if (ev.transaction.origin === 'tldraw-local') {
        sawLocalOrigin = true;
        continue;
      }
      // ev.target is yRecords for the shallow case; ev.keys carries
      // per-key change descriptors with action: 'add' | 'update' | 'delete'.
      ev.changes.keys.forEach((change, key) => {
        if (change.action === 'delete') {
          idsToRemove.push(key as TLRecord['id']);
        } else {
          // 'add' or 'update' — pull the current value from the map.
          const rec = yRecords.get(key);
          if (rec) recordsToPut.push(rec);
        }
      });
    }
    if (sawLocalOrigin && recordsToPut.length === 0 && idsToRemove.length === 0) {
      return;
    }
    applyingRemote = true;
    try {
      store.mergeRemoteChanges(() => {
        if (recordsToPut.length > 0) store.put(recordsToPut);
        if (idsToRemove.length > 0) store.remove(idsToRemove);
      });
    } finally {
      applyingRemote = false;
    }
  };
  yRecords.observeDeep(yObserver);

  let destroyed = false;
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubStore();
      yRecords.unobserveDeep(yObserver);
    }
  };
}
