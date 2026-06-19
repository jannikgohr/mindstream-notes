/**
 * Shared reactive signature library.
 *
 * The reusable signature library is user-global, so every open PdfNoteViewer
 * must show the same set. When each viewer kept its own copy, adding a
 * signature in one left a second viewer (e.g. two PDFs side by side) stale
 * until it was reopened. This module holds the single canonical reactive
 * copy; viewers read from it and mutate through these helpers, so every open
 * viewer updates together.
 *
 * Persistence and cross-device sync live in $lib/pdf/signature-storage (the
 * synced Rust store underneath). This module is just the in-process cache on
 * top of it.
 */

import {
  loadReusableSignatures,
  saveReusableSignature,
  deleteReusableSignature
} from '$lib/pdf/signature-storage';
import { isTauri } from '$lib/api';
import { emit, listen } from '$lib/api/events';
import type { PdfSignatureSnapshot } from '$lib/pdf/types';

interface SignatureLibraryState {
  signatures: PdfSignatureSnapshot[];
  /** Has the library been read from the backing store at least once? */
  loaded: boolean;
}

export const signatureLibrary = $state<SignatureLibraryState>({
  signatures: [],
  loaded: false
});

// Dedupes a concurrent first load when two viewers mount at the same time.
let loadPromise: Promise<void> | null = null;

// Cross-window propagation. A note popped out into its own window is a
// separate Tauri webview — a separate JS context — so the module state above
// isn't shared with it. Each window broadcasts a Tauri event when it changes
// the library, and every window listens and re-reads the (already-persisted)
// store. In-window split panes are covered by the shared state directly; this
// only matters between windows.
let crossWindowWired = false;
function wireCrossWindow() {
  if (crossWindowWired || !isTauri()) return;
  crossWindowWired = true;
  void listen('signatures-changed', () => {
    void refreshSignatures();
  });
}

function broadcastChange() {
  if (!isTauri()) return;
  // Best-effort. The sender also receives this and re-reads, which is a
  // harmless no-op (the DB already matches its optimistic state).
  void emit('signatures-changed', null);
}

/**
 * Load the library once (the first call also runs the legacy localStorage
 * migration). Subsequent calls are no-ops once loaded — use
 * refreshSignatures() to force a re-read.
 */
export async function ensureSignaturesLoaded(): Promise<void> {
  // Wire the cross-window listener once per window, even if the library was
  // already loaded by an earlier caller.
  wireCrossWindow();
  if (signatureLibrary.loaded) return;
  if (!loadPromise) {
    loadPromise = loadReusableSignatures()
      .then((sigs) => {
        signatureLibrary.signatures = sigs;
        signatureLibrary.loaded = true;
      })
      .catch((err) => {
        console.warn('[signatures] load failed', err);
      })
      .finally(() => {
        loadPromise = null;
      });
  }
  return loadPromise;
}

/**
 * Re-read from the backing store. Used after a remote sync that may have
 * pulled signatures added/removed on another device.
 */
export async function refreshSignatures(): Promise<void> {
  try {
    signatureLibrary.signatures = await loadReusableSignatures();
    signatureLibrary.loaded = true;
  } catch (err) {
    console.warn('[signatures] refresh failed', err);
  }
}

/**
 * Add a signature to the shared library and persist it. Optimistic: the
 * in-memory list updates immediately so every open viewer reflects it.
 */
export async function addSignature(sig: PdfSignatureSnapshot): Promise<void> {
  signatureLibrary.signatures = [...signatureLibrary.signatures, sig];
  try {
    await saveReusableSignature(sig);
    broadcastChange();
  } catch (err) {
    console.warn('[signatures] save failed', err);
  }
}

/** Remove a signature from the shared library and persist the deletion. */
export async function removeSignature(id: string): Promise<void> {
  signatureLibrary.signatures = signatureLibrary.signatures.filter(
    (s) => s.id !== id
  );
  try {
    await deleteReusableSignature(id);
    broadcastChange();
  } catch (err) {
    console.warn('[signatures] delete failed', err);
  }
}
