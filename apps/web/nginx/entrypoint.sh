#!/bin/sh
# Generate /usr/share/nginx/html/runtime-config.js from container env vars.
#
# The browser fetches this file at SPA boot. The Vite build does not bake the
# Clerk publishable key or API base URL into the bundle; both come from here,
# so the same image promotes from dev → staging → prod unchanged.
#
# Required env vars (injected by ECS from Secrets Manager + task definition):
#   CLERK_PUBLISHABLE_KEY  pk_live_...  or  pk_test_...
#   API_BASE_URL           https://app.capiro.ai
#   APP_ENV                dev | staging | prod (informational)
#
# Optional release identity (used by isolated/canary web services):
#   WEB_SURFACE            canonical | vnext | ...
#   CAPIRO_WEB_RELEASE_SHA exact git SHA for the running web image

set -e

OUT=/usr/share/nginx/html/runtime-config.js

if [ -z "$CLERK_PUBLISHABLE_KEY" ] || [ -z "$API_BASE_URL" ]; then
  echo "Missing CLERK_PUBLISHABLE_KEY or API_BASE_URL in environment" >&2
  exit 1
fi

# Escape backslashes and single quotes in the values before embedding into JS.
escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g"
}

CLERK_KEY=$(escape "$CLERK_PUBLISHABLE_KEY")
API_URL=$(escape "$API_BASE_URL")
ENV_NAME=$(escape "${APP_ENV:-unknown}")
# OPTIONAL — deliberately NOT added to the required-var hard-fail above. A task
# definition predating these vars must still boot; the web app falls back to its
# built-in OpenFreeMap Positron default when they arrive empty.
MAP_STYLE=$(escape "${MAP_STYLE_URL:-}")
MAP_ATTRIBUTION=$(escape "${MAP_STYLE_ATTRIBUTION:-}")
WEB_SURFACE_VALUE=$(escape "${WEB_SURFACE:-}")
WEB_RELEASE_SHA=$(escape "${CAPIRO_WEB_RELEASE_SHA:-}")

cat > "$OUT" <<EOF
// Generated at container start by apps/web/nginx/entrypoint.sh.
// Do not edit, replaced on every deploy.
window.__CAPIRO_CONFIG__ = Object.freeze({
  clerkPublishableKey: '${CLERK_KEY}',
  apiBaseUrl: '${API_URL}',
  appEnv: '${ENV_NAME}',
  mapStyleUrl: '${MAP_STYLE}',
  mapStyleAttribution: '${MAP_ATTRIBUTION}',
  webSurface: '${WEB_SURFACE_VALUE}',
  releaseSha: '${WEB_RELEASE_SHA}',
});
EOF

chmod 0644 "$OUT"
echo "Wrote runtime config for env=${APP_ENV:-unknown} surface=${WEB_SURFACE:-unspecified}"
