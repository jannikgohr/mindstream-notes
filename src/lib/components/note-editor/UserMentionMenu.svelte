<script lang="ts">
  /**
   * User-mention autocomplete popup. Shares state with the trigger plugin via
   * `UserMentionBridge` (see `$lib/editor/plugins/user-mention-bridge`).
   *
   * Structurally identical to `WikilinkMenu.svelte` — portaled to
   * `document.body` (so dockview panel transforms can't capture our
   * `position: fixed`) and positioned with `@floating-ui/dom` against a virtual
   * element at the caret. The only real difference is the candidate source:
   * the list of users who can view the note is resolved asynchronously by
   * `NoteEditor` and handed to us via `bridge.state.users`, so here we just
   * filter that list by the query rather than reading a store.
   */

  import { tick } from 'svelte';
  import {
    computePosition,
    flip,
    offset,
    shift,
    size,
    type VirtualElement
  } from '@floating-ui/dom';
  import { AtSign } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import type {
    CaretRect,
    MentionUser,
    UserMentionBridge
  } from '$lib/editor/plugins/user-mention-bridge.svelte';

  interface Props {
    bridge: UserMentionBridge;
  }
  let { bridge }: Props = $props();

  const MAX_RESULTS = 8;
  /** Offset between the caret and the menu's top edge, in px. */
  const MENU_OFFSET = 6;
  /** Hard cap on the menu's height even when there's plenty of room. */
  const MENU_MAX_HEIGHT = 360;
  /** Edge padding so the menu doesn't kiss the viewport edge. */
  const VIEWPORT_PADDING = 8;

  /**
   * Filtered candidates. Ranked: prefix matches first, then by index of the
   * substring match, ties broken on username length so shorter (more specific)
   * names surface ahead of longer ones. Empty query → the list as-is (self
   * first, which `NoteEditor` already orders).
   */
  const candidates = $derived.by<MentionUser[]>(() => {
    if (!bridge.state.open) return [];
    const q = bridge.state.query.trim().toLowerCase();
    const all = bridge.state.users;
    if (!q) return all.slice(0, MAX_RESULTS);
    const scored: Array<{ user: MentionUser; rank: number }> = [];
    for (const user of all) {
      const name = user.username.toLowerCase();
      const idx = name.indexOf(q);
      if (idx < 0) continue;
      const rank = idx === 0 ? 0 : idx + name.length / 1000;
      scored.push({ user, rank });
    }
    scored.sort((a, b) => a.rank - b.rank);
    return scored.slice(0, MAX_RESULTS).map((s) => s.user);
  });

  // Keep the plugin's highlight inside the visible range as candidates shrink
  // or grow with the filter.
  $effect(() => {
    const len = candidates.length;
    if (len === 0) {
      if (bridge.state.highlight !== 0) bridge.state.highlight = 0;
      return;
    }
    if (bridge.state.highlight >= len) {
      bridge.state.highlight = len - 1;
    } else if (bridge.state.highlight < 0) {
      bridge.state.highlight = 0;
    }
  });

  $effect(() => {
    bridge.setCommitFromPopup(() => {
      const list = candidates;
      const idx = bridge.state.highlight;
      const picked = list[idx] ?? list[0];
      if (picked) {
        bridge.insert({ username: picked.username });
      } else {
        bridge.cancel();
      }
    });
  });

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

  /* --- portal: keep the menu out from under transformed ancestors -------- */

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }

  /* --- floating-ui positioning ------------------------------------------- */

  let popupEl = $state<HTMLDivElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let positioned = $state(false);
  let positionRun = 0;

  async function reposition(rect: CaretRect, el: HTMLElement) {
    const virtualEl: VirtualElement = {
      getBoundingClientRect: () => ({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        toJSON: () => rect
      })
    };
    const { x, y } = await computePosition(virtualEl, el, {
      placement: 'bottom-start',
      middleware: [
        offset(MENU_OFFSET),
        flip({ padding: VIEWPORT_PADDING }),
        shift({ padding: VIEWPORT_PADDING }),
        size({
          padding: VIEWPORT_PADDING,
          apply({ availableHeight, elements }) {
            Object.assign(elements.floating.style, {
              maxHeight: `${Math.min(availableHeight, MENU_MAX_HEIGHT)}px`
            });
          }
        })
      ]
    });
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  $effect(() => {
    const open = bridge.state.open;
    const rect = bridge.state.caretRect;
    void bridge.state.query;
    positionRun += 1;
    positioned = false;
    if (!open || !rect || !popupEl) return;
    const run = positionRun;
    void reposition(rect, popupEl).then(() => {
      if (run === positionRun && bridge.state.open) positioned = true;
    });
  });

  $effect(() => {
    if (!bridge.state.open) return;
    const onResize = () => {
      const rect = bridge.state.caretRect;
      if (rect && popupEl) {
        const run = ++positionRun;
        positioned = false;
        void reposition(rect, popupEl).then(() => {
          if (run === positionRun && bridge.state.open) positioned = true;
        });
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  // Scroll the highlighted row into view when navigating with arrow keys.
  const SCROLL_OPTS: ScrollIntoViewOptions = { block: 'nearest' as const };
  $effect(() => {
    const idx = bridge.state.highlight;
    if (!bridge.state.open) return;
    void tick().then(() => {
      const el = listEl?.children?.[idx] as HTMLElement | undefined;
      el?.scrollIntoView(SCROLL_OPTS);
    });
  });
</script>

{#if bridge.state.open && bridge.state.caretRect}
  <div
    use:portal
    bind:this={popupEl}
    class="user-mention-menu fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg {positioned
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
        bind:this={listEl}
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
