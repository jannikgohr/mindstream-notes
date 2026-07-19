<script lang="ts">
  /**
   * Banner shown above a note that's in (or descended from) the trash
   * collection. The editor is also `setReadonly(true)` from NoteEditor;
   * this is the visible affordance that explains why.
   */
  import { Trash2 } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();
</script>

<div
  class="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
>
  <div class="flex min-w-0 items-center gap-2" role="status">
    <Trash2 class="size-3.5 shrink-0" aria-hidden="true" />
    <span>{tUi('editor.trash.banner')}</span>
  </div>
  {#if children}
    <div class="-my-1 ml-auto shrink-0 text-foreground">
      {@render children()}
    </div>
  {/if}
</div>
