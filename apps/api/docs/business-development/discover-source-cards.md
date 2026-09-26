# Discover source-backed cards

This additive API/UI change moves Discover toward the v5 prototype. It does not claim complete prototype parity or completion of the Phase 1–5 rollout.

## Source and tenant contract

- Candidate search still uses one bounded page-level aggregate over existing `federal_award` records matched by exact visible UEI. No provider calls, ingestion jobs, or schema changes are added.
- `whyInspect.latestAward` exposes bounded description, awarding agency, recipient name/state, and decimal-string `obligatedAmountUsd`. Every field uses the same deterministic ordering as the source record ID: `action_date DESC NULLS LAST, id ASC`.
- Amount means the award-level USAspending obligations value, not the latest transaction, ceiling, or outlays. Zero and negative values remain valid. The compact UI value is rounded; its accessible label/title retains exact decimal cents. The all-awards total is a separate disclosure.
- A recipient address state is explicitly not a verified facility. Calendar-only event dates are displayed without shifting to the preceding day in US time zones.
- `evidenceCoverage` distinguishes available evidence, empty queried scope, unresolved identity, and failed queries. A source query failure must not imply that the company has no awards.
- `serviceHypothesis` is the current tenant's saved prospect judgment, not a generated inference or a source fact. Other tenants' hypotheses, notes, and conflict reasons are excluded.
- Optional client fields tolerate the previous API during a rolling deployment. Existing prospect navigation and explicit save behavior remain; a synchronous in-flight guard suppresses duplicate saves.

## Verification commands

Run from the relevant application directory unless stated otherwise:

```powershell
# apps/api
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit src/business-development/bizdev-dossier.service.spec.ts
pnpm exec tsc --noEmit --rootDir .

# Repository root; transaction-local PostgreSQL fixtures only, always rolled back
./apps/api/scripts/ops/verify-bizdev-candidate-projection.ps1

# apps/web; one worker to bound workstation memory
pnpm exec vitest run src/vnext/pages/business-development --maxWorkers=1 --minWorkers=1 --no-file-parallelism --testTimeout=20000 --hookTimeout=20000
pnpm exec tsc -p tsconfig.json --noEmit
```

The SQL rehearsal extracts the actual aggregate from service source and verifies same-row fields, stable tie ordering, null/zero/negative semantics, and exclusion of unrequested UEIs. Unit tests additionally cover tenant isolation, outage semantics, no extra query/provider fan-out, precise money, calendar dates, and backward-compatible UI rendering.

## Deployment and limits

Merge GitHub main and fast-forward the designated local main before building immutable images. Trace `os.capiro.ai` before each AWS CLI deployment: the verified UI service is `capiro-dev-web-vnext`, and `/api/*` serves `capiro-dev-api` in cluster `capiro-dev`, `us-east-1`. `capiro-prod-os-capiro` is not this site's service.

Deploy the additive API before the web image. Preserve existing task configuration and unrelated releases. This change needs no database migration or evaluator/schedule change; do not incidentally run unrelated destructive migrations included elsewhere on main. Verify running image digests, target health, public release metadata, live candidate response/card agreement, source navigation, existing workflows, and responsive screenshots after deployment. A locally overlaid preview is not proof of live deployment.

Remaining scope includes real agency/issue/geography/service filters, source-health presentation, complete prototype parity, the full Meri workflow, scheduled watch/change/notification acceptance, and provider/evaluation rollout gates. PDL rights and human-reviewed Jev evaluation are not established by these card tests. Report hosted CI as unavailable if jobs never start due to billing; local verification is not hosted CI success.
