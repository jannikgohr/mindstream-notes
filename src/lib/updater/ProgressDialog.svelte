<script lang="ts">
  /**
   * Blocking progress dialog driven by `progress.svelte.ts`. Mounted once
   * at the root (alongside ConfirmDialog), so any caller that drives the
   * updater state machine gets the UI for free.
   *
   * Non-dismissible by design: a partial download that gets killed mid-
   * flight by a closed dialog leaves disk artefacts and confuses the
   * resume path. The user committed to the install at the previous
   * confirm() — that's the cancel point.
   */

  import { Dialog } from 'bits-ui';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { updaterProgress } from './progress.svelte';

  // Round to 1 decimal at MB+ scale, integer at KB scale. Matches the
  // precision users actually care about for a download bar (jumpy
  // decimal places at KB scale are visual noise, not information).
  function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return i >= 2
      ? `${v.toFixed(1)} ${units[i]}`
      : `${Math.round(v)} ${units[i]}`;
  }

  /**
   * Refuse every close attempt while a download is in flight. bits-ui
   * Dialog drives close via three channels we have to handle:
   *
   *   onOpenChange    — called *after* an attempted close (overlay click,
   *                     Escape, programmatic). We just no-op; since `open`
   *                     is a controlled prop bound to state we don't own
   *                     here, not flipping the state keeps the dialog
   *                     mounted.
   *   onEscapeKeydown — preventDefault stops bits-ui from synthesising
   *                     the close.
   *   onInteractOutside — same, for click-outside.
   *
   * Inlining these as arrow bodies confused the WebStorm Svelte parser
   * (it saw the inner block's `}` as the end of the attribute value),
   * so they're named functions in the script block — the markup
   * attributes stay simple identifiers the parser can't trip on.
   *
   * Aborting a partial download mid-flight leaves disk artefacts and
   * confuses the resume path; the user's commit point is the
   * "Download and install" confirm one step earlier.
   */
  function ignoreClose(): void {
    // intentionally empty
  }
  function suppressClose(e: Event): void {
    e.preventDefault();
  }

  // Indeterminate when total is 0 (server didn't send Content-Length) or
  // while we're in the install phase (no server-side progress to track).
  const isIndeterminate = $derived(
    updaterProgress.phase === 'installing' || updaterProgress.total === 0
  );
  const percent = $derived(
    updaterProgress.total > 0
      ? Math.min(
          100,
          Math.round((updaterProgress.downloaded / updaterProgress.total) * 100)
        )
      : 0
  );
  const sizeLabel = $derived.by(() => {
    if (updaterProgress.total > 0) {
      return `${formatBytes(updaterProgress.downloaded)} / ${formatBytes(updaterProgress.total)}`;
    }
    return formatBytes(updaterProgress.downloaded);
  });
</script>

<Dialog.Root open={updaterProgress.active} onOpenChange={ignoreClose}>
  <Dialog.Portal>
    <!--
      z-[400] matches ConfirmDialog so we're above the Settings dialog
      (z-50). The two never co-exist in the current flow (confirm →
      progress → confirm) so they don't fight for paint order.
    -->
    <Dialog.Overlay
      class="fixed inset-0 z-[400] bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-[400] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 text-card-foreground shadow-xl focus:outline-none"
      onEscapeKeydown={suppressClose}
      onInteractOutside={suppressClose}
    >
      <Dialog.Title class="text-base font-semibold">
        {tUi('updater.progress.title')}
      </Dialog.Title>
      <Dialog.Description class="mt-2 text-sm text-muted-foreground">
        {updaterProgress.phase === 'installing'
          ? tUi('updater.progress.installing')
          : tUi('updater.progress.downloading')}
      </Dialog.Description>

      <!-- Progress track. Indeterminate path uses a CSS animation
           (defined in app.css alongside other theme primitives), and
           falls back to a static empty bar if reduced-motion is on.
           Determinate path animates width via the `transition` utility
           so the bar slides rather than jumping every throttle tick. -->
      <div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
        {#if isIndeterminate}
          <div
            class="h-full w-1/3 rounded-full bg-primary updater-indeterminate motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-30"
          ></div>
        {:else}
          <div
            class="h-full rounded-full bg-primary transition-[width] duration-100 ease-out"
            style="width: {percent}%"
          ></div>
        {/if}
      </div>

      <div
        class="mt-2 flex items-center justify-between text-xs text-muted-foreground tabular-nums"
      >
        <span>{sizeLabel}</span>
        {#if !isIndeterminate}
          <span>{percent}%</span>
        {/if}
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  /* Indeterminate sweep. Kept scoped to this component so the animation
     name can't collide with anything else in the app, and motion-reduce
     opt-out is handled at the utility class level above. */
  :global(.updater-indeterminate) {
    animation: updater-indeterminate-sweep 1.4s ease-in-out infinite;
    transform: translateX(-100%);
  }
  @keyframes updater-indeterminate-sweep {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(400%);
    }
  }
</style>
