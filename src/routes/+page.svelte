<script lang="ts">
  import { onMount } from 'svelte';
  import Layout from '$lib/components/Layout.svelte';
  import SingleNoteWindow from '$lib/components/SingleNoteWindow.svelte';

  // Decide between the full app shell and the single-note popout based on
  // the URL the window was opened with. The query is read once on mount —
  // popout windows aren't expected to navigate to /.
  let popoutNoteId = $state<string | null>(null);
  let resolved = $state(false);

  onMount(() => {
    // Try the query string first (preferred), fall back to the hash if a
    // path-based asset resolver stripped query params.
    const params = new URLSearchParams(window.location.search);
    if (params.get('window') === 'editor') {
      const id = params.get('id');
      if (id) popoutNoteId = id;
    }

    if (!popoutNoteId && window.location.hash) {
      // hash format: '#popout=<id>'
      const hash = window.location.hash.replace(/^#/, '');
      const hashParams = new URLSearchParams(hash);
      const id = hashParams.get('popout');
      if (id) popoutNoteId = id;
    }

    resolved = true;
  });
</script>

{#if !resolved}
  <!-- One frame of empty before we decide the layout — avoids a flash of
       the main shell in popout windows. -->
{:else if popoutNoteId}
  <SingleNoteWindow noteId={popoutNoteId} />
{:else}
  <Layout />
{/if}
