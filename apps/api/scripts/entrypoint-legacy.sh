#!/bin/sh
# Compatibility dispatcher for ordinary API one-off verbs.
#
# `migrate` is deliberately blocked here. Migration deployment is owned only by
# /usr/local/bin/entrypoint.sh, whose fail-closed branch never edits Prisma's
# migration ledger. The large historical case statement is retained as a
# non-command include so existing operational verbs do not drift in Phase A.
set -e

if [ "${1:-serve}" = "migrate" ]; then
  echo "Refusing legacy migrate dispatch: use /usr/local/bin/entrypoint.sh migrate; automatic migration-history mutation is disabled." >&2
  exit 64
fi

exec /bin/sh /app/apps/api/scripts/entrypoint-dispatcher.inc "$@"
