/**
 * The idle "save a version to history" timer every note editor runs.
 *
 * All five editors (markdown, PDF, ink, freeform, kanban) had their own
 * copy of this: the same dirty flag, the same timer, the same
 * capture-and-bump call, differing only in the log label and in one
 * genuine behavioural detail — see {@link HistoryCaptureMode}.
 */

import { getSettingValue } from '$lib/settings/store.svelte';
import {
  captureCurrentNoteVersion,
  type VersionAction
} from '$lib/api/history';
import { bumpNoteHistory } from '$lib/stores/note-history-bridge.svelte';

/** Idle delay used when the setting is missing or not a positive number. */
export const HISTORY_IDLE_DEFAULT_S = 180;

/**
 * How a fresh edit interacts with an already-armed timer.
 *
 * - `deadline` — leave it running, so the snapshot fires a fixed time
 *   after the *first* edit. Docs that receive updates the user didn't
 *   make (collab peers, a reconnecting provider) can otherwise push a
 *   restarting timer out indefinitely and the snapshot never happens.
 * - `debounce` — restart it, so the snapshot fires once editing has
 *   actually stopped.
 */
export type HistoryCaptureMode = 'deadline' | 'debounce';

export interface HistoryCaptureOptions {
  /**
   * The note whose history is being captured. A function, not a value:
   * the editor's `noteId` prop can change while the component lives, and
   * a capture must land on whichever note is open when it fires.
   */
  noteId(): string;
  /** Prefix for the debug log when a capture fails. */
  label: string;
  /** Trashed notes never capture. */
  isTrashed(): boolean;
  /** False before the doc exists — nothing meaningful to snapshot yet. */
  isReady(): boolean;
  mode: HistoryCaptureMode;
  /**
   * Whether an explicit `snapshotNow()` should no-op when nothing has
   * changed since the last capture.
   */
  snapshotNowRequiresDirty: boolean;
}

/** The configured idle delay in milliseconds. */
export function historyIdleMs(): number {
  const seconds = Number(getSettingValue('data.historyIdleSeconds'));
  return (
    (Number.isFinite(seconds) && seconds > 0
      ? seconds
      : HISTORY_IDLE_DEFAULT_S) * 1000
  );
}

export function createHistoryCapture(options: HistoryCaptureOptions) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /** Mark the note edited and arm the idle capture. */
  function schedule() {
    if (options.isTrashed()) return;
    dirty = true;
    if (options.mode === 'deadline') {
      if (timer) return;
    } else {
      clearTimer();
    }
    timer = setTimeout(() => {
      timer = null;
      void capture('edited');
    }, historyIdleMs());
  }

  /**
   * Capture a version now. An `edited` capture is skipped when nothing
   * has changed since the last one; explicit actions always capture.
   */
  async function capture(action: VersionAction) {
    if (!options.isReady()) return;
    if (action === 'edited' && !dirty) return;
    dirty = false;
    try {
      const noteId = options.noteId();
      const created = await captureCurrentNoteVersion(noteId, action);
      if (created) bumpNoteHistory(noteId);
    } catch (err) {
      console.debug(`[${options.label}] history capture failed`, err);
    }
  }

  /** Manual "refresh history": capture immediately and disarm the timer. */
  async function snapshotNow() {
    clearTimer();
    if (options.snapshotNowRequiresDirty && !dirty) return;
    await capture('edited');
  }

  /** Drop a pending capture without running it (component teardown). */
  function cancel() {
    clearTimer();
  }

  return {
    schedule,
    capture,
    snapshotNow,
    cancel,
    get dirty() {
      return dirty;
    }
  };
}

export type HistoryCapture = ReturnType<typeof createHistoryCapture>;
