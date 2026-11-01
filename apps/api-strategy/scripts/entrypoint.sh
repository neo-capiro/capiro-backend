#!/bin/sh
# Capiro Strategy API (api-strategy) container entrypoint.
#
# Modes, selected by argv:
#   serve                     (default) start the NestJS HTTP server.
#   migrate                   compose DATABASE_URL from DB_* secrets, run
#                             prisma migrate deploy (forward-only), then seed
#                             the global reference baseline (insert-if-empty),
#                             then exit. The CDK migrate task definition
#                             overrides the container command to "migrate".
#   seed                      seed the global reference baseline only.
#   update-strategy-reference replace the global reference baseline from
#                             STRATEGY_REFERENCE_FILE / STRATEGY_REFERENCE_JSON
#                             (the Capiro-maintained ops verb, FND-8).
#
# DATABASE_URL is composed from the individual DB_* secrets injected by ECS from
# the Aurora credential. sslmode=require because Aurora's parameter group has
# rds.force_ssl=1. (Mirrors apps/workspace + apps/api.)

set -e

# Optional explicit pool ceiling: canonical decimal 1..2147483647. Unset keeps
# the existing URL/default-pool behavior. Read secrets from env, never argv.
# Keep this block identical in api-strategy and intel-api entrypoints.
if [ "${DB_CONNECTION_LIMIT+x}" = x ]; then
  DATABASE_URL=$(node <<'NODE'
try {
  const env = process.env;
  const limit = env.DB_CONNECTION_LIMIT;
  if (!/^[1-9][0-9]{0,9}$/.test(limit) || Number(limit) > 2147483647) throw new Error();
  let raw = env.DATABASE_URL;
  if (!raw) {
    if (!['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].every(key => env[key])) throw new Error();
    if (!/^[1-9][0-9]{0,4}$/.test(env.DB_PORT) || Number(env.DB_PORT) > 65535) throw new Error();
    if (/[\s/?#@\\%]/.test(env.DB_HOST)) throw new Error();
    const host = env.DB_HOST.includes(':') && !env.DB_HOST.startsWith('[')
      ? '[' + env.DB_HOST + ']' : env.DB_HOST;
    raw = 'postgresql://' + encodeURIComponent(env.DB_USER) + ':' +
      encodeURIComponent(env.DB_PASSWORD) + '@' + host + ':' + env.DB_PORT + '/' +
      encodeURIComponent(env.DB_NAME) + '?schema=public&sslmode=require';
  }
  if (/[\x00-\x20\x7f\\#]/.test(raw) || /%(?![a-f0-9]{2})/i.test(raw)) throw new Error();
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
      !url.pathname || url.pathname === '/') throw new Error();
  const existing = url.searchParams.getAll('connection_limit');
  if (existing.length > 1 || (existing.length === 1 && existing[0] !== limit)) throw new Error();
  // Validate with URL, but do not reserialize credentials, TLS or other params.
  if (existing.length === 0) {
    const separator = !raw.includes('?') ? '?' : /[?&]$/.test(raw) ? '' : '&';
    raw += separator + 'connection_limit=' + limit;
  }
  process.stdout.write(raw);
} catch {
  console.error('Invalid database pool configuration (DB_CONNECTION_LIMIT/DATABASE_URL/DB_*).');
  process.exitCode = 1;
}
NODE
  )
  export DATABASE_URL
fi

# Compose DATABASE_URL from DB_* secrets when not already provided.
if [ -z "$DATABASE_URL" ]; then
  if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
    echo "Missing required DB_* env vars" >&2
    exit 1
  fi
  # URL-encode the password using node (always present in this image).
  ENCODED_PASSWORD=$(node -e 'process.stdout.write(encodeURIComponent(process.env.DB_PASSWORD))')
  export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public&sslmode=require"
fi

# tsx writes its compile cache under TMPDIR; default to tmpfs if unset.
: "${TMPDIR:=/dev/shm}"
export TMPDIR

# The same public CA validation runs before the application Node process.
if [ -n "${MERI_CONTROL_ORIGIN+x}${MERI_CONTROL_CA_BASE64+x}${MERI_CONTROL_CA_SHA256+x}" ]; then
  NODE_EXTRA_CA_CERTS=$(node /app/apps/api/scripts/lib/meri-control-ca.cjs)
  export NODE_EXTRA_CA_CERTS
fi

case "${1:-serve}" in
  migrate)
    echo "Running prisma migrate deploy (api-strategy engine)"
    # Stop on failed migrations. Ledger recovery requires a reviewed procedure.
    node node_modules/prisma/build/index.js migrate deploy
    # Seed the global reference baseline (insert-if-empty; never clobbers
    # ops-verb edits) after migrating.
    echo "Seeding global reference baseline"
    exec node dist/seed.js --run
    ;;
  seed)
    echo "Seeding global reference baseline (api-strategy engine)"
    exec node dist/seed.js --run
    ;;
  update-strategy-reference)
    echo "Replacing global reference baseline from ops payload"
    exec node dist/reference-ops.js
    ;;
  serve)
    echo "Starting Capiro Strategy API"
    exec node dist/main.js
    ;;
  *)
    echo "Unknown command: $1 (expected: serve | migrate | seed | update-strategy-reference)" >&2
    exit 1
    ;;
esac
