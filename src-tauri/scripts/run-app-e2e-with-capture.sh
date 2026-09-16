#!/usr/bin/env bash
# Run inside xvfb-run so the recorder shares DISPLAY and XAUTHORITY.
# X11 screenshots do not require a responsive WebDriver or renderer.
set -u
capture_dir=".output/wdio/x11"
mkdir -p "$capture_dir"

capture_screen() {
  timeout 5s scrot --silent "$capture_dir/$(date -u +%Y%m%dT%H%M%S)-$1.png" \
    2>> "$capture_dir/capture.log" || true
}

record_screens() {
  while true; do
    capture_screen periodic
    sleep 10
  done
}

record_screens &
recorder_pid=$!
trap 'kill "$recorder_pid" 2>/dev/null || true; wait "$recorder_pid" 2>/dev/null || true' EXIT

"$@"
test_status=$?
capture_screen "exit-$test_status"
exit "$test_status"
