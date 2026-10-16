import {
  assertBoolean,
  assertNumber,
  assertRecord,
  assertString,
  assertVoid,
  invokeOrFallback,
  TauriCommandName
} from './core';

export interface CoordinatedUpdate {
  id: string;
  version: string;
  currentVersion: string;
}

export interface UpdateCheckReply {
  supervised: boolean;
  available: CoordinatedUpdate | null;
}

export function checkCoordinatedUpdate(
  force: boolean
): Promise<UpdateCheckReply> {
  return invokeOrFallback(
    TauriCommandName.CheckCoordinatedUpdate,
    { force },
    () => ({ supervised: false, available: null }),
    (value) => {
      const reply = assertRecord(value, 'coordinated update check');
      const available =
        reply.available === null
          ? null
          : assertRecord(reply.available, 'available update');
      return {
        supervised: assertBoolean(reply.supervised, 'update owner'),
        available: available && {
          id: assertString(available.id, 'update id'),
          version: assertString(available.version, 'update version'),
          currentVersion: assertString(
            available.currentVersion,
            'current version'
          )
        }
      };
    }
  );
}

export function installCoordinatedUpdate(id: string): Promise<void> {
  return invokeOrFallback(
    TauriCommandName.InstallCoordinatedUpdate,
    { id },
    () => undefined,
    (value) => assertVoid(value, 'coordinated update install')
  );
}

export function parseUpdateProgress(value: unknown): {
  downloaded: number;
  total: number | null;
  finished: boolean;
} {
  const reply = assertRecord(value, 'update progress');
  const downloaded = assertNumber(reply.downloaded, 'downloaded bytes');
  const total =
    reply.total === null ? null : assertNumber(reply.total, 'total bytes');
  if (downloaded < 0 || (total !== null && total < 0))
    throw new Error('update byte counts must be nonnegative');
  return {
    downloaded,
    total,
    finished: assertBoolean(reply.finished, 'download finished')
  };
}
