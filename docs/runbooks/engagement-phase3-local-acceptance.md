# Engagement Phase 3 — Local Acceptance

## Purpose

Prove the exact current Engagement SPA can operate in normal and preview modes against one disposable database, while preview external actions fail closed before side effects.

## Preconditions

- clean checkout of `agent/engagement-api-phase-3-full-ui-parity`;
- Node/pnpm per repository engines;
- Docker with `pgvector/pgvector:pg16`;
- Chrome/Chromium discoverable by `chrome-launcher`;
- dedicated Clerk acceptance user already exists and is a member of the dedicated acceptance organization;
- do not use a customer tenant or mailbox.

Required environment:

```text
CLERK_SECRET_KEY
CLERK_JWT_ISSUER
VITE_CLERK_PUBLISHABLE_KEY   (or CLERK_PUBLISHABLE_KEY)
ENGAGEMENT_PHASE3_ADMIN_CLERK_USER_ID
ENGAGEMENT_PHASE3_PRIMARY_CLERK_ORG_ID
```

Optional identity bindings supported by the fixture binder for later/expanded actor probes:

```text
ENGAGEMENT_PHASE3_STANDARD_CLERK_USER_ID
ENGAGEMENT_PHASE3_BELOW_ROLE_CLERK_USER_ID
ENGAGEMENT_PHASE3_PEER_CLERK_USER_ID
ENGAGEMENT_PHASE3_WALL_DENIED_CLERK_USER_ID
ENGAGEMENT_PHASE3_CROSS_TENANT_CLERK_USER_ID
ENGAGEMENT_PHASE3_CAPIRO_ADMIN_CLERK_USER_ID
ENGAGEMENT_PHASE3_SECONDARY_CLERK_ORG_ID
ENGAGEMENT_PHASE3_CAPIRO_INTERNAL_CLERK_ORG_ID
```

Never print any secret or browser bearer token.

## DB-free gate first

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/api exec prisma generate
pnpm verify:engagement-phase-3
```

Require:

```text
ENGAGEMENT_PHASE3_DB_FREE_COMPLETE
```

## Authoritative local run

```bash
pnpm verify:engagement-phase-3:local -- --sha "$(git rev-parse HEAD)"
```

On PowerShell:

```powershell
$sha = git rev-parse HEAD
pnpm verify:engagement-phase-3:local -- --sha $sha
```

The runner refuses a dirty checkout or a SHA other than `HEAD`.

## What the runner starts

```text
pgvector PostgreSQL 16 :55474 (default)
main API               :4000
engagement-api         :4500
local preview proxy    :4600
web                     :5173
```

Override ports with the runner flags when one is occupied.

## Required evidence

`.artifacts/engagement-phase3-<sha>/` must contain at minimum:

```text
fixtures.json
summary.json
local-runner-summary.json
ui-surface-results.json
network-results.json
dom-comparison.json
accessibility.json
read-parity.json
local-write-interoperability.json
external-action-denials.json
proxy-routing.json
screenshots/main/
screenshots/preview/
logs/
```

The bearer-token file must **not** exist under `.artifacts/`; it is created in the OS temp directory and removed in cleanup.

## Acceptance assertions

### Routing

- main sends no preview header;
- preview sends exact `X-Capiro-Engagement-Preview: v3` only on Engagement API requests;
- non-Engagement requests stay on main;
- every preview Engagement response has `X-Capiro-Service: engagement-api`;
- activation parameter is removed without losing unrelated query values.

### Data and rendering

- main/preview normalized DOM is equal for the exercised surface/viewports;
- browser-observed Engagement GETs replay with equal normalized status/body directly against `4000` and `4500`;
- no authenticated replay may return 401;
- desktop/tablet/mobile snapshots exist;
- no duplicate IDs, unnamed rendered dialog, or horizontal overflow in the acceptance matrix.

### Safe local write

- a disposable task is created through preview;
- main reads the exact row;
- main updates it;
- preview reads the update;
- database contains exactly one row;
- probe row is deleted during the verifier.

### External actions

Every current UI-inventory request classified `external_action` must return:

```text
503
code = ENGAGEMENT_EXTERNAL_ACTION_DISABLED
X-Capiro-Service = engagement-api
```

The protected before/after DB hash must be identical. This is what distinguishes a policy refusal from a downstream S3/provider failure.

## Cleanup

The runner always attempts to:

1. stop web, proxy, shadow and main;
2. remove the safe-write probe row;
3. clean deterministic Phase 3 fixture rows;
4. remove the disposable Postgres container;
5. delete temporary bearer material.

If the process is interrupted, remove the disposable container by its `engagement-phase3-*` name and rerun fixture cleanup only against that same disposable database.

## Failure policy

A failing parity, security, route, cache, DB-invariant, accessibility or containment assertion is a Phase 3 defect until proven otherwise. Do not skip the scenario, weaken the comparator, or turn an external-action route into a read to make the gate pass.
