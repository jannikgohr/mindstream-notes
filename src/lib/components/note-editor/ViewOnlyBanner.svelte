<script lang="ts">
  /**
   * Banner shown above a note that lives in a folder shared *with* the user at
   * read-only access. The editor is also `setReadonly(true)` from NoteEditor;
   * this is the visible affordance that explains why editing is disabled.
   * Sibling to TrashBanner — neutral styling rather than destructive, since a
   * view-only share isn't an error state.
   */
  import { Eye } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();
</script>

<div
  class="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
>
  <div class="flex min-w-0 items-center gap-2" role="status">
    <Eye class="size-3.5 shrink-0" aria-hidden="true" />
    <span>{tUi('editor.viewonly.banner')}</span>
  </div>
  {#if children}
    <div class="-my-1 ml-auto shrink-0 text-foreground">
      {@render children()}
    </div>
  {/if}
</div>
