<script lang="ts">
  import { CalendarPlus, Edit3, Folder, Paperclip, Tag } from '@lucide/svelte';
  import FavouriteStar from './FavouriteStar.svelte';
  import TagsSection from '$lib/components/TagsSection.svelte';
  import NoteHistorySection from '$lib/components/NoteHistorySection.svelte';
  import {
    fetchDrawingAsset,
    loadNote,
    type Collection,
    type NoteSummary
  } from '$lib/api';
  import { noteKindIcon } from '$lib/components/note-kind-icon';
  import { formatNoteDateTime } from '$lib/date-time';
  import { extractPdfText } from '$lib/pdf/extract-text';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { ui } from '$lib/state.svelte';
  import { setNoteFavourite, tree } from '$lib/stores/tree.svelte';

  // Summary only — bodies live with the editor and would force every tree
  // refresh through a load_note round trip.
  const note = $derived(
    ui.activeNoteId ? tree.notesById[ui.activeNoteId] : null
  );

  /**
   * Walk parent_collection_id from leaf to root and return the chain in
   * root → leaf order. Cycle-safe via a visited set in case the tree is
   * ever in a transient inconsistent state mid-move.
   */
  function getFolderPath(n: NoteSummary): Collection[] {
    const path: Collection[] = [];
    const seen = new Set<string>();
    let id: string | null = n.parent_collection_id;
    while (id && !seen.has(id)) {
      seen.add(id);
      const c = tree.collectionsById[id];
      if (!c) break;
      path.unshift(c);
      id = c.parent_collection_id;
    }
    return path;
  }
  const folderPath = $derived(note ? getFolderPath(note) : []);
  const folderLabel = $derived(
    folderPath.length > 0
      ? folderPath[folderPath.length - 1].name
      : tUi('metadata.folder.root')
  );
  const folderTitle = $derived(
    folderPath.length > 0
      ? folderPath.map((c) => c.name).join(' / ')
      : tUi('metadata.folder.root')
  );

  // TODO: Render author once notes expose ownership/user attribution metadata.

  let noteBody = $state('');
  let noteText = $state('');
  let contentLoading = $state(false);
  const showContentStats = $derived(
    note ? hasContentStats(note.note_kind) : false
  );
  const showAttachments = $derived(
    note ? canHaveAttachments(note.note_kind) : false
  );

  $effect(() => {
    if (
      !note ||
      (!hasContentStats(note.note_kind) && !canHaveAttachments(note.note_kind))
    ) {
      noteBody = '';
      noteText = '';
      contentLoading = false;
      return;
    }

    let cancelled = false;
    const id = note.id;
    void note.modified;
    contentLoading = true;
    loadNote(id)
      .then(async (loaded) => {
        const body = loaded.body ?? '';
        const text =
          loaded.note_kind === 'pdf' ? await pdfTextForMetadata(body) : body;
        if (!cancelled && ui.activeNoteId === id) {
          noteBody = body;
          noteText = text;
        }
      })
      .catch((err) => {
        console.warn('[metadata] failed to load note content stats', err);
        if (!cancelled && ui.activeNoteId === id) {
          noteBody = '';
          noteText = '';
        }
      })
      .finally(() => {
        if (!cancelled && ui.activeNoteId === id) {
          contentLoading = false;
        }
      });

    return () => {
      cancelled = true;
    };
  });

  const contentStats = $derived.by(() =>
    analyzeContent(noteBody, noteText, note?.note_kind ?? null)
  );

  function noteKindLabel(kind: string | null | undefined): string {
    switch (kind) {
      case 'markdown':
        return tUi('metadata.type.markdown');
      case 'freeform':
        return tUi('metadata.type.freeform');
      case 'ink':
        return tUi('metadata.type.ink');
      case 'pdf':
        return tUi('metadata.type.pdf');
      default:
        return kind
          ? tUi('metadata.type.unknownNamed').replace('{kind}', kind)
          : tUi('metadata.type.unknown');
    }
  }

  function hasContentStats(kind: string | null | undefined): boolean {
    return kind === 'markdown' || kind === 'pdf';
  }

  function canHaveAttachments(kind: string | null | undefined): boolean {
    return kind === 'markdown' || kind === 'freeform' || kind === 'pdf';
  }

  async function pdfTextForMetadata(body: string): Promise<string> {
    const assetId = pdfAssetIdFromBody(body);
    if (!assetId) return '';
    try {
      const asset = await fetchDrawingAsset(assetId);
      if (asset.mime_type !== 'application/pdf') return '';
      return await extractPdfText(new Uint8Array(asset.bytes));
    } catch (err) {
      console.warn('[metadata] failed to extract PDF text', err);
      return '';
    }
  }

  function pdfAssetIdFromBody(body: string): string | null {
    const trimmed = body.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('asset_')) return trimmed;
    try {
      const parsed = JSON.parse(trimmed) as { pdfAssetId?: unknown };
      return typeof parsed.pdfAssetId === 'string' ? parsed.pdfAssetId : null;
    } catch {
      return null;
    }
  }

  function analyzeContent(
    body: string,
    text: string,
    kind: string | null | undefined
  ) {
    const attachments = extractAssetIds(body).length;
    if (kind === 'pdf') {
      const words = countWords(text);
      return {
        words,
        readMinutes: words === 0 ? 0 : Math.max(1, Math.ceil(words / 200)),
        links: 0,
        attachments
      };
    }

    const plain = plainTextForStats(text);
    const words = countWords(plain);
    const links = countLinks(body);
    return {
      words,
      readMinutes: words === 0 ? 0 : Math.max(1, Math.ceil(words / 200)),
      links,
      attachments
    };
  }

  function countWords(text: string): number {
    return text.match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  }

  function plainTextForStats(body: string): string {
    return body
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*]\([^)]*\)/g, (match) => {
        const label = match.match(/\[([^\]]*)]/)?.[1];
        return label ?? ' ';
      })
      .replace(/[#>*_~|[\](){}:]/g, ' ');
  }

  function countLinks(body: string): number {
    const markdownLinks = body.match(/(?<!!)\[[^\]]+]\([^)]*\)/g)?.length ?? 0;
    const wikilinks = body.match(/\[\[[^\]]+]]/g)?.length ?? 0;
    return markdownLinks + wikilinks;
  }

  function extractAssetIds(body: string): string[] {
    const ids = new Set<string>();
    for (const match of body.matchAll(/asset:mindstream\/([A-Za-z0-9_-]+)/g)) {
      ids.add(match[1]);
    }
    try {
      const parsed = JSON.parse(body) as { pdfAssetId?: unknown };
      if (typeof parsed.pdfAssetId === 'string') ids.add(parsed.pdfAssetId);
    } catch {
      /* Non-JSON note bodies are expected. */
    }
    return [...ids];
  }

  function statValue(value: number): string {
    return contentLoading ? '…' : String(value);
  }

  function readValue(minutes: number): string {
    if (contentLoading) return '…';
    return tUi('metadata.content.readValue').replace(
      '{minutes}',
      String(minutes)
    );
  }

  function attachmentsValue(count: number): string {
    if (contentLoading) return '…';
    const key =
      count === 1 ? 'metadata.attachments.one' : 'metadata.attachments.other';
    return tUi(key).replace('{count}', String(count));
  }
</script>

{#snippet attachmentsRow()}
  <dl class="border-y border-border">
    <div
      class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
    >
      <dt
        class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Paperclip class="size-3.5" />
        {tUi('metadata.attachments')}
      </dt>
      <dd
        class="min-w-0 truncate text-right text-xs font-medium text-muted-foreground"
      >
        {attachmentsValue(contentStats.attachments)}
      </dd>
    </div>
  </dl>
{/snippet}

<aside class="flex h-full w-full min-w-0 flex-col bg-card text-sm">
  <div class="flex-1 overflow-y-auto p-3">
    {#if note}
      {@const NoteIcon = noteKindIcon(note.note_kind)}
      <section
        class="rounded-lg border border-border bg-background p-4 text-foreground shadow-sm"
      >
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <h3 class="truncate text-base font-semibold leading-6">
              {note.title}
            </h3>
            <p
              class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
            >
              {note.id}
            </p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => void setNoteFavourite(note.id, !note.favourite)}
            aria-pressed={note.favourite}
            aria-label={note.favourite
              ? tUi('favourite.remove')
              : tUi('favourite.add')}
            title={note.favourite
              ? tUi('favourite.remove')
              : tUi('favourite.add')}
          >
            <FavouriteStar size={16} favourited={note.favourite} />
          </button>
        </div>

        <section class="mt-5">
          <h4
            class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {tUi('metadata.organization')}
          </h4>
          <dl class="border-y border-border">
            <div
              class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
            >
              <dt
                class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Folder class="size-3.5" />
                {tUi('metadata.folder')}
              </dt>
              <dd
                class="max-w-[9rem] truncate rounded-full bg-primary/10 px-2 py-0.5 text-right text-[11px] font-medium text-primary"
                title={folderTitle}
              >
                {folderLabel}
              </dd>
            </div>
            <div
              class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
            >
              <dt
                class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Tag class="size-3.5" />
                {tUi('metadata.type')}
              </dt>
              <dd
                class="flex min-w-0 items-center justify-end gap-1.5 text-right text-xs font-medium text-muted-foreground"
              >
                <NoteIcon class="size-3.5 shrink-0" />
                <span class="truncate">{noteKindLabel(note.note_kind)}</span>
              </dd>
            </div>
          </dl>
        </section>

        <section class="mt-5">
          <h4
            class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {tUi('metadata.dates')}
          </h4>
          <dl class="border-y border-border">
            <div
              class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
            >
              <dt
                class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <CalendarPlus class="size-3.5" />
                {tUi('metadata.created')}
              </dt>
              <dd
                class="min-w-0 truncate text-right text-xs font-medium tabular-nums"
              >
                {formatNoteDateTime(note.created)}
              </dd>
            </div>
            <div
              class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
            >
              <dt
                class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                <Edit3 class="size-3.5" />
                {tUi('metadata.modified')}
              </dt>
              <dd
                class="min-w-0 truncate text-right text-xs font-medium tabular-nums"
              >
                {formatNoteDateTime(note.modified)}
              </dd>
            </div>
          </dl>
        </section>

        {#if showContentStats}
          <section class="mt-5">
            <h4
              class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {tUi('metadata.content')}
            </h4>
            <div class="grid grid-cols-3 gap-2">
              <div class="rounded-md bg-muted px-2.5 py-2">
                <div class="truncate text-base font-semibold leading-none">
                  {statValue(contentStats.words)}
                </div>
                <div class="mt-1 truncate text-[10px] text-muted-foreground">
                  {tUi('metadata.content.words')}
                </div>
              </div>
              <div class="rounded-md bg-muted px-2.5 py-2">
                <div class="truncate text-base font-semibold leading-none">
                  {readValue(contentStats.readMinutes)}
                </div>
                <div class="mt-1 truncate text-[10px] text-muted-foreground">
                  {tUi('metadata.content.read')}
                </div>
              </div>
              <div class="rounded-md bg-muted px-2.5 py-2">
                <div class="truncate text-base font-semibold leading-none">
                  {statValue(contentStats.links)}
                </div>
                <div class="mt-1 truncate text-[10px] text-muted-foreground">
                  {tUi('metadata.content.links')}
                </div>
              </div>
            </div>
            {#if showAttachments}
              <div class="mt-4">
                {@render attachmentsRow()}
              </div>
            {/if}
          </section>
        {:else if showAttachments}
          <section class="mt-5">
            <h4
              class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {tUi('metadata.attachments')}
            </h4>
            {@render attachmentsRow()}
          </section>
        {/if}

        <div class="mt-5 border-t border-border pt-5">
          <TagsSection noteId={note.id} />
        </div>

        {#if note.note_kind === 'markdown'}
          <div class="mt-5 border-t border-border pt-5">
            <NoteHistorySection noteId={note.id} />
          </div>
        {/if}
      </section>
    {:else}
      <p
        class="rounded-lg border border-border bg-background p-4 text-xs text-muted-foreground"
      >
        {tUi('metadata.noNote')}
      </p>
    {/if}
  </div>
</aside>
