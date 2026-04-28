<script lang="ts">
  import { Moon, Sun } from 'lucide-svelte';
  import { toggleMode, mode } from 'mode-watcher';
  import { Button } from '$lib/components/ui/button';
</script>

<Button
  variant="ghost"
  size="icon"
  onclick={toggleMode}
  title="Toggle theme"
  aria-label="Toggle theme"
>
  {#if $mode === 'dark'}
    <Sun class="size-4" />
  {:else}
    <Moon class="size-4" />
  {/if}
</Button>
