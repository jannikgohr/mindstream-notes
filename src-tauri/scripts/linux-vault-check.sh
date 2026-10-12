#!/usr/bin/env bash
# Run inside linux-vault-check.Dockerfile with /source read-only and /results writable.
set -euo pipefail
tar -C /source --exclude='./node_modules' --exclude='./.git' --exclude='./.output' \
  --exclude='./src-tauri/target' --exclude='./src-tauri/gen' --exclude='./.svelte-kit' \
  --exclude='./.env*' --exclude='./src-tauri/scripts/__pycache__' -cf - . | tar -C /work -xf -
mkdir -p /work/.output
cp -a /source/.output/build /work/.output/build
cd /work/src-tauri
rustup component add rustfmt clippy
export CARGO_BUILD_JOBS=4
cargo fmt -- --check
cargo clippy -- -D warnings
cargo test -- --test-threads=1
TAURI_CONFIG='{"build":{"devUrl":null}}' cargo build --features tauri/custom-protocol
cd /work
dbus-run-session -- xvfb-run -a bash -c '
  set -euo pipefail
  export XDG_RUNTIME_DIR=/tmp/mindstream-vault-runtime
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR"
  openbox >/results/openbox.log 2>&1 &
  eval "$(printf "fixture-keyring\n" | gnome-keyring-daemon --unlock --components=secrets)"
  python3 src-tauri/scripts/supervised-handoff-check.py \
    --check-focus --exe /work/src-tauri/target/debug/mindstream-notes --output "/results/native-$(date +%Y%m%d-%H%M%S)"
'
