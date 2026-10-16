import {
  assertNumberArray,
  assertRecord,
  assertString,
  invokeOrFallback,
  TauriCommandName
} from './core';

export interface WorkerBrowserOptions {
  dataDirectory?: string;
  dataStoreIdentifier?: number[];
  additionalBrowserArgs?: string;
}

export function getWorkerBrowserOptions(): Promise<WorkerBrowserOptions> {
  return invokeOrFallback(
    TauriCommandName.GetWorkerBrowserOptions,
    undefined,
    () => ({}),
    (value) => {
      if (value === null) return {};
      const record = assertRecord(value, 'worker browser identity');
      const options: WorkerBrowserOptions = {};
      if (record.additionalBrowserArgs != null) {
        options.additionalBrowserArgs = assertString(
          record.additionalBrowserArgs,
          'browser arguments'
        );
      }
      if (record.dataDirectory !== null && record.dataDirectory !== undefined) {
        return {
          ...options,
          dataDirectory: assertString(
            record.dataDirectory,
            'browser data directory'
          )
        };
      }
      if (
        record.dataStoreIdentifier === null &&
        'additionalBrowserArgs' in record
      )
        return options;
      const id = assertNumberArray(
        record.dataStoreIdentifier,
        'browser store identifier'
      );
      if (
        id.length !== 16 ||
        id.some((v) => !Number.isInteger(v) || v < 0 || v > 255)
      )
        throw new Error('invalid persistent browser store identifier');
      return { ...options, dataStoreIdentifier: id };
    }
  );
}
