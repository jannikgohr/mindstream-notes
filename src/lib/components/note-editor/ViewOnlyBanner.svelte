<script lang="ts">
  /**
   * Banner shown above a note that lives in a folder shared *with* the user at
   * read-only access. The editor is also `setReadonly(true)` from NoteEditor;
   * this is the visible affordance that explains why editing is disabled.
   * Sibling to TrashBanner — neutral styling rather than destructive, since a
   * view-only share isn't an error state.
   */
  import { Eye } from '@lucide/svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
</script>

<div
  class="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
  role="status"
>
  <Eye class="size-3.5 shrink-0" aria-hidden="true" />
  <span>{tUi('editor.viewonly.banner')}</span>
</div>
