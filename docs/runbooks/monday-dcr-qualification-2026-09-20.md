# monday.com DCR qualification — September 20, 2026

## Result

The DCR implementation is deployed for the Neo/Capiro internal qualification
identity. Customer rollout is not complete. Interactive monday authorization and
an authenticated board/item read have not yet passed; public integration approval
remains unconfirmed.

## Evidence

| Check | Result |
| --- | --- |
| Live protected-resource and authorization-server discovery | PASS |
| Dynamic client registration, without a manually configured client ID/secret | PASS — HTTP 201 |
| SDK-generated authorization URL, deployed callback, PKCE S256, resource and signed state | PASS |
| Focused API/OAuth/managed-connector tests | PASS — 58 tests |
| Read-only, tenant boundary and tool pagination regression tests | PASS — 12 tests |
| Orchestrator managed-connector routing tests | PASS — 16 tests |
| API production build and complete API typecheck command | PASS |
| Formatting of changed TypeScript files | PASS |
| ARM64 release image, file hashes and module loading | PASS — 12 files, 4 modules |
| Live API deployment | PASS — task 398, 2 running, rollout complete |
| Meri composer shows monday Connect for the internal identity | PASS |
| Draft retained while starting authorization | PASS |
| Personal sign-in and authenticated discovery | PENDING — separate popup is not exposed to the browser automation tool |
| Read board 18431248553 and its items through Meri | NOT RUN — requires personal authorization |
| Live cancellation, closed/blocked popup, token refresh, revoked access, reconnect and disconnect | NOT COMPLETE — automated regression coverage is not a substitute for these live checks |
| Connection persistence across refresh/reopen and another signed-in identity | NOT COMPLETE |
| Public integration review | UNCONFIRMED — application submission was previously verified |

GitHub's connector workflow did not execute because account payments or spending
limits blocked the runner. Local verification above passed; GitHub CI is not
reported as passing. No frontend source changed in this patch.

## Deployment and rollback

- API service: `capiro-dev-api` in cluster `capiro-dev`, region `us-east-1`.
- Runtime source: `1cf242dc4205767d9dcc172601cc790e88d3cc34`.
- Exact prior source: `56d97272986fc6546776dc75eaac88a682209198`.
- Release image digest: `sha256:4202b34f6bf04aaf1c81db9d1be058ec25f4bceef0c4f8b512ca58684c238b2b`.
- Rollback task: `capiro-dev-api:397`.
- Prior image digest: `sha256:cc7dc8a143a329958b87fbe673cc72325de4ec4f98d444ace1458ee9ddf76274`.

The release overlays only the four changed runtime modules on the exact previous
image, preserving the deployed Hermes implementation. The task definition retains
all other deployed environment values, secret references, roles and permissions.
Only the release SHA and monday enablement/internal user/tenant lists changed.
No database migration or manually deployed monday credentials were needed.

Follow [the DCR runbook](./monday-dcr.md) before expanding availability.
