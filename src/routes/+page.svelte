<script lang="ts">
  import { onMount } from 'svelte';
  import Layout from '$lib/components/Layout.svelte';
  import SingleNoteWindow from '$lib/components/SingleNoteWindow.svelte';
  import {listen} from "$lib/api/events";
  import {getCurrentWebviewWindow} from "@tauri-apps/api/webviewWindow";


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

  listen('fullscreen-note', data => {
    console.log('Fullscreen-note:', data);
    (window as unknown as { __POPOUT_NOTE_ID__?: unknown }).__POPOUT_NOTE_ID__ = data.noteId;
  })
  console.log('WVLabel:', getCurrentWebviewWindow().label)

  onMount(() => {
    console.log('Mounted')
    let wv_label = getCurrentWebviewWindow().label
    if (wv_label.startsWith('note_')) {
      popoutNoteId = wv_label
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
