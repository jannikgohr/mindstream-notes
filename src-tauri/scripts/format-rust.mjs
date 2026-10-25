import { spawnSync } from 'node:child_process';

const manifests = ['src-tauri/Cargo.toml', 'plugin-sdk/bundled/Cargo.toml'];

const check = process.argv.includes('--check');

for (const manifest of manifests) {
  // `--all` takes in the crates this one depends on by path, which is the
  // client library in vendor/. CI runs `cargo fmt --all --check`, so without
  // it a change there passes every hook here and fails there.
  const args = ['fmt', '--all', '--manifest-path', manifest];

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
