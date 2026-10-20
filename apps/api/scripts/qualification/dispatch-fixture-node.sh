#!/bin/sh
# Diagnostic PATH shim: intercept only serve dispatch; helpers use the real Node.
if [ "$1" = "dist/main.js" ]; then
  echo QUALIFICATION_SERVE_DISPATCH
  exit 0
fi
exec /usr/local/bin/node "$@"
