<script lang="ts">
  let { noteId }: { noteId: string } = $props();
</script>

<div><input aria-label="Editor input" value={noteId} /></div>
