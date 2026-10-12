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
import { freezeCloseInput } from './close-overlay';

export function installWorkerCloseBridge(): () => void {
  if (!isTauri() || isMobile()) return () => {};
  let overlay: ReturnType<typeof freezeCloseInput> | null = null;
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
    freeze: () => {
      const current = freezeCloseInput();
      overlay = current;
      return () => {
        current.restore();
        if (overlay === current) overlay = null;
      };
    },
    phase: (phase) => overlay?.phase(phase),
    failed: (reason) => {
      const message =
        reason === 'recovery'
          ? 'vault.switchCancelled'
          : reason === 'background'
            ? 'vault.backgroundBusy'
            : 'vault.closeFailed';
      pushToast(tUi(message), {
        variant: reason === 'recovery' ? 'info' : 'error',
        durationMs: reason === 'recovery' ? 6000 : 0
      });
    },
    onError: (error) => console.warn('[vaults] close persistence failed', error)
  });
  let stopped = false;
  const subscription = listen(TauriEventName.VaultWorkerClose, (notice) => {
    void participant.receive(notice);
  });
  const captureFailure = listen(TauriEventName.CaptureFailed, (notice) => {
    pushToast(notice.message, { variant: 'error', durationMs: 0 });
  });
  void captureFailure.catch((error) =>
    console.warn('[vaults] capture listener unavailable', error)
  );
  const quitFailure = listen(TauriEventName.EnvironmentQuitFailed, (notice) => {
    pushToast(`${tUi('vault.closeFailed')} ${notice.message}`, {
      variant: 'error',
      durationMs: 0
    });
  });
  void quitFailure.catch((error) =>
    console.warn('[vaults] quit listener unavailable', error)
  );
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
    void captureFailure.then((unlisten) => unlisten()).catch(() => {});
    void quitFailure.then((unlisten) => unlisten()).catch(() => {});
    void subscription.then((unlisten) => unlisten()).catch(() => {});
  };
}
