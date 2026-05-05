<script lang="ts">
  import { onMount } from 'svelte';
  import Layout from '$lib/components/Layout.svelte';
  import SingleNoteWindow from '$lib/components/SingleNoteWindow.svelte';

  /**
   * Decide between the full app shell and the single-note popout.
   *
   * Three lookup paths, in order:
   *   1. window.__POPOUT_NOTE_ID__   — set by Tauri's initialization_script
   *      when open_note_window spawned this window. The most reliable
   *      mechanism because it bypasses URL / asset-resolver quirks.
   *   2. ?window=editor&id=X         — browser fallback for `pnpm dev`
   *      (window.open returns a tab with this query string).
   *   3. #popout=X                   — legacy hash, kept for back-compat.
   */
  let popoutNoteId = $state<string | null>(null);
  let resolved = $state(false);

  onMount(() => {
    const injected = (window as unknown as { __POPOUT_NOTE_ID__?: unknown })
      .__POPOUT_NOTE_ID__;
    if (typeof injected === 'string' && injected) {
      popoutNoteId = injected;
    }

    if (!popoutNoteId) {
      const params = new URLSearchParams(window.location.search);
      if (params.get('window') === 'editor') {
        const id = params.get('id');
        if (id) popoutNoteId = id;
      }
    }

    if (!popoutNoteId && window.location.hash) {
      const hash = window.location.hash.replace(/^#/, '');
      const hashParams = new URLSearchParams(hash);
      const id = hashParams.get('popout');
      if (id) popoutNoteId = id;
    }

    resolved = true;
  });
</script>

{#if !resolved}
  <!-- One frame of empty before we decide which shell to render. -->
{:else if popoutNoteId}
  <SingleNoteWindow noteId={popoutNoteId} />
{:else}
  <Layout />
{/if}
