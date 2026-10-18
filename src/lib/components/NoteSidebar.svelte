<script lang="ts">
  import {
    CalendarPlus,
    Cloud,
    Edit3,
    Folder,
    Paperclip,
    Share2,
    ShieldCheck,
    User,
    UserPlus,
    Users,
    X
  } from '@lucide/svelte';
  import NoteOutline from './NoteOutline.svelte';
  import { Button } from '$lib/components/ui/button';
  import FavouriteStar from './FavouriteStar.svelte';
  import TagsSection from '$lib/components/TagsSection.svelte';
  import NoteHistorySection from '$lib/components/NoteHistorySection.svelte';
  import NoteLinksSection from '$lib/components/NoteLinksSection.svelte';
  import PageOverlayScrollbar from '$lib/layout/page-overlay-scrollbar.svelte';
  import { Surface } from '$lib/components/ui/surface';
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
  import NoteKindIcon from '$lib/components/NoteKindIcon.svelte';
  import { noteHistoryEnabled } from '$lib/history/enabled';
  import { pluginNoteKind } from '$lib/plugins/registry.svelte';
  import { resolvePluginString } from '$lib/plugins/plugin-i18n';
  import { formatNoteDateTime } from '$lib/date-time';
  import { findShareScopeCollectionId } from '$lib/notes/share-users';
  import { pdfAssetIdFromBody } from '$lib/pdf/viewer-helpers';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { getSettingValue } from '$lib/settings/store.svelte';
  import { ui } from '$lib/state.svelte';
  import { setNoteFavourite, tree } from '$lib/stores/tree.svelte';

  let { onClose }: { onClose?: () => void } = $props();

  // Summary only — bodies live with the editor and would force every tree
  // refresh through a load_note round trip.
  const note = $derived(
    ui.activeNoteId ? tree.notesById[ui.activeNoteId] : null
  );
  const showMetadata = $derived(
    getSettingValue('appearance.sidebar.metadata') !== false
  );
  const showHistory = $derived(
    getSettingValue('appearance.sidebar.history') !== false
  );
  const showLinks = $derived(
    getSettingValue('appearance.sidebar.links') !== false
  );
  const supportsNoteLinks = $derived(note?.note_kind === 'markdown');
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
  const showShareScopeRow = $derived(
    Boolean(note && shareScope && shareScope.id !== note.parent_collection_id)
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
  const showSharingMetadata = $derived(
    Boolean(
      shareScope &&
      (showShareScopeRow ||
        authorName ||
        permissionLabel ||
        collaborators.length > 0 ||
        pendingInviteCount > 0)
    )
  );
  const showPendingSync = $derived(
    Boolean(note && authSession.current && !note.pushed)
  );

  // Body is loaded only for the attachment scan; the word count comes from
  // Rust (note_word_count) so it shares one definition with the History delta
  // and never re-derives note content in JS.
  let noteBody = $state('');
  let wordCount = $state(0);
  // The note the two values above describe. Every save reloads them; keeping
  // the previous values meanwhile stops the summary flashing on each autosave,
  // while switching notes shows a placeholder until the new note's arrive.
  let statsNoteId = $state<string | null>(null);
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
      statsNoteId = null;
      return;
    }

    let cancelled = false;
    const id = note.id;
    void note.modified;
    Promise.all([
      noteWordCount(id),
      loadNote(id).then((loaded) => loaded.body ?? '')
    ])
      .then(([words, body]) => {
        if (!cancelled && ui.activeNoteId === id) {
          wordCount = words;
          noteBody = body;
          statsNoteId = id;
        }
      })
      .catch((err) => {
        console.warn('[sidebar] failed to load note content stats', err);
        if (!cancelled && ui.activeNoteId === id) {
          wordCount = 0;
          noteBody = '';
          statsNoteId = id;
        }
      });

    return () => {
      cancelled = true;
    };
  });

  const statsReady = $derived(note !== null && statsNoteId === note.id);
  const attachmentCount = $derived(extractAssetIds(noteBody).length);
  const contentSummary = $derived.by(() => {
    if (!statsReady) return '…';
    const words = tUi(
      wordCount === 1
        ? 'metadata.content.wordCount.one'
        : 'metadata.content.wordCount.other'
    ).replace('{count}', String(wordCount));
    if (wordCount === 0) return words;
    const minutes = Math.max(1, Math.ceil(wordCount / 200));
    return `${words} · ${tUi('metadata.content.readingTime').replace(
      '{minutes}',
      String(minutes)
    )}`;
  });
  // "0 files" is noise in a details list; the row appears once there is one.
  const showAttachmentRow = $derived(
    showAttachments && statsReady && attachmentCount > 0
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
      default: {
        // A plugin-owned kind (e.g. `plugin.com.mindstream.typst.document`)
        // resolves to its contributed, localized label ("Typst document")
        // rather than the raw stored string — mirroring NoteKindIcon.
        const ref = pluginNoteKind(kind);
        if (ref) {
          return resolvePluginString(ref.pluginId, ref.contribution.labelKey);
        }
        return kind
          ? tUi('metadata.type.unknownNamed').replace('{kind}', kind)
          : tUi('metadata.type.unknown');
      }
    }
  }

  function hasContentStats(kind: string | null | undefined): boolean {
    return kind === 'markdown' || kind === 'pdf';
  }

  function canHaveAttachments(kind: string | null | undefined): boolean {
    return kind === 'markdown' || kind === 'freeform' || kind === 'pdf';
  }

  function extractAssetIds(body: string): string[] {
    const ids = new Set<string>();
    for (const match of body.matchAll(/asset:mindstream\/([A-Za-z0-9_-]+)/g)) {
      ids.add(match[1]);
    }
    const pdfAssetId = pdfAssetIdFromBody(body);
    if (pdfAssetId) ids.add(pdfAssetId);
    return [...ids];
  }

  function attachmentsValue(count: number): string {
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

{#snippet detailRow(
  Icon: typeof Paperclip,
  label: string,
  value: string,
  title?: string
)}
  <div class="flex min-w-0 items-center justify-between gap-4">
    <dt
      class="inline-flex shrink-0 items-center gap-2 text-xs text-muted-foreground"
    >
      <Icon class="size-3.5" />
      {label}
    </dt>
    <dd class="min-w-0 truncate text-right text-xs tabular-nums" {title}>
      {value}
    </dd>
  </div>
{/snippet}

<Surface
  as="aside"
  variant="panel"
  class="note-details-panel relative flex h-full w-full min-w-0 flex-col text-sm"
>
  <header
    class="flex h-[42px] shrink-0 items-center justify-between border-b border-border bg-surface-0 px-5"
  >
    <h2 class="text-xs font-medium">{tUi('sidebar.details')}</h2>
    {#if onClose}<Button
        variant="ghost"
        size="icon"
        class="size-6 text-muted-foreground"
        onclick={onClose}
        aria-label={tUi('sidebar.close')}
        title={tUi('sidebar.hide')}><X class="size-3.5" /></Button
      >{/if}
  </header>
  <div
    bind:this={metadataScroller}
    class="scrollbar-none min-h-0 flex-1 overflow-y-auto px-5 py-5"
  >
    {#if note}
      {#if showMetadata}
        <!-- Identity, then one untitled list of facts. The labels name
             themselves, so the list needs no section heading; sharing facts
             follow after a gap when the note sits in a shared folder. -->
        <div class="flex min-w-0 items-start justify-between gap-3">
          <div class="min-w-0">
            <div
              class="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              <NoteKindIcon
                kind={note.note_kind}
                class="size-3 shrink-0"
              />{noteKindLabel(note.note_kind)}
            </div>
            <h3
              class="truncate text-base font-semibold leading-6"
              title={note.title}
            >
              {note.title}
            </h3>
            {#if showContentStats}
              <p
                class="mt-0.5 truncate text-xs tabular-nums text-muted-foreground"
              >
                {contentSummary}
              </p>
            {/if}
          </div>
          <button
            type="button"
            class="-mr-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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

        <dl class="mt-5 space-y-2.5">
          {@render detailRow(
            Folder,
            tUi('metadata.folder'),
            folderLabel,
            folderTitle
          )}
          {@render detailRow(
            CalendarPlus,
            tUi('metadata.created'),
            formatNoteDateTime(note.created)
          )}
          {@render detailRow(
            Edit3,
            tUi('metadata.modified'),
            formatNoteDateTime(note.modified)
          )}
          {#if showPendingSync}
            {@render detailRow(
              Cloud,
              tUi('metadata.sync'),
              tUi('metadata.sync.pending')
            )}
          {/if}
          {#if showAttachmentRow}
            {@render detailRow(
              Paperclip,
              tUi('metadata.attachments'),
              attachmentsValue(attachmentCount)
            )}
          {/if}
        </dl>

        {#if showSharingMetadata && shareScope}
          <dl class="mt-4 space-y-2.5">
            {#if showShareScopeRow}
              {@render detailRow(
                Share2,
                tUi('metadata.sharing.scope'),
                shareScope.name,
                shareScope.name
              )}
            {/if}
            {#if authorName}
              {@render detailRow(User, tUi('metadata.author'), authorName)}
            {/if}
            {#if permissionLabel}
              {@render detailRow(
                ShieldCheck,
                tUi('metadata.permission'),
                permissionLabel
              )}
            {/if}
            {#if collaborators.length > 0}
              {@render detailRow(
                Users,
                tUi('metadata.collaborators'),
                compactList(collaborators),
                collaborators.join(', ')
              )}
            {/if}
            {#if pendingInviteCount > 0}
              {@render detailRow(
                UserPlus,
                tUi('metadata.sharing.pending'),
                pendingInvitesLabel(pendingInviteCount)
              )}
            {/if}
          </dl>
        {/if}

        <div class="mt-5 border-t border-border pt-5">
          <TagsSection noteId={note.id} />
        </div>
        {#if supportsNoteLinks}<NoteOutline noteId={note.id} />{/if}
      {/if}

      {#if showHistory && noteHistoryEnabled(note.note_kind)}
        <Surface
          as="section"
          variant="panel"
          class="mt-5 border-t border-border bg-transparent pt-5"
        >
          <NoteHistorySection noteId={note.id} noteKind={note.note_kind} />
        </Surface>
      {/if}

      {#if supportsNoteLinks && showLinks}
        <div class="mt-5 border-t border-border pt-5">
          <NoteLinksSection noteId={note.id} flat />
        </div>
      {/if}

      {#if !showMetadata && !(showHistory && noteHistoryEnabled(note.note_kind)) && !(supportsNoteLinks && showLinks)}
        <Surface as="p" variant="panel" class="text-xs text-muted-foreground">
          {tUi('sidebar.sections.empty')}
        </Surface>
      {/if}
    {:else}
      <Surface as="p" variant="panel" class="text-xs text-muted-foreground">
        {tUi('metadata.noNote')}
      </Surface>
    {/if}
  </div>
  <PageOverlayScrollbar target={metadataScroller} />
</Surface>
