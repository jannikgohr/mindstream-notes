import { spawnSync } from 'node:child_process';

const manifests = ['src-tauri/Cargo.toml', 'crates/ink-core/Cargo.toml'];

const check = process.argv.includes('--check');

for (const manifest of manifests) {
  const args = ['fmt', '--manifest-path', manifest];

  if (check) {
    args.push('--', '--check');
  }

  const result = spawnSync('cargo', args, { stdio: 'inherit' });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
