#!/usr/bin/env bash
set -euo pipefail

# defense-api container entrypoint.
#
# Two trust contexts share one image:
#
#   serve            long-running HTTP surface (Phase 8 dark; no ALB in Phase 9)
#   <job mode>       governed one-shot job runtime (Phase 9)
#
# The job modes are a CLOSED allowlist dispatched into `scripts/job.mjs`. There is
# deliberately NO passthrough that executes an arbitrary command, so a
# task-definition command override cannot turn this image into a general-purpose
# shell inside the VPC. Adding a mode is a code change and a code review.

mode="${1:-serve}"
shift || true

case "$mode" in
  serve)
    exec node dist/main.js "$@"
    ;;
  validate-config)
    exec node dist/config/validate-cli.js "$@"
    ;;
  readiness-probe)
    exec node -e '
      const http = require("node:http");
      const port = Number(process.env.PORT || 4400);
      const request = http.get({ host: "127.0.0.1", port, path: "/readyz", timeout: 3000 }, (res) => {
        res.resume();
        process.exit(res.statusCode === 200 ? 0 : 1);
      });
      request.on("timeout", () => request.destroy(new Error("timeout")));
      request.on("error", () => process.exit(1));
    '
    ;;

  # ---- Phase 9 governed one-shot job runtime -----------------------------
  # Read-only modes: inventory, backfill-plan, db-check, egress-check.
  # Mutating modes:  backfill-run, lifecycle-watch, schedule-tick — each fails
  # closed without BOTH --commit and its own authorisation env var.
  inventory|backfill-plan|backfill-run|lifecycle-watch|schedule-tick|db-check|egress-check)
    exec node scripts/job.mjs "$mode" "$@"
    ;;

  # ---- Reporting-only Session 8 crawl probe ------------------------------
  # Persists nothing under any environment; refuses commit mode outright.
  live-discovery-report)
    exec node scripts/run-live-discovery.mjs "$@"
    ;;

  migrate|promote|activate|parse|benchmark)
    echo "REFUSED: defense-api image does not own '$mode' authority" >&2
    exit 64
    ;;
  *)
    echo "Unknown defense-api entrypoint mode: $mode" >&2
    echo "Supported: serve validate-config readiness-probe inventory backfill-plan" >&2
    echo "           backfill-run lifecycle-watch schedule-tick db-check egress-check" >&2
    echo "           live-discovery-report" >&2
    exit 64
    ;;
esac
