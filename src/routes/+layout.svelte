<script lang="ts">
  import '../app.css';
  import { onMount, type Component, type Snippet } from 'svelte';
  let { children } = $props();
  let picker = $state(false);
  let AppLayout = $state<Component<{ children: Snippet }> | null>(null);
  let failed = $state(false);
  onMount(() => {
    picker = /^\/vault-picker\/?$/.test(window.location.pathname);
    if (!picker)
      void import('$lib/components/AppLayout.svelte')
        .then((module) => {
          AppLayout = module.default;
        })
        .catch((error) => {
          console.error('[app] layout load failed', error);
          failed = true;
        });
  });
</script>

{#if picker}
  {@render children()}
{:else if AppLayout}
  <AppLayout>{@render children()}</AppLayout>
{:else if failed}
  <div
    class="flex h-screen items-center justify-center bg-background text-foreground"
  >
    <p>The app could not load. Reload the window to try again.</p>
  </div>
{/if}
