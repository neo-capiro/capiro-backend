#!/bin/sh
# Meri Hermes worker entrypoint (runs as the unprivileged `hermes` user under
# the upstream s6/main-wrapper chain, venv already activated).
#
# Renders HERMES_HOME from the Meri templates + environment, then starts the
# Hermes gateway with the API server enabled. Everything Meri controls about
# this worker is visible here; nothing secret is written to disk except what
# Hermes itself persists (state.db, sessions) inside the scope volume.
#
# Required env (values injected by Meri's provisioning, never baked):
#   API_SERVER_KEY            bearer key the Meri API uses to call this worker
#   MERI_BROKER_URL           Meri broker base, e.g. http://host:4450/api/internal/hermes/broker
#   MERI_WORKER_TOKEN         scope-bound worker credential (mhw1.…)
#   OPENAI_API_KEY | ANTHROPIC_API_KEY | OPENROUTER_API_KEY  (one provider key)
# Optional:
#   MERI_HERMES_MODEL         e.g. gpt-5.6-luna (default below)
#   MERI_HERMES_PROVIDER      openai | anthropic | openrouter | auto (default auto)
#   MERI_EXECUTION_SCOPE_ID   informational; echoed into SOUL/system notes
#   MERI_SOUL_B64             base64 SOUL.md rendered by Meri from the tenant persona
#   MERI_MAX_CONCURRENT_RUNS  default 4
set -eu

HOME_DIR="${HERMES_HOME:-/opt/data}"
mkdir -p "$HOME_DIR/plugins" "$HOME_DIR/skills" "$HOME_DIR/workspace" "$HOME_DIR/workspace/attachments" "$HOME_DIR/workspace/out"

# 1. Meri plugins: the image is the source of truth; the volume gets a fresh copy.
for plugin in meri_memory meri_tools; do
  rm -rf "$HOME_DIR/plugins/$plugin"
  cp -R "/opt/meri/plugins/$plugin" "$HOME_DIR/plugins/$plugin"
done

# 2. SOUL.md — the persona is Meri-owned and versioned, so it is rendered on
#    EVERY start: from MERI_SOUL_B64 (tenant persona rendered by Meri) or the
#    fixture template. Never keep whatever is on the volume: the upstream
#    first-boot hook (cont-init 01-hermes-setup) seeds Hermes' default
#    "You are Hermes Agent, built by Nous Research" SOUL.md before this script
#    runs, which the Phase 0 harness caught (check D3a).
if [ -n "${MERI_SOUL_B64:-}" ]; then
  printf '%s' "$MERI_SOUL_B64" | base64 -d > "$HOME_DIR/SOUL.md"
else
  cp /opt/meri/SOUL.template.md "$HOME_DIR/SOUL.md"
fi

# 3. config.yaml — rendered from the template every start (config is Meri-owned).
MERI_HERMES_MODEL="${MERI_HERMES_MODEL:-gpt-5.6-luna}" \
MERI_HERMES_PROVIDER="${MERI_HERMES_PROVIDER:-custom}" \
MERI_HERMES_BASE_URL="${MERI_HERMES_BASE_URL:-https://api.openai.com/v1}" \
MERI_MAX_CONCURRENT_RUNS="${MERI_MAX_CONCURRENT_RUNS:-4}" \
MERI_WORKSPACE_DIR="$HOME_DIR/workspace" \
MERI_SKILLS_DIR="$HOME_DIR/skills" \
python3 - "$HOME_DIR/config.yaml" <<'PY'
import os, re, sys
template = open("/opt/meri/config.template.yaml", encoding="utf-8").read()
rendered = re.sub(r"\$\{([A-Z0-9_]+)\}", lambda m: os.environ.get(m.group(1), ""), template)
open(sys.argv[1], "w", encoding="utf-8").write(rendered)
PY

# 4. Never persist secrets in .env; Hermes reads process env. Make sure a stale
#    .env from a previous run cannot shadow the injected values.
rm -f "$HOME_DIR/.env"

echo "[meri-hermes-worker] HERMES_HOME=$HOME_DIR scope=${MERI_EXECUTION_SCOPE_ID:-unset} model=${MERI_HERMES_MODEL:-gpt-5.6-luna} provider=${MERI_HERMES_PROVIDER:-auto}"
echo "[meri-hermes-worker] broker=${MERI_BROKER_URL:-unset} worker_token_present=$([ -n "${MERI_WORKER_TOKEN:-}" ] && echo yes || echo no)"
exec hermes gateway run
