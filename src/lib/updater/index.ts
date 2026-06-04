import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getPlatform } from '$lib/platform';
import { isAppImageInstall, isTauri } from '$lib/api';
import { alert, confirm } from '$lib/components/confirm-dialog.svelte';
import { tUi } from '$lib/settings/i18n.svelte';
import {
  beginDownload,
  endProgress,
  finishDownload,
  recordChunk
} from './progress.svelte';
import pkg from '../../../package.json';

type Update = NonNullable<Awaited<ReturnType<typeof check>>>;

export interface AvailableUpdate {
  update: Update;
  version: string;
  currentVersion: string;
}

interface CheckOptions {
  alertOnError?: boolean;
  alertOnCurrent?: boolean;
  alertOnUnsupported?: boolean;
}

export async function checkForAvailableUpdate(
  options: CheckOptions = {}
): Promise<AvailableUpdate | null> {
  if (!isTauri()) return null;

  if (getPlatform() === 'linux' && !(await isAppImageInstall())) {
    if (options.alertOnUnsupported) {
      await alert({
        title: tUi('updater.unsupportedLinux.title'),
        message: tUi('updater.unsupportedLinux.message'),
        confirmLabel: tUi('updater.dismiss')
      });
    }
    return null;
  }

  let update: Update | null;
  try {
    update = await check();
  } catch (err) {
    console.error('[updater] check failed', err);
    if (options.alertOnError) {
      await alert({
        title: tUi('updater.checkFailed.title'),
        message: tUi('updater.checkFailed.message'),
        confirmLabel: tUi('updater.dismiss')
      });
    }
    return null;
  }

  if (!update) {
    if (options.alertOnCurrent) {
      await alert({
        title: tUi('updater.upToDate.title'),
        message: tUi('updater.upToDate.message').replace(
          '{version}',
          pkg.version
        ),
        confirmLabel: tUi('updater.dismiss')
      });
    }
    return null;
  }

  console.info(
    `[updater] available: ${update.version} (current ${pkg.version})`
  );

  return {
    update,
    version: update.version,
    currentVersion: pkg.version
  };
}

export async function installAvailableUpdate(
  available: AvailableUpdate
): Promise<void> {
  const installNow = await confirm({
    title: tUi('updater.available.title'),
    message: tUi('updater.available.message')
      .replace('{from}', available.currentVersion)
      .replace('{to}', available.version),
    confirmLabel: tUi('updater.install'),
    cancelLabel: tUi('updater.later')
  });
  if (!installNow) return;

  try {
    await available.update.downloadAndInstall((event) => {
      switch (event.event) {
        case 'Started':
          beginDownload(event.data.contentLength ?? 0);
          console.info(
            `[updater] downloading ${event.data.contentLength ?? '?'} bytes`
          );
          break;
        case 'Progress':
          recordChunk(event.data.chunkLength);
          break;
        case 'Finished':
          finishDownload();
          console.info('[updater] download finished, installing');
          break;
      }
    });
  } catch (err) {
    console.error('[updater] install failed', err);
    await alert({
      title: tUi('updater.installFailed.title'),
      message: tUi('updater.installFailed.message'),
      confirmLabel: tUi('updater.dismiss')
    });
    return;
  } finally {
    endProgress();
  }

  const restartNow = await confirm({
    title: tUi('updater.ready.title'),
    message: tUi('updater.ready.message'),
    confirmLabel: tUi('updater.restart'),
    cancelLabel: tUi('updater.later')
  });
  if (restartNow) await relaunch();
}

export async function checkForUpdatesInteractively(): Promise<void> {
  const available = await checkForAvailableUpdate({
    alertOnCurrent: true,
    alertOnError: true,
    alertOnUnsupported: true
  });
  if (available) await installAvailableUpdate(available);
}
