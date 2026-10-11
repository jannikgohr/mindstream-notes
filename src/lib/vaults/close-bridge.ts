import {
  invokeOrFallback,
  isTauri,
  TauriCommandName,
  assertBoolean,
  assertVoid
} from '$lib/api/core';
import { listen, TauriEventName } from '$lib/api/events';
import { isMobile } from '$lib/platform';
import { flushBeforeAppClose } from '$lib/editor/suspend-flush';
import { flushSettingsWrites } from '$lib/settings/store.svelte';
import { tUi } from '$lib/settings/i18n.svelte';
import { pushToast } from '$lib/components/toast.svelte';
import { createCloseParticipant } from './close-participant';

function freezeInput(): () => void {
  const prior = document.body.inert;
  document.body.inert = true;
  const status = document.createElement('dialog');
  status.className =
    'rounded-lg border border-border bg-background p-6 text-foreground shadow-lg';
  status.setAttribute('aria-label', tUi('saving'));
  status.textContent = tUi('saving');
  status.addEventListener('cancel', (event) => event.preventDefault());
  document.body.append(status);
  // A modal dialog escapes ancestor inertness; it remains visible while all
  // application controls and hotkeys wait for the native decision.
  try {
    status.showModal();
  } catch {
    status.remove();
  }
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
  return () => {
    document.body.inert = prior;
    if (status.open) status.close();
    status.remove();
    for (const event of events) window.removeEventListener(event, block, true);
  };
}

export function installWorkerCloseBridge(): () => void {
  if (!isTauri() || isMobile()) return () => {};
  const participant = createCloseParticipant({
    flush: async () => {
      try {
        await flushBeforeAppClose();
      } finally {
        await flushSettingsWrites();
      }
    },
    acknowledge: (id, saved) =>
      invokeOrFallback(
        TauriCommandName.VaultWindowCloseAck,
        { id, saved },
        () => undefined,
        (value) => assertVoid(value, 'vault close acknowledgement')
      ),
    freeze: freezeInput,
    failed: () => {
      pushToast(tUi('vault.closeFailed'), { variant: 'error', durationMs: 0 });
    },
    onError: (error) => console.warn('[vaults] close persistence failed', error)
  });
  let stopped = false;
  const subscription = listen(TauriEventName.VaultWorkerClose, (notice) => {
    void participant.receive(notice);
  });
  // Register only after the event listener exists. A loading window cannot be
  // mistaken for a saved window by the native worker.
  void subscription
    .then(async (unlisten) => {
      if (stopped) {
        unlisten();
        return;
      }
      await invokeOrFallback(
        TauriCommandName.VaultWindowCloseReady,
        { protocol: 2 },
        () => false,
        (value) => assertBoolean(value, 'vault close participant')
      );
    })
    .catch((error) =>
      console.warn('[vaults] close listener unavailable', error)
    );
  return () => {
    stopped = true;
    participant.dispose();
    void subscription.then((unlisten) => unlisten()).catch(() => {});
  };
}
