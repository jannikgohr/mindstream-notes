import { spawnSync } from 'node:child_process';

const targets = [
  'src/**/*.{js,ts,svelte,json,html,css,md}',
  'backend/**/*.{js,ts,mjs,cjs,json,md,html,css}',
  '*.{js,ts,mjs,cjs,json,md,html,css}'
];

const check = process.argv.includes('--check');
const mode = check ? '--check' : '--write';

const result = spawnSync('prettier', [mode, ...targets], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
