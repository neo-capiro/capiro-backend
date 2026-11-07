#!/bin/bash
set -Eeuo pipefail
test "$(id -u)" = 1000
test "$(id -g)" = 1000
children=()
cleanup() {
  trap - EXIT TERM INT
  if ((${#children[@]})); then
    kill -TERM "${children[@]}" 2>/dev/null || true
    # Bound shutdown even if a daemon does not respond to TERM.
    for ((attempt=0; attempt<50; attempt++)); do
      test -n "$(jobs -pr)" || break
      sleep 0.1
    done
    running="$(jobs -pr)"
    if test -n "$running"; then kill -KILL $running 2>/dev/null || true; fi
    for child in "${children[@]}"; do wait "$child" 2>/dev/null || true; done
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
# Supervise the initial refresh too; TERM while waiting cannot orphan it.
# Fail startup if official signatures cannot be refreshed. Do not serve a stale snapshot.
freshclam --config-file=/etc/clamav/freshclam.conf --foreground --stdout &
children+=("$!")
wait "${children[0]}"
children=()
freshclam --config-file=/etc/clamav/freshclam.conf --daemon --foreground --stdout --checks=4 &
children+=("$!")
clamd --config-file=/etc/clamav/clamd.conf --foreground &
children+=("$!")
# Either daemon exiting, including a clean exit, makes the scanner unavailable.
set +e
wait -n "${children[@]}"
status=$?
set -e
if ((status == 0)); then status=1; fi
exit "$status"
