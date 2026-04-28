<script lang="ts">
  import { Monitor, Moon, Sun } from 'lucide-svelte';
  import { setMode, userPrefersMode } from 'mode-watcher';
  import { Button } from '$lib/components/ui/button';

  /**
   * Three-way theme cycle: Light → Dark → System → Light.
   *
   * `userPrefersMode` is the user's explicit choice (light / dark / system),
   * not the rendered mode. We read it so the icon matches the *intent*
   * (e.g. shows Monitor when "follow system", not whatever the OS chose).
   * `setMode` writes the user's choice through and ModeWatcher applies it.
   */
  function cycle() {
    const current = $userPrefersMode ?? 'system';
    const next =
      current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
    setMode(next);
  }

  const tooltip = $derived.by(() => {
    const m = $userPrefersMode ?? 'system';
    if (m === 'light') return 'Theme: Light · click for Dark';
    if (m === 'dark') return 'Theme: Dark · click for System';
    return 'Theme: System · click for Light';
  });
</script>

<Button variant="ghost" size="icon" onclick={cycle} title={tooltip} aria-label={tooltip}>
  {#if $userPrefersMode === 'light'}
    <Sun class="size-4" />
  {:else if $userPrefersMode === 'dark'}
    <Moon class="size-4" />
  {:else}
    <!-- system / undefined: show the monitor glyph -->
    <Monitor class="size-4" />
  {/if}
</Button>
