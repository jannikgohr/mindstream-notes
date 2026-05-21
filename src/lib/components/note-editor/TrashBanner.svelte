<script lang="ts">
  /**
   * Banner shown above a note that's in (or descended from) the trash
   * collection. The editor is also `setReadonly(true)` from NoteEditor;
   * this is the visible affordance that explains why.
   */
  import { Trash2 } from 'lucide-svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
</script>

<div
  class="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
  role="status"
>
  <Trash2 class="size-3.5 shrink-0" aria-hidden="true" />
  <span>{tUi('editor.trash.banner')}</span>
</div>
