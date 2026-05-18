/**
 * Queue + imperative API for the themed `confirm()` dialog. Lives in a
 * standalone `.svelte.ts` file (not the component's <script module>)
 * because TypeScript's ambient `declare module '*.svelte'` shim only
 * exposes the default export — named exports from a `<script module>`
 * block work at runtime through Vite but show as missing to plain `tsc`
 * / IDE checks. Same pattern as button-variants.ts.
 *
 * Bonus: this file imports nothing from bits-ui, so non-component
 * callers (registry.svelte.ts) can static-import `confirm()` here
 * without dragging bits-ui's re-export chain into their static graph —
 * which was the reason the previous code reached for a dynamic import.
 */

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button with the destructive (red) variant. */
  destructive?: boolean;
}

export interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * Reactive queue consumed by `ConfirmDialog.svelte`. Module-level
 * `$state` means a single shared instance regardless of how many
 * `ConfirmDialog` mounts exist (in practice: exactly one, in the root
 * layout).
 */
export const confirmQueue = $state<{ items: PendingConfirm[] }>({
  items: []
});

/**
 * Pop the themed confirm dialog and await the user's decision. Concurrent
 * calls are queued in order — a second `confirm()` while one is open
 * waits for the user's first decision before showing.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    confirmQueue.items = [...confirmQueue.items, { ...opts, resolve }];
  });
}
