import { assertStringArray, invokeOrFallback, TauriCommandName } from './core';

export function migrateLegacyContent(
  kind: 'signatures' | 'favourites',
  arrayRaw: string | null,
  singleRaw: string | null = null
): Promise<string[]> {
  return invokeOrFallback(
    TauriCommandName.MigrateLegacyContent,
    { kind, arrayRaw, singleRaw },
    () => {
      throw new Error('legacy content receipts require native storage');
    },
    (value) => assertStringArray(value, 'changed favourite note IDs')
  );
}
