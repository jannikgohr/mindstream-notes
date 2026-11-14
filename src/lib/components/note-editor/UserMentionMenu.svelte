<script lang="ts">
  /**
   * User-mention autocomplete popup. Shares state with the trigger plugin via
   * `UserMentionBridge` (see `$lib/editor/plugins/user-mention-bridge`).
   *
   * The candidate source is the only real difference from `WikilinkMenu.svelte`.
   * `NoteEditor` resolves the users who can view the note asynchronously and
   * writes them to `bridge.state.users`, so this popup filters that list by
   * query. Portal and positioning come from `typeahead-popup.svelte.ts`.
   */

  import { AtSign } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { rankSubstringMatches } from '$lib/search/substring-rank';
  import type {
    MentionUser,
    UserMentionBridge
  } from '$lib/editor/plugins/user-mention-bridge.svelte';
  import { portalToBody, useTypeaheadPopup } from './typeahead-popup.svelte';

  interface Props {
    bridge: UserMentionBridge;
  }
  let { bridge }: Props = $props();

  const MAX_RESULTS = 8;

  /**
   * Filtered candidates. Ranked: prefix matches first, then by index of the
   * substring match, ties broken on username length so shorter (more specific)
   * names surface ahead of longer ones. Empty query → the list as-is (self
   * first, which `NoteEditor` already orders).
   */
  const candidates = $derived.by<MentionUser[]>(() => {
    if (!bridge.state.open) return [];
    const q = bridge.state.query.trim().toLowerCase();
    return rankSubstringMatches(
      bridge.state.users,
      q,
      (user) => user.username,
      MAX_RESULTS
    );
  });

  function commitHighlighted() {
    const list = candidates;
    const idx = bridge.state.highlight;
    const picked = list[idx] ?? list[0];
    if (picked) {
      bridge.insert({ username: picked.username });
    } else {
      bridge.cancel();
    }
  }

  const popup = useTypeaheadPopup(
    () => bridge,
    () => candidates.length,
    commitHighlighted
  );

  function accessLabel(user: MentionUser): string {
    if (user.isSelf) return tUi('editor.userMention.self');
    switch (user.accessLevel) {
      case 'admin':
        return tUi('sharing.access.admin');
      case 'read_write':
        return tUi('sharing.access.readWrite');
      case 'read_only':
        return tUi('sharing.access.readOnly');
      default:
        return '';
    }
  }
</script>

{#if bridge.state.open && bridge.state.caretRect}
  <div
    use:portalToBody
    bind:this={popup.el}
    class="user-mention-menu fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg {popup.positioned
      ? ''
      : 'invisible pointer-events-none'}"
    style="width: 260px;"
    role="listbox"
    aria-label={tUi('editor.userMention.menu.label')}
  >
    {#if candidates.length === 0}
      <p class="px-3 py-3 text-sm text-muted-foreground">
        {tUi('editor.userMention.menu.empty')}
      </p>
    {:else}
      <div
        bind:this={popup.list}
        class="themed-scrollbar flex flex-col gap-0.5 overflow-y-auto p-2"
      >
        {#each candidates as user, i (user.username)}
          {@const active = i === bridge.state.highlight}
          {@const hint = accessLabel(user)}
          <button
            type="button"
            role="option"
            aria-selected={active}
            class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors {active
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-accent/60'}"
            onpointerdown={(e) => {
              // Don't yank focus from the editor — the trigger plugin would
              // close the menu on blur otherwise.
              e.preventDefault();
              bridge.insert({ username: user.username });
            }}
            onmouseenter={() => (bridge.state.highlight = i)}
          >
            <AtSign class="size-4 shrink-0 opacity-60" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate font-medium">
              {user.username}
            </span>
            {#if hint}
              <span class="shrink-0 text-xs opacity-70">{hint}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
