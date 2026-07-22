<script lang="ts">
  import { onMount } from 'svelte';
  import { isMobile } from '$lib/platform';
  import { tUi } from '$lib/settings/i18n.svelte';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a dynamically
  // imported Svelte component has no statically-known constructor type here.
  let Shell = $state<any>(null);
  let failed = $state(false);
  let showSlowHint = $state(false);

  // Bounded self-heal for a stalled shell load (see loadShell). Kept in
  // sessionStorage so it survives the reload but resets on a fresh app launch,
  // giving each launch its own budget instead of a permanent reload loop.
  const RELOAD_KEY = 'mindstream:boot-reloads';
  const MAX_AUTO_RELOADS = 2;

  /**
   * Load a shell chunk resiliently.
   *
   * The webview's asset protocol occasionally stalls or drops a chunk fetch at
   * boot. Previously the bare `await import(...)` would then hang or reject with
   * no recovery, leaving the window blank forever — a silent failure with no
   * way out. Now:
   *   - each attempt is time-bounded (fail fast instead of hanging), and a
   *     rejected fetch is retried in-process (a fresh `import()` re-fetches);
   *   - if the chunk is genuinely wedged (the browser caches a *pending*
   *     import, so re-calling `import()` can't re-fetch it), fall back to a
   *     bounded full-document reload, which re-fetches everything from scratch;
   *   - once the reload budget is spent, surface a visible, reloadable error
   *     rather than a blank screen or an infinite reload loop.
   */
  async function loadShell(
    loader: () => Promise<{ default: unknown }>,
    { attempts = 3, timeoutMs = 8000 } = {}
  ): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const mod = await withTimeout(loader(), timeoutMs);
        resetReloadBudget();
        return mod.default;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[boot] shell chunk load failed (attempt ${attempt}/${attempts})`,
          err
        );
        await delay(300 * attempt);
      }
    }
    // In-process retries exhausted. A full reload re-fetches from a clean slate
    // and clears a wedged pending import — but only within budget.
    if (consumeReloadBudget()) {
      console.warn(
        '[boot] shell load failed — reloading the document to recover'
      );
      location.reload();
      return new Promise(() => {}); // hold the loading state until the reload lands
    }
    throw lastErr;
  }

  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`chunk load timed out after ${ms}ms`)),
          ms
        )
      )
    ]);
  }

  const delay = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  function consumeReloadBudget(): boolean {
    if (typeof sessionStorage === 'undefined') return false;
    const used = Number(sessionStorage.getItem(RELOAD_KEY) ?? '0');
    if (used >= MAX_AUTO_RELOADS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(used + 1));
    return true;
  }

  function resetReloadBudget(): void {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.removeItem(RELOAD_KEY);
  }

  async function boot(): Promise<void> {
    if (isMobile()) {
      mode = 'mobile';
      Shell = await loadShell(() => import('$lib/mobile/MobileLayout.svelte'));
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
      Shell = await loadShell(
        () => import('$lib/desktop/SingleNoteWindow.svelte')
      );
    } else {
      mode = 'desktop';
      Shell = await loadShell(
        () => import('$lib/desktop/DesktopLayout.svelte')
      );
    }
  }

  onMount(() => {
    // Only reveal the loading hint if the shell is slow to arrive, so the
    // common fast path renders no flash of loading chrome.
    const slowTimer = setTimeout(() => (showSlowHint = true), 600);
    boot()
      .catch((err) => {
        console.error('[boot] failed to load the app shell', err);
        failed = true;
      })
      .finally(() => clearTimeout(slowTimer));
  });
</script>

{#if failed}
  <div class="boot-screen" role="alert">
    <h1 class="boot-title">{tUi('boot.error.title')}</h1>
    <p class="boot-message">{tUi('boot.error.message')}</p>
    <button class="boot-reload" onclick={() => location.reload()}>
      {tUi('boot.error.reload')}
    </button>
  </div>
{:else if mode === null || Shell === null}
  {#if showSlowHint}
    <div class="boot-screen" aria-live="polite">
      <p class="boot-message">{tUi('boot.loading')}</p>
    </div>
  {/if}
{:else if mode === 'mobile'}
  <Shell />
{:else if mode === 'popout' && popoutNoteId}
  <Shell noteId={popoutNoteId} />
{:else}
  <Shell />
{/if}

<style>
  .boot-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    height: 100vh;
    padding: 2rem;
    text-align: center;
    color: var(--color-foreground, #e5e5e5);
    background: var(--color-background, #0a0a0a);
  }
  .boot-title {
    font-size: 1.125rem;
    font-weight: 600;
  }
  .boot-message {
    font-size: 0.875rem;
    opacity: 0.7;
  }
  .boot-reload {
    margin-top: 0.5rem;
    padding: 0.5rem 1.25rem;
    border-radius: 0.375rem;
    border: 1px solid var(--color-border, #333);
    background: var(--color-accent, #262626);
    color: inherit;
    cursor: pointer;
    font-size: 0.875rem;
  }
  .boot-reload:hover {
    opacity: 0.85;
  }
</style>
