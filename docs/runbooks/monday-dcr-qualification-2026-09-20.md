# monday.com DCR qualification — September 20, 2026

## Result

The DCR implementation is deployed for the Neo/Capiro internal qualification
identity. Personal authorization, authenticated discovery, and a live Meri read
of a task and both subitems passed. Customer rollout is not complete; public
integration approval and the remaining live lifecycle checks are still pending.

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
| Live API deployment | PASS — task 399, 2 running, rollout complete |
| Meri composer shows monday Connect for the internal identity | PASS |
| Draft retained while starting authorization | PASS |
| Personal sign-in and authenticated discovery | PASS — monday shows Connected; subsequent authenticated read succeeded |
| Read board 18431248553 and its items through Meri | PASS — exact test task, both subitems and source links returned |
| Live cancellation, closed/blocked popup, token refresh, revoked access, reconnect and disconnect | NOT COMPLETE — automated regression coverage is not a substitute for these live checks |
| Connection and answer persistence across page refresh | PASS — monday still Connected and the completed answer persisted |
| Undock/reopen and another signed-in identity | NOT COMPLETE |
| Public integration review | UNCONFIRMED — application submission was previously verified |

GitHub's connector workflow did not execute because account payments or spending
limits blocked the runner. Local verification above passed; GitHub CI is not
reported as passing. No frontend source changed in this patch.

## Deployment and rollback

- API service: `capiro-dev-api` in cluster `capiro-dev`, region `us-east-1`.
- Runtime source: `1cf242dc4205767d9dcc172601cc790e88d3cc34`.
- Exact prior source: `56d97272986fc6546776dc75eaac88a682209198`.
- Release image digest: `sha256:4202b34f6bf04aaf1c81db9d1be058ec25f4bceef0c4f8b512ca58684c238b2b`.
- Rollback task: `capiro-dev-api:395`.
- Prior image digest: `sha256:cc7dc8a143a329958b87fbe673cc72325de4ec4f98d444ace1458ee9ddf76274`.

The release overlays only the four changed runtime modules on the exact previous
image, preserving the deployed Hermes implementation. The task definition retains
all other deployed environment values, secret references, roles and permissions.
Only the release SHA and monday enablement/internal user/tenant lists changed.
No database migration or manually deployed monday credentials were needed.

Follow [the DCR runbook](./monday-dcr.md) before expanding availability.

## Live fixture and recovery

At the user's request, created `Meri MCP verification — 2026-09-20` on the
existing Tasks board and two subitems through monday's own UI:

- Parent: `13088410202` on board `18431248553`.
- `Verify tenant isolation — ORBIT-4729`: subitem `13088412915`.
- `Confirm item links — MAPLE-8632`: subitem `13088393631`.

The Meri prompt supplied only the parent name and board ID, not the subitem
names or verification codes. Meri executed `Get Board Info` and `Get Board
Items Page`, returned both exact names/codes with links, and completed the turn.
The test conversation is
`https://os.capiro.ai/meri/t/e5e03670-1d30-4103-81a9-71d5450598bc`.

An earlier turn in that conversation failed with `authorization_downgrade`.
API logs locate the failure in the temporary Hermes pilot's worker-token/run
authorization version check, not in monday OAuth. While investigating, another
deployment rolled the API back from task 398 to 395 and removed the pilot's
static runtime mapping; this also removed the monday patch and flags. Task 399
restores the tested monday patch over task 395's current settings without
reenabling that pilot. The subsequent live read used the normal managed-MCP
runtime and passed. The broker authorization check was not bypassed or changed.
