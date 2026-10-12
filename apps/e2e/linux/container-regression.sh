#!/usr/bin/env bash
# In-container REGRESSION (round-13, network=none).
#
# The regression mode reuses the portable runner's VALIDATED immutable archive,
# trusted byte-bound bootstrap harness, exact-id/label lifecycle, owned named
# dependency volume and network-none rendering. It mounts the golden baselines
# tree READ-ONLY at /work/apps/e2e/baselines and runs the REAL, COMPLETE
# Playwright comparison suite plus the SEPARATE onboarding smoke. It never
# captures, updates or promotes golden bytes.
#
# Stages are explicit and each raw exit status is preserved. A failed provenance
# stage SKIPS regression (it is not a pass); a red regression stage is surfaced.
set -uo pipefail
mkdir -p /tmp/cache /out/reports

prov=-1 reg=-1 copy=-1
cd /work
if node apps/e2e/linux/verify-provenance.mjs; then prov=0; else prov=$?; fi
if [[ "$prov" -eq 0 ]]; then
  cd /work/apps/e2e
  if CAPIRO_REGRESSION_OUT=/out/regression-evidence.json node scripts/regression.mjs; then reg=0; else reg=$?; fi
else
  echo "[regression] provenance stage failed (rc=$prov) — regression SKIPPED (not run; not a pass)"
fi

copy=0
if [[ -d /work/apps/e2e/reports ]]; then
  cp -a /work/apps/e2e/reports/. /out/reports/ 2>/out/copy-reports.err || copy=$?
elif [[ -e /work/apps/e2e/reports ]]; then
  echo '[regression] repository reports path is not a directory' > /out/copy-reports.err
  copy=1
else
  # regression.mjs writes its required list, run, and evidence JSON to /out.
  echo '[regression] no optional repository reports directory; required JSON is in /out'
fi

cat > /out/regression-stages.json <<JSON
{
  "schema": "capiro.cleanup1.visual-regression-stages.v1",
  "provenance": $prov,
  "regression": $reg,
  "artifactCopy": $copy,
  "note": "raw exit statuses; -1 = skipped/not-run; regression!=0 => the pinned visual comparison failed (never a green)"
}
JSON
echo "[regression] stages provenance=$prov regression=$reg copy=$copy"

rc=0
for s in "$prov" "$reg" "$copy"; do [[ "$s" -eq 0 ]] || rc=1; done
exit "$rc"
