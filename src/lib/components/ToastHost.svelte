<script lang="ts">
  /**
   * Renders the ephemeral toast stack — bottom-right, above everything, one
   * card per entry in `toasts.items`. Mounted once (LazyRootSingletons); the
   * store owns each toast's lifetime, this only draws them.
   *
   * Portaled to `document.body` for the same reason the editor popups are: a
   * `position: fixed` element inside a transformed ancestor (dockview panels)
   * gets re-rooted, which would drift the stack off the viewport corner.
   *
   * `aria-live="polite"` on the region so screen readers announce a toast
   * without stealing focus — the confirmation is informational, and focus stays
   * wherever the user was working.
   */
  import { CheckCircle2, Info, X, XCircle } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { fly } from 'svelte/transition';
  import { prefersReducedMotion } from '$lib/reduce-motion.svelte';
  import { tUi } from '$lib/settings/i18n.svelte';
  import { dismissToast, toasts, type ToastVariant } from './toast.svelte';

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }

  const icons: Record<ToastVariant, Component> = {
    success: CheckCircle2,
    error: XCircle,
    info: Info
  };

  // Accent per variant. Success mirrors the emerald treatment used by
  // ExportResultDialog; error reuses the destructive token the share dialog's
  // inline errors already use, so the two error surfaces read as one system.
  const accents: Record<ToastVariant, string> = {
    success: 'text-emerald-600 dark:text-emerald-400',
    error: 'text-destructive',
    info: 'text-primary'
  };

  // Reduced motion → appear instantly rather than sliding in.
  const flyIn = (node: Element) =>
    fly(node, {
      y: prefersReducedMotion() ? 0 : 12,
      duration: prefersReducedMotion() ? 0 : 180
    });
</script>

{#if toasts.items.length > 0}
  <div
    use:portal
    class="pointer-events-none fixed bottom-4 right-4 z-500 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
    role="region"
    aria-live="polite"
    aria-label={tUi('toast.regionLabel')}
  >
    {#each toasts.items as toast (toast.id)}
      {@const Icon = icons[toast.variant]}
      <div
        transition:flyIn
        role="status"
        class="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg"
      >
        <Icon
          class="mt-0.5 size-4 shrink-0 {accents[toast.variant]}"
          aria-hidden="true"
        />
        <p class="min-w-0 flex-1 whitespace-pre-line text-sm">
          {toast.message}
        </p>
        <button
          type="button"
          class="-mr-1 -mt-0.5 rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={tUi('close')}
          onclick={() => dismissToast(toast.id)}
        >
          <X class="size-3.5" />
        </button>
      </div>
    {/each}
  </div>
{/if}
