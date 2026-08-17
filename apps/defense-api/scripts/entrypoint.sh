#!/usr/bin/env bash
set -euo pipefail

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
  migrate|promote|activate|parse|benchmark)
    echo "REFUSED: defense-api HTTP image does not own '$mode' authority" >&2
    exit 64
    ;;
  *)
    echo "Unknown defense-api entrypoint mode: $mode" >&2
    exit 64
    ;;
esac
