<script lang="ts">
  import '../app.css';
  import { ModeWatcher } from 'mode-watcher';

  let { children } = $props();
</script>

<ModeWatcher defaultMode="system" />

<div class="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
  {@render children()}
</div>
