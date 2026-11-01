export function isTestVaultId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value);
}

/** One identifier scopes the database, ownership lock, and recovery data. */
export function vaultNamespace(testId?: string) {
  if (testId !== undefined && !isTestVaultId(testId))
    throw new Error('Invalid browser test vault identifier');
  return testId === undefined
    ? {
        directory: '.mindstream-browser-vault',
        lock: 'mindstream:sqlite-vault:pool',
        draft: 'mindstream:browser-vault:draft:v1:',
        archive: 'mindstream:browser-vault:recovery:v1:',
        reset: undefined
      }
    : {
        directory: `.mindstream-browser-test-${testId}`,
        lock: `mindstream:sqlite-test-${testId}:pool`,
        draft: `mindstream:browser-test:${testId}:draft:v1:`,
        archive: `mindstream:browser-test:${testId}:recovery:v1:`,
        reset: `mindstream:browser-test:${testId}:reset`
      };
}
