import {
  dismissToast,
  pushToast,
  updateToast
} from '$lib/components/toast.svelte';
import { tUi } from '$lib/settings/i18n.svelte';

/** Freeze editing while one non-dismissible toast tracks the close operation. */
export function freezeCloseInput(): {
  restore: () => void;
  phase: (phase: 'waiting' | 'prepare') => void;
} {
  // Leave the toast region outside inertness so its live announcements remain
  // available to assistive technology. Content windows cannot accept new edits.
  const content = Array.from(document.body.children)
    .filter(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && !node.hasAttribute('data-toast-region')
    )
    .map((node) => ({ node, inert: node.inert }));
  for (const { node } of content) node.inert = true;
  let message = tUi('vault.waitingForTasks');
  let toast: number | null = null;
  const phase = (phase: 'waiting' | 'prepare') => {
    message = tUi(
      phase === 'waiting' ? 'vault.waitingForTasks' : 'vault.savingChanges'
    );
    if (toast !== null) updateToast(toast, message);
  };
  const show = window.setTimeout(() => {
    toast = pushToast(message, {
      variant: 'progress',
      durationMs: 0,
      dismissible: false
    });
  }, 200);
  const block = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const events = [
    'keydown',
    'keyup',
    'pointerdown',
    'click',
    'beforeinput',
    'drop'
  ];
  for (const event of events) window.addEventListener(event, block, true);
  const restore = () => {
    window.clearTimeout(show);
    if (toast !== null) dismissToast(toast);
    for (const { node, inert } of content) node.inert = inert;
    for (const event of events) window.removeEventListener(event, block, true);
  };
  return { restore, phase };
}
