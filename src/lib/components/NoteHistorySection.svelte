<script lang="ts">
  import {
    ChevronLeft,
    FilePlus2,
    Pencil,
    RefreshCw,
    RotateCcw,
    Undo2,
    X
  } from '@lucide/svelte';
  import {
    captureNoteVersion,
    listNoteVersions,
    loadNote,
    loadNoteVersion,
    type NoteKind,
    type VersionSummary
  } from '$lib/api';
  import MarkdownDiff from '$lib/components/MarkdownDiff.svelte';
  import NoteHistoryModal from '$lib/components/NoteHistoryModal.svelte';
  import { confirm } from '$lib/components/confirm-dialog.svelte';
  import { formatNoteDateTime } from '$lib/date-time';
  import { isMobile } from '$lib/platform';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    clearRestoreUndo,
    getNoteHistory,
    noteHistoryEpoch,
    noteRestoreUndo,
    registeredNotes,
    setRestoreUndo
  } from '$lib/stores/note-history-bridge.svelte';

  interface Props {
    noteId: string;
    noteKind: NoteKind;
  }
  let { noteId, noteKind }: Props = $props();

  let versions = $state<VersionSummary[]>([]);
  let loading = $state(false);
  let restoring = $state(false);
  // Drives the refresh-button spin. Kept on for at least one full rotation
  // (Tailwind animate-spin is a 1s period) even when data returns sooner.
  let spinning = $state(false);
  const MIN_SPIN_MS = 1000;
  let refreshSeq = 0;
  // Mobile inspects a version in an inline detail view; desktop opens a modal.
  let detail = $state<{
    summary: VersionSummary;
    body: string;
    current: string;
  } | null>(null);
  // Desktop modal state (markdown only: the version being inspected + both
  // markdown texts).
  let modal = $state<{
    summary: VersionSummary;
    oldMarkdown: string;
    currentMarkdown: string;
  } | null>(null);

  // A live editor must be open to apply a restore (it flows through the Yjs
  // doc as collaborative ops). Reactive so the button enables/disables as the
  // editor mounts/unmounts.
  const canRestore = $derived(registeredNotes.has(noteId));

  async function refresh() {
    const seq = ++refreshSeq;
    loading = true;
    try {
      const next = await listNoteVersions(noteId);
      if (seq === refreshSeq) versions = next;
    } catch (err) {
      console.warn('[history] list failed', err);
      if (seq === refreshSeq) versions = [];
    } finally {
      if (seq === refreshSeq) loading = false;
    }
  }

  /**
   * Refresh button: snapshot the live editor (the user likely wants the current
   * state captured too), then re-list. Spins for at least one full rotation.
   */
  function refreshClicked() {
    if (spinning) return;
    spinning = true;
    const start = Date.now();
    void (async () => {
      try {
        await getNoteHistory(noteId)?.snapshotNow();
        await refresh();
      } finally {
        const remaining = MIN_SPIN_MS - (Date.now() - start);
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
        spinning = false;
      }
    })();
  }

  // Reset the detail view when the active note changes (but not on a capture,
  // so a version landing while you inspect a diff doesn't yank you out).
  $effect(() => {
    void noteId;
    void noteKind;
    detail = null;
    modal = null;
  });

  // (Re)load the list when the note changes or a version is captured for it.
  // The epoch dependency is what makes baseline-on-open and idle/close captures
  // appear in an already-open panel without a reopen.
  $effect(() => {
    void noteId;
    void noteKind;
    void noteHistoryEpoch(noteId);
    void refresh();
  });

  async function currentSnapshot(): Promise<string> {
    const bridge = getNoteHistory(noteId);
    if (bridge) return await bridge.currentSnapshot();
    // Note isn't open in an editor here — fall back to the saved body/state.
    try {
      const note = await loadNote(noteId);
      return noteKind === 'markdown' ? (note.body ?? '') : '';
    } catch {
      return '';
    }
  }

  async function open(summary: VersionSummary) {
    try {
      const full = await loadNoteVersion(summary.id);
      // Desktop markdown: rich modal (current / diff / old tabs). Mobile and
      // non-markdown kinds: inline detail.
      if (isMobile() || noteKind !== 'markdown') {
        detail = { summary, body: full.body, current: '' };
      } else {
        const current = await currentSnapshot();
        modal = { summary, oldMarkdown: full.body, currentMarkdown: current };
      }
    } catch (err) {
      console.warn('[history] open version failed', err);
    }
  }

  /**
   * Apply a restore, identically for every note kind:
   *   1. capture the live pre-restore state as a version (so it's never lost),
   *   2. replace the live doc with the target version via the editor bridge,
   *   3. record a 'reverted' version pointing at the target,
   *   4. offer a one-click Undo back to the pre-restore state.
   * Returns whether it ran.
   */
  async function applyRestore(target: VersionSummary): Promise<boolean> {
    const bridge = getNoteHistory(noteId);
    if (!bridge || restoring) return false;
    restoring = true;
    try {
      const full = await loadNoteVersion(target.id);
      // The editor's snapshot is symmetrical with restoreSnapshot for every
      // kind (markdown text, or the base64 Yjs envelope), so it doubles as the
      // checkpoint body and the Undo payload.
      const preRestoreBody = await bridge.currentSnapshot();
      const checkpoint = await captureNoteVersion(
        noteId,
        noteKind,
        'edited',
        preRestoreBody
      );
      await bridge.restoreSnapshot(full.body);
      await captureNoteVersion(
        noteId,
        noteKind,
        'reverted',
        full.body,
        target.id
      );
      await refresh();
      setRestoreUndo(noteId, {
        body: preRestoreBody,
        checkpointId: checkpoint?.id ?? null
      });
      return true;
    } catch (err) {
      console.error('[history] restore failed', err);
      return false;
    } finally {
      restoring = false;
    }
  }

  // "Undo the restore" affordance. Kept in the per-note bridge store (not local
  // state) so it survives the panel remounting — a tree/sync refresh rebuilds
  // notesById a few seconds after a restore's save, which would otherwise wipe
  // a component-local banner mid-view. No timer: it persists until the user
  // undoes it, closes it, starts another restore, or the app reloads.
  const pendingUndo = $derived(noteRestoreUndo(noteId));

  async function undoRestore() {
    const target = pendingUndo;
    const bridge = getNoteHistory(noteId);
    if (!target || !bridge || restoring) return;
    restoring = true;
    try {
      await bridge.restoreSnapshot(target.body);
      await captureNoteVersion(
        noteId,
        noteKind,
        'reverted',
        target.body,
        target.checkpointId
      );
      await refresh();
    } catch (err) {
      console.error('[history] undo restore failed', err);
    } finally {
      restoring = false;
      clearRestoreUndo(noteId);
    }
  }

  // Inline (mobile) restore — confirm first, since there are no modal buttons.
  async function restore() {
    const target = detail?.summary;
    if (!target) return;
    const ok = await confirm({
      title: tUi('history.restoreConfirmTitle'),
      message: tUi('history.restoreConfirmBody'),
      confirmLabel: tUi('history.restoreConfirmAction'),
      cancelLabel: tUi('history.restoreConfirmCancel')
    });
    if (!ok) return;
    if (await applyRestore(target)) detail = null;
  }

  // Modal (desktop) restore — the modal's Restore button is the confirmation.
  async function modalRestore() {
    const target = modal?.summary;
    if (!target) return;
    if (await applyRestore(target)) modal = null;
  }

  function actionIcon(action: string) {
    if (action === 'created') return FilePlus2;
    if (action === 'reverted') return Undo2;
    return Pencil;
  }

  function actionLabel(v: VersionSummary): string {
    if (v.action === 'created') return tUi('history.action.created');
    if (v.action === 'reverted') {
      return v.ref_created
        ? tUi('history.action.reverted').replace(
            '{date}',
            formatNoteDateTime(v.ref_created)
          )
        : tUi('history.action.revertedGeneric');
    }
    return tUi('history.action.edited');
  }

  // Tiered magnitude: real words → visible non-whitespace "tokens" (formatting,
  // punctuation, …) → a label for word-neutral, whitespace-only edits. A fresh
  // empty note ('created' with nothing) just shows its action, no magnitude.
  function magnitude(v: VersionSummary): string {
    if (v.note_kind !== 'markdown') {
      return v.action === 'created' ? '' : tUi('history.magnitudeChanged');
    }
    if (v.words_added !== 0 || v.words_removed !== 0) {
      return tUi('history.magnitude')
        .replace('{added}', String(v.words_added))
        .replace('{removed}', String(v.words_removed));
    }
    if (v.tokens_added !== 0 || v.tokens_removed !== 0) {
      return tUi('history.magnitudeTokens')
        .replace('{added}', String(v.tokens_added))
        .replace('{removed}', String(v.tokens_removed));
    }
    return v.action === 'created' ? '' : tUi('history.magnitudeMinor');
  }
</script>

<section class="mt-5">
  <div class="mb-2 flex items-center justify-between">
    <h4
      class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
    >
      {tUi('history.title')}
    </h4>
    {#if !detail}
      <button
        type="button"
        class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        onclick={() => void refreshClicked()}
        disabled={spinning}
        aria-label={tUi('history.refresh')}
        title={tUi('history.refresh')}
      >
        <RefreshCw class="size-3.5 {spinning ? 'animate-spin' : ''}" />
      </button>
    {/if}
  </div>

  {#if pendingUndo}
    <div
      class="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs"
      role="status"
    >
      <RotateCcw class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate text-muted-foreground">
        {tUi('history.restored')}
      </span>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        onclick={() => void undoRestore()}
        disabled={!canRestore || restoring}
      >
        <Undo2 class="size-3.5" />
        {tUi('history.undo')}
      </button>
      <button
        type="button"
        class="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => clearRestoreUndo(noteId)}
        aria-label={tUi('history.undoDismiss')}
        title={tUi('history.undoDismiss')}
      >
        <X class="size-3.5" />
      </button>
    </div>
  {/if}

  {#if detail}
    {@const d = detail}
    <div class="mb-2 flex items-center gap-2">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onclick={() => (detail = null)}
      >
        <ChevronLeft class="size-3.5" />
        {tUi('history.back')}
      </button>
      <span class="min-w-0 flex-1 truncate text-right text-[11px] tabular-nums">
        {formatNoteDateTime(d.summary.created)}
      </span>
    </div>

    {#if noteKind === 'markdown'}
      <MarkdownDiff fromText={d.current} toText={d.body} />
    {:else}
      <p
        class="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
      >
        {tUi('history.previewUnavailable')}
      </p>
    {/if}

    <button
      type="button"
      class="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      onclick={() => void restore()}
      disabled={!canRestore || restoring}
      title={canRestore ? undefined : tUi('history.restoreUnavailable')}
    >
      <RotateCcw class="size-3.5" />
      {tUi('history.restore')}
    </button>
  {:else if loading && versions.length === 0}
    <p class="py-2 text-xs text-muted-foreground">{tUi('history.loading')}</p>
  {:else if versions.length === 0}
    <p
      class="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground"
    >
      {tUi('history.empty')}
    </p>
  {:else}
    <ul class="space-y-1">
      {#each versions as v (v.id)}
        {@const Icon = actionIcon(v.action)}
        <li>
          <button
            type="button"
            class="flex w-full items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-accent"
            onclick={() => void open(v)}
          >
            <Icon class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium">
                {actionLabel(v)}
              </span>
              <span class="block truncate text-[11px] text-muted-foreground">
                {formatNoteDateTime(v.created)}{magnitude(v)
                  ? ` · ${magnitude(v)}`
                  : ''}
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if modal}
  <NoteHistoryModal
    created={modal.summary.created}
    oldMarkdown={modal.oldMarkdown}
    currentMarkdown={modal.currentMarkdown}
    {restoring}
    onClose={() => (modal = null)}
    onRestore={() => void modalRestore()}
  />
{/if}
