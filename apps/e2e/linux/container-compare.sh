#!/usr/bin/env bash
# In-container COMPARE (round-14, network=none): repeat proof against the
# IMMUTABLE golden baselines tree (mounted read-only at /work/apps/e2e/baselines).
# Explicit staging + raw status; a copy failure is never masked.
set -uo pipefail
mkdir -p /tmp/cache /out/reports

prov=-1 rep=-1 copy=-1
cd /work
if node apps/e2e/linux/verify-provenance.mjs; then prov=0; else prov=$?; fi
if [[ "$prov" -eq 0 ]]; then
  cd /work/apps/e2e
  if node scripts/repeat-zero-diff.mjs --repeat; then rep=0; else rep=$?; fi
else
  echo "[compare] provenance stage failed (rc=$prov) — repeat SKIPPED"
fi
copy=0
cp -a /work/apps/e2e/reports/. /out/reports/ 2>/out/copy-reports.err || copy=$?

cat > /out/stage-statuses.json <<JSON
{
  "schema": "capiro.cleanup1.visual-compare-stages.v1",
  "provenance": $prov,
  "repeat": $rep,
  "artifactCopy": $copy
}
JSON
echo "[compare] stages provenance=$prov repeat=$rep copy=$copy"

rc=0
for s in "$prov" "$rep" "$copy"; do [[ "$s" -eq 0 ]] || rc=1; done
exit "$rc"
