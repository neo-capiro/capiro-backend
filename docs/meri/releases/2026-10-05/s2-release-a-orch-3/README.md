# Stage 1 s2-release-a-orch-3 (2026-10-05)

Source: main `14b7deb1c74301a1907d1bb7841432a71652e679`.

Stage 2 Release A follow-up 3, orchestrator only: research provider settlements send the full API contract (logicalOperationId, retryOfAttemptId), so Deep Research settlements are no longer refused with HTTP 400 (#2044).

| Service | Image digest | Build |
| --- | --- | --- |
| meriv2-orchestrator | `sha256:aa82bcf35786…` | `694dc327-e879-4134-8040-83bffa0f6873` |

Served baseline before the roll: `served-baseline.json`. Builds: `scripts/meri-image-build.mjs`.
