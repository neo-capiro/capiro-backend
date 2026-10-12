#!/usr/bin/env bash
# In-container CAPTURE (round-18, network=none).
#
# Staging is EXPLICIT and each stage's raw exit status is preserved (round-13
# overwrote `rc` with the last failing stage and ran guard/repeat after a failed
# capture). Order + rules:
#   1. canonical provenance verify (mandatory first);
#   2. capture + atomic publish  — if it fails, guard and repeat are SKIPPED
#      (they would be meaningless without a published baseline);
#   3. coverage guard;
#   4. three same-source repeats;
#   5. onboard smoke — the SEPARATE apps/onboard-web renderer run in the SAME
#      native pipeline (own config, own dev server on :4192, offline signed-out
#      Clerk stub + /onboard-api config fixture — no real auth/network). Two
#      cases: /register renders the real purchaser registration form ("...and
#      fallback"): an unknown signed-out route redirects to /register. It does
#      NOT read or depend on the published baselines, so it runs even when route
#      capture failed (as long as provenance verified); its status is reported
#      SEPARATELY and NEVER erases the capture/guard/repeat evidence, and a
#      skip is never reported as a pass.
#   6. artifact copy — reported separately; a copy failure is never masked. The
#      onboard run writes its diagnostics to its OWN output dir
#      (apps/e2e/smoke-onboard/test-results) so it can never erase the
#      route-capture test-results; both are retained in /out (baselines+reports,
#      and onboard-test-results), each with its own raw status.
# The exact raw statuses are written to /out/stage-statuses.json.
set -uo pipefail
mkdir -p /tmp/cache /out/baselines /out/reports /out/route-test-results /out/onboard-test-results

prov=-1 cap=-1 guard=-1 repeat=-1 onboard=-1 onboard_log=-1 route_diag=-1 onboard_diag=-1 copy=-1
cd /work
if node apps/e2e/linux/verify-provenance.mjs; then prov=0; else prov=$?; fi

if [[ "$prov" -eq 0 ]]; then
  cd /work/apps/e2e
  if node scripts/capture-baselines.mjs --capture; then cap=0; else cap=$?; fi
  if [[ "$cap" -eq 0 ]]; then
    if node scripts/guard-route-coverage.mjs; then guard=0; else guard=$?; fi
    if node scripts/repeat-zero-diff.mjs --repeat; then repeat=0; else repeat=$?; fi
  else
    echo "[capture] capture stage failed (rc=$cap) — guard and repeat SKIPPED (no published baseline)"
  fi

  # Onboard smoke: a SEPARATE rendered frontend (apps/onboard-web) exercised in
  # the SAME native capture pipeline. Independent of the published baselines, so
  # it still runs when route capture failed — its registration-frontend and
  # fallback evidence is reported as its OWN stage below, never merged into (or
  # allowed to erase) the route-capture statuses.
  cd /work/apps/e2e
  # Tee so the evidence lands BOTH in the container stdout/stderr stream (root's
  # native logs) and in a retained /out file. Preserve BOTH raw pipeline statuses.
  node scripts/run-playwright.mjs test --config smoke-onboard/playwright.onboard.config.ts 2>&1 | tee /out/onboard-smoke.log
  onboard_pipeline=("${PIPESTATUS[@]}")
  onboard="${onboard_pipeline[0]}"
  onboard_log="${onboard_pipeline[1]}"
  echo "[onboard] smoke stage rc=$onboard log-copy=$onboard_log (log /out/onboard-smoke.log)"
else
  echo "[capture] provenance stage failed (rc=$prov) — all capture stages SKIPPED"
  echo "[onboard] provenance stage failed (rc=$prov) — onboard smoke SKIPPED (not run; not a pass)"
fi

# Artifact copy: explicit; a failure is surfaced (never a silent "copied" claim).
copy=0
cp -a /work/apps/e2e/baselines/. /out/baselines/ 2>/out/copy-baselines.err || copy=$?
cp -a /work/apps/e2e/reports/. /out/reports/ 2>/out/copy-reports.err || copy=$?

if [[ -d /work/apps/e2e/test-results ]]; then
  route_diag=0
  cp -a /work/apps/e2e/test-results/. /out/route-test-results/ 2>/out/copy-routes.err || route_diag=$?
fi

# Onboard diagnostics: retained SEPARATELY from the route-capture diagnostics
# (the onboard run writes its own output dir, so neither can erase the other).
# A missing dir is -1 (not-run) — never masked as a pass; a copy failure is
# reported as its own raw status.
if [[ -d /work/apps/e2e/smoke-onboard/test-results ]]; then
  onboard_diag=0
  cp -a /work/apps/e2e/smoke-onboard/test-results/. /out/onboard-test-results/ 2>/out/copy-onboard.err || onboard_diag=$?
else
  onboard_diag=-1
fi

manifest_present=0
[[ -f /out/baselines/manifest.json ]] && manifest_present=1

cat > /out/stage-statuses.json <<JSON
{
  "schema": "capiro.cleanup1.visual-capture-stages.v1",
  "provenance": $prov,
  "capture": $cap,
  "guard": $guard,
  "repeat": $repeat,
  "onboard": $onboard,
  "onboardLogCopy": $onboard_log,
  "routeTestResultsCopy": $route_diag,
  "onboardTestResultsCopy": $onboard_diag,
  "artifactCopy": $copy,
  "baselineManifestPresent": $manifest_present,
  "note": "raw exit statuses; -1 = skipped/not-run; capture!=0 => guard/repeat skipped (no published baseline); onboard is a separate frontend stage that runs whenever provenance verified and never erases capture evidence; onboardTestResultsCopy is the onboard diagnostics copy (separate dir from the route-capture test-results); artifactCopy!=0 => copy error"
}
JSON

echo "[capture] stages provenance=$prov capture=$cap guard=$guard repeat=$repeat onboard=$onboard copy=$copy manifestPresent=$manifest_present"

rc=0
for s in "$prov" "$cap" "$guard" "$repeat" "$onboard" "$onboard_log" "$route_diag" "$onboard_diag" "$copy"; do [[ "$s" -eq 0 ]] || rc=1; done
exit "$rc"
