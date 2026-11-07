#!/bin/bash
set -euo pipefail
exec /usr/bin/timeout --signal=KILL 3s /bin/bash -euo pipefail -c '
  exec 3<>/dev/tcp/127.0.0.1/3310
  printf "nPING\n" >&3
  IFS= read -r reply <&3
  test "$reply" = PONG
'
