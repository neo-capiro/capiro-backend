#!/usr/bin/env bash
# Phase 8 Session 4 — containment gate against the BUILT IMAGE.
#
# The static verifier checks source. This checks the artifact that would actually
# be deployed, which is where a Dockerfile mistake shows up and source review does
# not. Run after `docker build`.
#
# Usage: bash scripts/verify-phase8-session4-image.sh [image-tag]
set -euo pipefail

IMAGE="${1:-capiro-defense-api:phase8-session4}"
PASS_COUNT=0
fail() { echo "[p8s4-image] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s4-image]   ok  $*"; }

in_image() { docker run --rm --entrypoint sh "$IMAGE" -c "$1" 2>/dev/null | tr -d '\r'; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "image $IMAGE is not present; build it first"

# 1. Non-root.
UID_OUT="$(docker run --rm --entrypoint id "$IMAGE" -u 2>/dev/null | tr -d '\r')"
[ "$UID_OUT" = "1001" ] || fail "image runs as uid '$UID_OUT', expected 1001"
ok "image runs non-root (uid 1001)"

# 2. The trusted-source mirror must never ship. It exists only so the replay gate
#    can byte-compare the retained and moved trees on a developer machine.
[ "$(in_image 'ls /app/apps/defense-api/runtime-source 2>/dev/null | wc -l')" = "0" ] \
  || fail "the trusted-source mirror (runtime-source) is present in the image"
ok "trusted-source mirror is absent from the image"

# 3. No canonical promotion EXECUTION source, and no activation path.
#    NOTE: program-elements/promotion/manual-override-* IS expected. That is the
#    governed correction overlay in the frozen 49-route contract (propose/approve a
#    manual override under two-person control) -- not canonical promotion.
[ "$(in_image 'find /app -path "*defense-budget/promotion*" 2>/dev/null | wc -l')" = "0" ] \
  || fail "canonical promotion source (defense-budget/promotion) is present in the image"
ok "no canonical promotion source in the image"

[ "$(in_image 'grep -rlEi "promoteSnapshot|activateSnapshot|promoteCanonical" /app/apps/defense-api/dist 2>/dev/null | wc -l')" = "0" ] \
  || fail "a snapshot-activation / canonical-promotion symbol is reachable in the image"
ok "no snapshot-activation or canonical-promotion symbol in the image"

[ "$(in_image 'grep -rlEi "(INSERT INTO|UPDATE) +\"?defense_budget_active_snapshot" /app/apps/defense-api/dist 2>/dev/null | wc -l')" = "0" ] \
  || fail "the image contains a write to defense_budget_active_snapshot"
ok "no write to the active-snapshot pointer in the image"

# 4. No parser / GPU / promoter credential. Exactly two files may match, and both
#    match because they FORBID the thing:
#      health.service            - pg_has_role(...,'capiro_pe_promoter','member'),
#                                  a readiness assertion that serve is NOT a member
#      defense-config.validation - FORBIDDEN_SERVE_ENV_PATTERNS, which refuses
#                                  DEFENSE_PROMOTER_/NVIDIA_/SAGEMAKER_MODEL_ADMIN_/
#                                  DEFENSE_PARSER_MODEL_ at boot
#    Any THIRD file matching is a real finding.
CRED_FILES="$(in_image 'grep -rlE "DEFENSE_PROMOTER_|GPU_[A-Z_]*CREDENTIAL|PARSER_[A-Z_]*KEY|capiro_pe_promoter" /app/apps/defense-api/dist 2>/dev/null | sort')"
EXPECTED_CRED="/app/apps/defense-api/dist/config/defense-config.validation.js
/app/apps/defense-api/dist/health/health.service.js"
[ "$CRED_FILES" = "$EXPECTED_CRED" ] \
  || fail "credential-pattern matches changed. expected only the two guard files, got:
$CRED_FILES"
ok "credential patterns appear only in the two files that forbid them"

# 5. NVIDIA/CUDA may appear only in the boot-time env refusal and the runtime
#    manifest's forbiddenInHttpTask declaration.
NV_FILES="$(in_image 'grep -rliE "nvidia|cuda" /app/apps/defense-api/dist 2>/dev/null | sort')"
EXPECTED_NV="/app/apps/defense-api/dist/config/defense-config.validation.js
/app/apps/defense-api/dist/runtime/phase1-7-runtime.manifest.d.ts
/app/apps/defense-api/dist/runtime/phase1-7-runtime.manifest.js"
[ "$NV_FILES" = "$EXPECTED_NV" ] \
  || fail "NVIDIA/CUDA matches changed. expected only the env refusal and the forbidden-capability manifest, got:
$NV_FILES"
ok "NVIDIA/CUDA appears only where it is declared forbidden"

# 6. Fail-closed startup: no configuration means refuse to serve, not serve wrongly.
set +e
OUTPUT="$(docker run --rm "$IMAGE" 2>&1)"
CODE=$?
set -e
[ "$CODE" -ne 0 ] || fail "image started successfully with no configuration; it must fail closed"
printf '%s\n' "$OUTPUT" | grep -q "DATABASE_URL is required" \
  || fail "startup did not refuse a missing DATABASE_URL"
printf '%s\n' "$OUTPUT" | grep -q "CLERK_SECRET_KEY is required" \
  || fail "startup did not refuse a missing CLERK_SECRET_KEY"
ok "fail-closed startup (exit $CODE; both required-variable refusals present)"

echo "[p8s4-image] SESSION4_IMAGE_CONTAINMENT_PASS ($PASS_COUNT checks)"
