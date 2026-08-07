# Phase 0 — Engagement API Baseline Contract

**Repository:** `neo-capiro/capirov2`
**Branch:** `agent/engagement-api-phase-0-baseline`
**Base SHA:** `0cc05569aabd8d9ebddeb0b58b0d15bb8d75002c`
**Date:** 2026-08-04

---

## Scope

Phase 0 establishes a mechanically verifiable baseline for the current Engagement Manager before runtime extraction into a future `engagement-api` Fargate service.

This session (0A) covers static contracts only:
- Route manifest (110 routes)
- Reverse-dependency manifest (40 external importers)
- Side-effect registry (23 entries)
- DB-free verification
- Unit tests (30 specs)

No browser fixture, no CI changes, no infrastructure changes, no runtime behavior change.

---

## Route Inventory Summary

| Classification | Count |
|---|---|
| read | 42 |
| write | 28 |
| generation | 12 |
| external_send | 6 |
| oauth | 13 |
| webhook | 1 |
| internal_secret | 1 |
| sync | 3 |
| notetaker | 3 |
| attachment | 1 |
| **Total** | **110** |

### Controllers Parsed
- `EngagementController` (engagement prefix)
- `MicrosoftOAuthController` (engagement/integrations/microsoft)
- `GoogleOAuthController` (engagement/integrations/google)
- `OutcomeController` (engagement/outcomes)
- `InternalAiCredentialsController` (internal/ai-credentials)
- `RecallWebhookController` (bare webhooks/recall)

### Key Validations
- Recall webhook stays bare (no /api prefix)
- Microsoft + Google OAuth callbacks present
- Internal AI credential route classified `internal_secret`
- Global prefix: `/api`

---

## Reverse-Dependency Summary

**External importers:** 40 (modules outside `engagement/` that import engagement code)

### Key Importers by Category
- **root_registration:** `app.module.ts` (imports EngagementModule)
- **reviews:** `reviews.module.ts`, `reviews.service.ts`
- **meri:** `meri.module.ts`
- **intelligence_deliverable:** `alert-memo.module.ts`, `district-brief.module.ts`
- **webhook:** `webhooks.module.ts` (imports EngagementModule for NotetakerService)
- **context:** `context.module.ts`
- **memory:** `memory.module.ts`
- **other:** `ai-usage.module.ts`, `clients.module.ts`, `capiro-admin.module.ts`, `directory.module.ts`, and more

---

## Side-Effect Summary

| Category | Count |
|---|---|
| OnModuleInit timers | 5 |
| OAuth exchanges | 2 |
| Webhooks | 2 |
| Mailbox sync paths | 3 |
| Calendar sync paths | 2 |
| Send paths | 3 |
| LLM calls | 3 |
| S3 effects | 2 |
| Attachment scans | 1 |
| External HTTP calls | 1 |
| **Total entries** | **23** |

### Process Loops (OnModuleInit + setInterval)
1. `EngagementSyncSchedulerService` — mailbox/calendar sync scheduler
2. `OutreachJobService` — generation job claim worker
3. `OutreachSendIntentService` — send intent claim worker
4. `NotetakerService` — notetaker status reconciliation
5. `AiCredentialResolverService` — credential warmup

All registered, all owned by `main_api`.

---

## Automated Verification

```bash
# DB-free verification (all three gates):
pnpm verify:engagement-phase-0

# Update fixtures (after intentional baseline changes):
pnpm verify:engagement-phase-0:update-fixtures

# Jest specs (DB-free):
npx jest --runInBand --forceExit \
  src/engagement/engagement-route-manifest.spec.ts \
  src/engagement/engagement-dependency-manifest.spec.ts \
  src/engagement/engagement-side-effect-registry.spec.ts
```

**Result:** 30/30 tests passing, all three verifiers green.

---

## Negative Controls

- **NC1 (route drift):** Synthetic route change in copied fixture causes mismatch ✓
- **NC2 (missing controller):** Generator fails hard (exit 1) when source file missing ✓
- **NC3 (dependency drift):** Synthetic symbol change in copied manifest causes mismatch ✓
- **NC4 (unregistered timer):** Removing a timer entry reduces OnModuleInit count ✓
- **NC5/NC6:** Browser-specific — deferred to Session 0B

---

## Commands Required to Reproduce

```bash
git checkout agent/engagement-api-phase-0-baseline
pnpm install --frozen-lockfile
pnpm verify:engagement-phase-0
pnpm --filter @capiro/api exec jest --runInBand --forceExit \
  src/engagement/engagement-route-manifest.spec.ts \
  src/engagement/engagement-dependency-manifest.spec.ts \
  src/engagement/engagement-side-effect-registry.spec.ts
```

---

## Non-Goals (this session)

- No browser acceptance runner
- No disposable PostgreSQL fixture
- No CI changes
- No AWS changes
- No `engagement-api` service or bootstrap
- No UI changes

---

## Known Gaps

- **Browser acceptance:** Not yet captured (Session 0B)
- **CI integration:** Not yet wired (Session 0B, after verifier is stable)
- **Auth-aware route testing:** Fixtures are read-only; no auth simulation
- **External-call candidate review:** Advisory warnings printed; not exhaustively verified

---

## Phase 1 Blockers

1. All process loops must be assigned explicit ownership before a second runtime can be active
2. OAuth callback routes must be consolidated under engagement-api
3. Recall webhook must route to engagement-api
4. Reverse dependencies (Reviews, Meri, AlertMemo, DistrictBrief) must be decoupled or made cross-service
5. AWS CDK stack for engagement-api must be created (independent of frozen Compute stack)
