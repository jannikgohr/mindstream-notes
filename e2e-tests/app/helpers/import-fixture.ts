import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const IMPORT_DESTINATION = 'Imported E2E Vault';
export const IMPORT_HOME = 'Imported Home';
export const IMPORT_PLAN = 'Project Plan';
export const IMPORT_PLACEHOLDER = 'Missing Note';
export const IMPORT_BODY_CANARY = 'This body crossed the real importer.';
export const IMPORT_TAG = 'e2e-import';

export const IMPORT_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

/** Build an Obsidian vault that exercises folders, links, tags and dedup. */
export function createImportVaultFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'mindstream-e2e-import-'));
  mkdirSync(join(root, '.obsidian'));
  mkdirSync(join(root, 'Projects'));

  writeFileSync(
    join(root, 'Home.md'),
    [
      '---',
      `title: ${IMPORT_HOME}`,
      `tags: [${IMPORT_TAG}]`,
      '---',
      `# ${IMPORT_HOME}`,
      '',
      IMPORT_BODY_CANARY,
      '',
      'Open [[Projects/Plan|the plan]] and [[Missing Note]].',
      '',
      '![[pixel.png]]',
      ''
    ].join('\n')
  );
  writeFileSync(
    join(root, 'Projects', 'Plan.md'),
    [
      '---',
      `title: ${IMPORT_PLAN}`,
      '---',
      `# ${IMPORT_PLAN}`,
      '',
      'Return to [[Home]].',
      '',
      '![same pixel](../pixel.png)',
      ''
    ].join('\n')
  );
  writeFileSync(join(root, 'pixel.png'), IMPORT_PNG_BYTES);
  return root;
}
