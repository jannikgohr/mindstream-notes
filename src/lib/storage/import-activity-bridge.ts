/**
 * Feeds `import-activity` from `import-progress` events, in every window.
 *
 * A window that opens while an import runs asks the app whether one does,
 * and a window that is waiting checks every few seconds, so a missed
 * `finished` event cannot hold its writes for good. When the import ends,
 * the window reloads its tree to show what it brought in.
 */

import { invokeTauri, isTauri, TauriCommandName } from '$lib/api/core';
import { listen, TauriEventName } from '$lib/api/events';
import { loadTree, tree } from '$lib/stores/tree.svelte';
import {
  importActivity,
  importFinished,
  importProgressed
} from './import-activity.svelte';

const RECHECK_MS = 3000;

async function appIsImporting(): Promise<boolean> {
  try {
    return (
      (await invokeTauri<boolean>(TauriCommandName.NotesImportRunning)) === true
    );
  } catch {
    return false;
  }
}

export function installImportActivityBridge(): () => void {
  let recheck: ReturnType<typeof setInterval> | null = null;
  const stopRecheck = () => {
    if (recheck !== null) clearInterval(recheck);
    recheck = null;
  };
  const startRecheck = () => {
    if (!isTauri() || recheck !== null) return;
    recheck = setInterval(() => {
      void appIsImporting().then((running) => {
        if (!running && importActivity.running) end();
      });
    }, RECHECK_MS);
  };
  const end = () => {
    stopRecheck();
    importFinished();
    if (tree.ready) void loadTree();
  };

  const unlisten = listen(TauriEventName.ImportProgress, (progress) => {
    if (progress.phase === 'finished') {
      end();
      return;
    }
    importProgressed(progress);
    startRecheck();
  });
  if (isTauri())
    void appIsImporting().then((running) => {
      if (!running || importActivity.running) return;
      importProgressed({ phase: 'scanning', done: 0, total: 0 });
      startRecheck();
    });

  return () => {
    stopRecheck();
    void unlisten.then((off) => off());
  };
}
