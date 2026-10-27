<script lang="ts">
  /**
   * Sites allowed to load embeds in shared drawings, listed so they can be
   * taken back out.
   *
   * Adding happens on the blocked embed itself, where the user sees which
   * site it is. This panel is the way to undo that.
   */
  import { Trash2 } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    allowedEmbedHosts,
    removeAllowedEmbedHost
  } from '$lib/freeform/embed-allowed-hosts';
  import { tUi } from '$lib/settings/i18n.svelte';

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = '' }: Props = $props();

  const hosts = $derived(allowedEmbedHosts());

  const visible = $derived.by(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return hosts;
    return hosts.filter((host) => host.includes(query));
  });

  function remove(host: string): void {
    void removeAllowedEmbedHost(host).catch((err) => {
      console.warn('[settings] failed to remove embed host', host, err);
    });
  }
</script>

<div class="mt-2">
  {#if hosts.length === 0}
    <p class="text-xs text-muted-foreground">
      {tUi('editor.freeform.embedAllowedHosts.empty')}
    </p>
  {:else}
    <div class="flex flex-wrap gap-1.5">
      {#each visible as host (host)}
        <span
          class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
        >
          {host}
          <Button
            variant="ghost"
            size="sm"
            class="size-4 p-0"
            onclick={() => remove(host)}
            aria-label="{tUi(
              'editor.freeform.embedAllowedHosts.remove'
            )} {host}"
          >
            <Trash2 class="size-3" />
          </Button>
        </span>
      {/each}
    </div>
  {/if}
</div>
