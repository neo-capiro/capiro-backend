#!/bin/sh
set -eu
# Fail startup rather than serve scans from an image's stale signature snapshot.
freshclam --foreground --stdout
# Official unprivileged entrypoint starts clamd plus periodic signature updates.
export CLAMAV_NO_MILTERD=true
export FRESHCLAM_CHECKS=4
exec /init-unprivileged
