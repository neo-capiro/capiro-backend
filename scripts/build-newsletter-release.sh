#!/bin/sh
# Local assembly only. Never builds/runs images, applications, providers or publishes.
set -eu
usage='Usage: build-newsletter-release.sh --node-bin /absolute/node --plan|--run [all explicit source, target, manifest and input/output flags]'
if [ "$#" -eq 1 ] && [ "$1" = --help ]; then printf '%s\n' "$usage"; exit 0; fi
if [ "$#" -lt 3 ] || [ "$1" != --node-bin ]; then printf '%s\n' "$usage" >&2; exit 2; fi
node_bin=$2
case "$node_bin" in /*/node) ;; *) printf '%s\n' 'An explicit absolute Node executable is required' >&2; exit 2 ;; esac
case "$node_bin" in *'..'*|*'\'*|*'
'*) printf '%s\n' 'Nonliteral Node executable path refused' >&2; exit 2 ;; esac
if [ ! -f "$node_bin" ] || [ ! -x "$node_bin" ] || [ -L "$node_bin" ]; then printf '%s\n' 'Regular explicit Node executable required' >&2; exit 2; fi
shift 2
owner=${0%/*}/lib/newsletter-artifact-packaging-plan.mjs
# No inherited NODE_OPTIONS/loaders/proxy/cloud/model credentials reach Node.
exec /usr/bin/env -i PATH=/usr/bin:/bin "$node_bin" --no-addons "$owner" "$@"
