<script lang="ts">
  import {
    CalendarPlus,
    Cloud,
    Edit3,
    Folder,
    Paperclip,
    Share2,
    ShieldCheck,
    Tag,
    User,
    UserPlus,
    Users
  } from '@lucide/svelte';
  import FavouriteStar from './FavouriteStar.svelte';
  import TagsSection from '$lib/components/TagsSection.svelte';
  import NoteHistorySection from '$lib/components/NoteHistorySection.svelte';
  import PageOverlayScrollbar from '$lib/layout/page-overlay-scrollbar.svelte';
  import {
    loadNote,
    noteWordCount,
    type Collection,
    type NoteSummary
  } from '$lib/api';
  import { authSession } from '$lib/api/auth.svelte';
  import {
    getCollectionShareState,
    type CollectionMember,
    type CollectionShareAccessLevel,
    type CollectionShareState
  } from '$lib/api/sharing';
  import { noteKindIcon } from '$lib/components/note-kind-icon';
  import { formatNoteDateTime } from '$lib/date-time';
  import { findShareScopeCollectionId } from '$lib/notes/share-users';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { ui } from '$lib/state.svelte';
  import { setNoteFavourite, tree } from '$lib/stores/tree.svelte';

  // Summary only — bodies live with the editor and would force every tree
  // refresh through a load_note round trip.
  const note = $derived(
    ui.activeNoteId ? tree.notesById[ui.activeNoteId] : null
  );
  let metadataScroller = $state<HTMLDivElement | null>(null);

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

  const shareScopeId = $derived(
    note
      ? findShareScopeCollectionId(
          note.parent_collection_id,
          tree.collectionsById
        )
      : null
  );
  const shareScope = $derived(
    shareScopeId ? (tree.collectionsById[shareScopeId] ?? null) : null
  );
  let shareState = $state<CollectionShareState | null>(null);

  $effect(() => {
    const id = shareScopeId;
    shareState = null;
    if (!id) return;

    let cancelled = false;
    void getCollectionShareState(id)
      .then((state) => {
        if (!cancelled && shareScopeId === id) shareState = state;
      })
      .catch((err) => {
        console.warn('[sidebar] failed to load share metadata', err);
      });

    return () => {
      cancelled = true;
    };
  });

  const currentUsername = $derived(authSession.current?.username ?? null);
  const sharedByMe = $derived(
    shareState?.shared_by_me ?? shareScope?.shared_by_me ?? false
  );
  const authorName = $derived(
    shareState?.shared_owner ??
      shareScope?.shared_owner ??
      (sharedByMe ? currentUsername : null)
  );
  const permissionLevel = $derived(
    (shareState?.shared_role ??
      shareScope?.shared_role ??
      null) as CollectionShareAccessLevel | null
  );
  const permissionLabel = $derived(
    sharedByMe
      ? tUi('metadata.permission.owner')
      : permissionLevel
        ? accessLabel(permissionLevel)
        : ''
  );
  const collaborators = $derived(
    shareState
      ? visibleCollaborators(shareState.members, authorName, currentUsername)
      : []
  );
  const pendingInviteCount = $derived(
    shareState?.outgoing_invitations.length ?? 0
  );
  const showSharingMetadata = $derived(Boolean(shareScope));
  const showPendingSync = $derived(
    Boolean(note && authSession.current && !note.pushed)
  );

  // Body is loaded only for the link/attachment regexes; the word count comes
  // from Rust (note_word_count) so it shares one definition with the History
  // delta and never re-derives note content in JS.
  let noteBody = $state('');
  let wordCount = $state(0);
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
      wordCount = 0;
      contentLoading = false;
      return;
    }

    let cancelled = false;
    const id = note.id;
    void note.modified;
    contentLoading = true;
    Promise.all([
      noteWordCount(id),
      loadNote(id).then((loaded) => loaded.body ?? '')
    ])
      .then(([words, body]) => {
        if (!cancelled && ui.activeNoteId === id) {
          wordCount = words;
          noteBody = body;
        }
      })
      .catch((err) => {
        console.warn('[sidebar] failed to load note content stats', err);
        if (!cancelled && ui.activeNoteId === id) {
          wordCount = 0;
          noteBody = '';
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
    analyzeContent(noteBody, wordCount, note?.note_kind ?? null)
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
      case 'kanban':
        return tUi('metadata.type.kanban');
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

  // `words` is the canonical count from Rust; links/attachments are still
  // derived in JS from the body (the lookbehind link rule has no Rust regex
  // equivalent yet). PDF notes only ever have attachments.
  function analyzeContent(
    body: string,
    words: number,
    kind: string | null | undefined
  ) {
    return {
      words,
      readMinutes: words === 0 ? 0 : Math.max(1, Math.ceil(words / 200)),
      links: kind === 'pdf' ? 0 : countLinks(body),
      attachments: extractAssetIds(body).length
    };
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

  function accessLabel(level: CollectionShareAccessLevel): string {
    switch (level) {
      case 'read_only':
        return tUi('sharing.access.readOnly');
      case 'read_write':
        return tUi('sharing.access.readWrite');
      case 'admin':
        return tUi('sharing.access.admin');
    }
  }

  function visibleCollaborators(
    members: CollectionMember[],
    owner: string | null,
    me: string | null
  ): string[] {
    const hidden = new Set(
      [owner, me]
        .map((value) => value?.trim().toLowerCase())
        .filter((value): value is string => Boolean(value))
    );
    const seen = new Set<string>();
    const out: string[] = [];
    for (const member of members) {
      const username = member.username.trim();
      if (!username) continue;
      const key = username.toLowerCase();
      if (hidden.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(username);
    }
    return out;
  }

  function compactList(values: string[]): string {
    if (values.length <= 2) return values.join(', ');
    return `${values.slice(0, 2).join(', ')} +${values.length - 2}`;
  }

  function pendingInvitesLabel(count: number): string {
    const key =
      count === 1
        ? 'metadata.sharing.pending.one'
        : 'metadata.sharing.pending.other';
    return tUi(key).replace('{count}', String(count));
  }
</script>

{#snippet attachmentsRow()}
  <dl class="border-t border-border">
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

<aside class="relative flex h-full w-full min-w-0 flex-col bg-card text-sm">
  <div
    bind:this={metadataScroller}
    class="scrollbar-none flex-1 overflow-y-auto p-3"
  >
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
            {#if showPendingSync}
              <div
                class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
              >
                <dt
                  class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Cloud class="size-3.5" />
                  {tUi('metadata.sync')}
                </dt>
                <dd
                  class="min-w-0 truncate text-right text-xs font-medium text-muted-foreground"
                >
                  {tUi('metadata.sync.pending')}
                </dd>
              </div>
            {/if}
          </dl>
        </section>

        {#if showSharingMetadata && shareScope}
          <section class="mt-5">
            <h4
              class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {tUi('metadata.sharing')}
            </h4>
            <dl class="border-y border-border">
              <div
                class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
              >
                <dt
                  class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Share2 class="size-3.5" />
                  {tUi('metadata.sharing.scope')}
                </dt>
                <dd
                  class="max-w-[9rem] truncate rounded-full bg-primary/10 px-2 py-0.5 text-right text-[11px] font-medium text-primary"
                  title={shareScope.name}
                >
                  {shareScope.name}
                </dd>
              </div>
              {#if authorName}
                <div
                  class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
                >
                  <dt
                    class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <User class="size-3.5" />
                    {tUi('metadata.author')}
                  </dt>
                  <dd
                    class="min-w-0 truncate text-right text-xs font-medium text-muted-foreground"
                  >
                    {authorName}
                  </dd>
                </div>
              {/if}
              {#if permissionLabel}
                <div
                  class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
                >
                  <dt
                    class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <ShieldCheck class="size-3.5" />
                    {tUi('metadata.permission')}
                  </dt>
                  <dd
                    class="min-w-0 truncate text-right text-xs font-medium text-muted-foreground"
                  >
                    {permissionLabel}
                  </dd>
                </div>
              {/if}
              {#if collaborators.length > 0}
                <div
                  class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
                >
                  <dt
                    class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Users class="size-3.5" />
                    {tUi('metadata.collaborators')}
                  </dt>
                  <dd
                    class="min-w-0 truncate text-right text-xs font-medium text-muted-foreground"
                    title={collaborators.join(', ')}
                  >
                    {compactList(collaborators)}
                  </dd>
                </div>
              {/if}
              {#if pendingInviteCount > 0}
                <div
                  class="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2 last:border-b-0"
                >
                  <dt
                    class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <UserPlus class="size-3.5" />
                    {tUi('metadata.sharing.pending')}
                  </dt>
                  <dd
                    class="min-w-0 truncate text-right text-xs font-medium text-muted-foreground"
                  >
                    {pendingInvitesLabel(pendingInviteCount)}
                  </dd>
                </div>
              {/if}
            </dl>
          </section>
        {/if}

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

        <div
          class="mt-5 border-border"
          class:border-t={showContentStats || showAttachments}
          class:pt-5={showContentStats || showAttachments}
        >
          <TagsSection noteId={note.id} />
        </div>

        {#if note.note_kind === 'markdown' || note.note_kind === 'freeform' || note.note_kind === 'ink' || note.note_kind === 'pdf' || note.note_kind === 'kanban'}
          <div class="mt-5 border-t border-border pt-5">
            <NoteHistorySection noteId={note.id} noteKind={note.note_kind} />
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
  <PageOverlayScrollbar target={metadataScroller} />
</aside>
