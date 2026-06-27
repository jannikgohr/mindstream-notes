<script lang="ts">
  import {
    ChevronLeft,
    FilePlus2,
    Pencil,
    RefreshCw,
    RotateCcw,
    Undo2
  } from '@lucide/svelte';
  import {
    captureNoteVersion,
    listNoteVersions,
    loadNote,
    loadNoteVersion,
    type VersionSummary
  } from '$lib/api';
  import MarkdownDiff from '$lib/components/MarkdownDiff.svelte';
  import { formatNoteDateTime } from '$lib/date-time';
  import { tUi } from '$lib/settings/i18n.svelte';
  import {
    getNoteHistory,
    noteHistoryEpoch,
    registeredNotes
  } from '$lib/stores/note-history-bridge.svelte';

  interface Props {
    noteId: string;
  }
  let { noteId }: Props = $props();

  let versions = $state<VersionSummary[]>([]);
  let loading = $state(false);
  let restoring = $state(false);
  // Drives the refresh-button spin. Kept on for at least one full rotation
  // (Tailwind animate-spin is a 1s period) even when data returns sooner.
  let spinning = $state(false);
  const MIN_SPIN_MS = 1000;
  // The version being inspected (detail view) with both texts for the diff.
  let detail = $state<{
    summary: VersionSummary;
    body: string;
    current: string;
  } | null>(null);

  // A live editor must be open to apply a restore (it flows through the Yjs
  // doc as collaborative ops). Reactive so the button enables/disables as the
  // editor mounts/unmounts.
  const canRestore = $derived(registeredNotes.has(noteId));

  async function refresh() {
    loading = true;
    try {
      versions = await listNoteVersions(noteId);
    } catch (err) {
      console.warn('[history] list failed', err);
      versions = [];
    } finally {
      loading = false;
    }
  }

  /**
   * Refresh button: snapshot the live editor (the user likely wants the current
   * state captured too), then re-list. Spins for at least one full rotation.
   */
  async function refreshClicked() {
    if (spinning) return;
    spinning = true;
    const start = Date.now();
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
  }

  // Reset the detail view when the active note changes (but not on a capture,
  // so a version landing while you inspect a diff doesn't yank you out).
  $effect(() => {
    void noteId;
    detail = null;
  });

  // (Re)load the list when the note changes or a version is captured for it.
  // The epoch dependency is what makes baseline-on-open and idle/close captures
  // appear in an already-open panel without a reopen.
  $effect(() => {
    void noteId;
    void noteHistoryEpoch(noteId);
    void refresh();
  });

  async function currentMarkdown(): Promise<string> {
    const bridge = getNoteHistory(noteId);
    if (bridge) return bridge.currentMarkdown();
    // Note isn't open in an editor here — fall back to the saved body.
    try {
      return (await loadNote(noteId)).body ?? '';
    } catch {
      return '';
    }
  }

  async function open(summary: VersionSummary) {
    try {
      const [full, current] = await Promise.all([
        loadNoteVersion(summary.id),
        currentMarkdown()
      ]);
      detail = { summary, body: full.body, current };
    } catch (err) {
      console.warn('[history] open version failed', err);
    }
  }

  async function restore() {
    const target = detail?.summary;
    const bridge = getNoteHistory(noteId);
    if (!target || !bridge || restoring) return;
    restoring = true;
    try {
      const full = await loadNoteVersion(target.id);
      // Safety: snapshot the current state so the restore is itself undoable
      // (deduped if it's already the latest version).
      await captureNoteVersion(
        noteId,
        'markdown',
        'edited',
        bridge.currentMarkdown()
      );
      // Apply as collaborative edits → persists + syncs like any edit.
      bridge.revert(full.body);
      // Record the restore, referencing the target for the "Reverted to" label.
      await captureNoteVersion(
        noteId,
        'markdown',
        'reverted',
        full.body,
        target.id
      );
      detail = null;
      await refresh();
    } catch (err) {
      console.error('[history] restore failed', err);
    } finally {
      restoring = false;
    }
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

    <MarkdownDiff oldText={d.body} newText={d.current} />

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
