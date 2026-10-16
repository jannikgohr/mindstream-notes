#!/usr/bin/env bash
# Run in linux-vault-check.Dockerfile after copying the checked Linux binary to
# /source/.output/linux-vault-check/mindstream-notes. Results stay in /results.
set -euo pipefail
export XDG_RUNTIME_DIR=/tmp/mindstream-wayland-runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
cp /source/.output/linux-vault-check/mindstream-notes /tmp/mindstream-vault-wayland
chmod 700 /tmp/mindstream-vault-wayland
dbus-run-session -- xvfb-run -a -s "-screen 0 1920x1440x24" bash -c '
  set -euo pipefail
  openbox >/results/openbox.log 2>&1 &
  manager=$!
  weston --backend=x11-backend.so --use-pixman --width=1600 --height=1200 \
    --socket=wayland-fixture --idle-time=0 >/results/weston.log 2>&1 &
  compositor=$!
  trap "kill $compositor $manager; wait $compositor || true; wait $manager || true" EXIT
  export WAYLAND_DISPLAY=wayland-fixture GDK_BACKEND=wayland
  for attempt in $(seq 1 100); do
    test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" && break
    sleep 0.1
  done
  eval "$(printf "fixture-keyring\n" | gnome-keyring-daemon --unlock --components=secrets)"
  python3 /source/src-tauri/scripts/supervised-handoff-check.py \
    --check-focus --exe /tmp/mindstream-vault-wayland --output "/results/native-$(date +%Y%m%d-%H%M%S)"
  python3 /source/src-tauri/scripts/supervised-startup-check.py \
    --exe /tmp/mindstream-vault-wayland --output "/results/startup-$(date +%Y%m%d-%H%M%S)"
'
