<script lang="ts">
  import { onMount } from 'svelte';
  import { isMobile } from '$lib/platform';

  /**
   * Three-way render decision, made client-side because both branches
   * depend on browser-only signals (navigator.userAgent, the Tauri
   * webview label):
   *
   *   1. Mobile (Android/iOS) → MobileLayout. Popout windows can't
   *      exist there, so we skip the popout-id detection entirely.
   *   2. Spawned popout window  → SingleNoteWindow. Detected via:
   *        a. Tauri label starting with `note_` (the canonical signal).
   *        b. ?window=editor&id=X  — browser fallback for `pnpm dev`.
   *        c. #popout=X            — legacy hash, kept for back-compat.
   *   3. Otherwise → DesktopLayout (the full multi-window shell).
   */
  let mode = $state<'mobile' | 'popout' | 'desktop' | null>(null);
  let popoutNoteId = $state<string | null>(null);
  let Shell = $state<any | null>(null);

  onMount(async () => {
    if (isMobile()) {
      mode = 'mobile';
      Shell = (await import('$lib/mobile/MobileLayout.svelte')).default;
      return;
    }

    let id: string | null = null;
    try {
      const { getCurrentWebviewWindow } =
        await import('@tauri-apps/api/webviewWindow');
      const label = getCurrentWebviewWindow().label;
      if (label.startsWith('note_')) id = label;
    } catch {
      /* Tauri API may be unavailable outside the desktop shell. */
    }
    if (!id) {
      const params = new URLSearchParams(window.location.search);
      if (params.get('window') === 'editor') {
        id = params.get('id');
      }
    }
    if (!id && window.location.hash) {
      const hashParams = new URLSearchParams(
        window.location.hash.replace(/^#/, '')
      );
      id = hashParams.get('popout');
    }

    if (id) {
      popoutNoteId = id;
      mode = 'popout';
      Shell = (await import('$lib/desktop/SingleNoteWindow.svelte')).default;
    } else {
      mode = 'desktop';
      Shell = (await import('$lib/desktop/DesktopLayout.svelte')).default;
    }
  });
</script>

{#if mode === null || Shell === null}
  <!-- One frame of empty before we decide which shell to render. -->
{:else if mode === 'mobile'}
  <Shell />
{:else if mode === 'popout' && popoutNoteId}
  <Shell noteId={popoutNoteId} />
{:else}
  <Shell />
{/if}
