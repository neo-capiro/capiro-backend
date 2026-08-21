# Phase 8 Session 9 — Closeout Handoff

**Prepared:** 2026-08-21
**Repository:** `neo-capiro/capirov2`
**Base `main` at session start:** `d32c79446a932f10ac352c84cfedd1d9802734df`
**Session 9 branch:** `agent/phase8-session9-provider-runtime`
**Workstream:** provider/runtime integration for the Workstream-E cross-domain ports

---

## 1. Final verdict

```text
SESSION9_COMPLETE
READY_TO_MERGE_SESSION9   (awaiting separate explicit authorisation)
```

Both cross-domain ports are wired to real providers and **dark by default**. No
credential is provisioned in any environment, no live provider call was made, and
no infrastructure changed.

## 2. Scope derivation — read this first

**There is no Session 9 specification document in this repository.** No
`phase8-session9-*` doc exists, and no Phase 8 master handoff exists — its absence
was established during Session 8 and is unchanged. So there is no objective or
acceptance checklist to quote, and fabricating one would have been worse than
saying this plainly.

What *is* authoritative is a set of three code sites that name Session 9 and agree
precisely:

| Location | States |
|---|---|
| `cross-domain/ports.ts:16-18` | "What is absent in dark posture is the **OUTBOUND CREDENTIAL** … Session 9 (shadow read) is where these get wired to real providers." |
| `program-elements.module.ts:29-31` | "…exist as INJECTION TOKENS rather than direct imports so **Session 9 can bind a real provider** without touching a single read service" |
| `budget-lines-read.service.ts:636` | "the query, ranking and enrichment below are the real implementation and **run as soon as a provider is wired (Session 9)**" |

One contract change was unavoidable and was **explicitly authorized by the
operator before implementation**: `ClientRelevancePort` cannot be completed
without an endpoint, because `apps/api` answered the relevance question only
in-process. See §6.

## 3. Files changed

18 files.

```text
apps/api/prisma/migrations/20261204120000_phase8_session9_provider_invocation_audit/migration.sql
apps/api/prisma/schema.prisma                              (1 model)
apps/api/src/intelligence/internal-pe-relevance.controller.ts   (the one additive route)
apps/api/src/intelligence/intelligence.module.ts                (registration)
packages/defense-domain/src/cross-domain/
    provider-selection.ts  provider-retry.ts  provider-audit.ts  index.ts
packages/defense-domain/src/index.ts
apps/defense-api/src/program-elements/cross-domain/
    provider-runtime.ports.ts       provider-invocation.runner.ts
    provider-runtime.factory.ts     bedrock-embedding.adapter.ts
    internal-service-client-relevance.adapter.ts
    https-provider-http.adapter.ts  prisma-provider-audit.sink.ts
    testing/provider-test-doubles.ts
apps/defense-api/src/program-elements/program-elements.module.ts
scripts/{verify,test}-phase8-session9-*
docs/defense-budget/phase8-session9-provider-design.md
docs/runbooks/defense-cross-domain-providers-v1.md
.github/workflows/phase8-session9-provider-runtime.yml
```

## 4. Acceptance criteria

| Criterion | Status |
|---|---|
| Real embedding provider behind the frozen `EmbeddingPort` | Bedrock Titan v2 adapter; `model` resolved the same way the dark port resolved it, because vector reads filter on `context_embeddings.model` |
| Real relevance provider behind the frozen `ClientRelevancePort` | Internal-service adapter over the main API's **existing** shared-secret channel; ONE batched call, as the port contract already required |
| Deterministic provider selection | One decision point, fails closed to dark, never throws, every rejection carries a reason |
| Dark by default | An empty environment binds both ports to the Sessions 2-8 unconfigured implementations; behaviour is unchanged |
| A credential alone cannot activate | The explicit provider switch is required; asserted |
| Retry / failure semantics | Classified before retried; `unauthorized` and `invalid_request` terminal; exponential, no jitter; `Retry-After` obeyed when longer; `totalBudgetMs` bounds the whole invocation |
| Degradation, never an exception | Every path returns `null`/empty set; the runner has no throwing branch |
| Idempotency | sha256 over canonical `{provider, operation, model, tenantId, payloadDigest}`; tenant included |
| Concurrency control | Per-provider gate, refused not queued; bound once so both ports share one gate map |
| Observability / audit | One append-only row per invocation, including non-invocations |
| No secret, payload, vector or dollar on a row | Runtime leak guard at any depth + DB column absence, measured |
| Migration + persistence | 1 table, 12 CHECKs, 4 indexes, least-privilege grants |
| Session 2-8 guarantees | all regression gates green; 49 frozen routes; `NVIDIA_NOT_ADOPTED` intact |

## 5. Provider / runtime behaviour

```text
selection:      dark | bedrock_embedding | internal_service_relevance
default:        dark (both ports)
activation:     explicit switch + complete config; a credential alone is not enough
failure mode:   degrade to null / empty set, never throw
retry:          classified, exponential (100/200/400ms), no jitter, budget-capped
concurrency:    per-provider cap, refuse rather than queue
audit:          one row per invocation, append-only, digests only
```

Worst case added read latency at defaults (3 attempts x 5000 ms + backoff) is
~15.3 s; the runbook documents lowering `MAX_ATTEMPTS` before raising
`TIMEOUT_MS`.

## 6. The one additive route

`POST internal/program-elements/relevance/batch` on `apps/api`.

Necessary because `apps/api` answered relevance only in-process
(`getRelevantClientsForPeByTenantId`, capped at `MAX_RELEVANCE_PROBES = 50`) — the
port's stated "ONE call for the whole candidate set" had nothing to call.

Narrow by construction: on the **existing** `internal/*` path behind the
**existing** fail-closed `InternalServiceGuard` alongside six other internal
controllers, so no new auth mechanism and no new credential class; identical
scoring path so the batched and per-PE answers cannot diverge; **PE codes only**,
never client identities; read-only; bounded at 200 and an over-large batch is
**refused, not truncated**.

**The defense-api surface is unchanged** — this route is on `apps/api`, so Session
3's frozen 49 stay frozen, verified.

## 7. Database rehearsal

`SESSION9_DB_REHEARSAL_PASS (43 checks)` from a zero-state PostgreSQL 16, full
migration ledger applied from scratch.

Negative controls: a failure with no named class; a success carrying one; a
degraded row claiming an embedding dimension; a success that produced nothing; a
relevance call carrying a model; an embedding call carrying a count; a blank
reason or tenant; a row finishing before it started; negative attempts/latency; an
unknown operation or outcome; a zero-length vector; UPDATE and DELETE from both
roles; serve writing a Session 7 or Session 8 table.

**Grant boundary, measured not assumed.** Serve's write surface is pinned to
exactly the Sessions 2/3 set plus the new table:

```text
audit_logs · defense_budget_manual_override · pe_alert_email_pref
program_element_data_issue · program_element_watch · reconciliation_review_queue
+ defense_provider_invocation   (INSERT only)
```

Serve holds `INSERT` and nothing else on the new table, and **0** write grants on
any Session 7 or 8 table.

> A correction worth recording: the first version of this assertion required serve
> to hold zero write grants anywhere outside the new table. That was wrong — serve
> already owned its own mutation surfaces from Sessions 2/3. The check now pins the
> whole set, which is strictly stronger: any future widening fails here.

## 8. Regression results — all fresh on this candidate

```text
S9  SESSION9_PROVIDER_RUNTIME_PASS
S9  provider domain gate            36/36
S9  provider runtime spec           30/30
S9  disposable DB rehearsal         43/43
S2  SESSION2_BOUNDARY_PASS
S3  SESSION3_BOUNDARY_PASS — 49 frozen routes, exact method/path/role match
S3  SESSION3_ADMIN_BOUNDARY_PASS
S4  SESSION4_SOURCE_PARITY_PASS (--enforce-replay)
S4  SESSION4_IMAGE_CONTAINMENT_PASS (8 checks)
S4  PHASE7_TYPECHECK_BASELINE_MATCH
S5  SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED
S6  SESSION6_FEDERAL_FUNDING_FOUNDATION_PASS + domain 9/9
S7  SESSION7_LIFECYCLE_CONTROL_PLANE_PASS + domain 57/57 + control loop 32/32
S8  SESSION8_LIVE_DISCOVERY_PASS (--enforce-replay)
    + discovery domain 40/40 + publisher-native 15/15
    + control loop 15/15 + real-source replay 37/37
Prisma: apps/api validate + generate PASS; defense-api validate PASS
Structural drift on defense_provider_invocation: ZERO
defense-api typecheck PASS; build PASS
git diff --check: clean
```

GitHub Actions remains externally unavailable repo-wide (startup failures since
2026-07-31). The Session 9 workflow is added and updated; every gate above was run
locally on this exact candidate.

## 9. Safety statement

```text
AWS mutated:                     NO
Production DB mutated:           NO
Production schedules changed:    NO
Production routes changed:       NO   (defense-api still exactly 49)
Snapshot promoted or activated:  NO
NVIDIA provisioned or restarted: NO   (Session 5 remains NVIDIA_NOT_ADOPTED)
Live provider call made:         NO
Provider / AWS spend:            $0
Session 10 started:              NO
Session 9 PR merged:             NO
```

No credential is provisioned by this session in any environment. Activation means
putting a provider switch and a credential on a task definition — a deployment
act, deliberately outside a session that changes no infrastructure. CI sets no
provider credential either, so CI cannot become the first live activation.

## 10. Bugs found and fixed while building this

1. **Providers were bound twice.** The first module wiring called the factory once
   per port, giving each its own concurrency-gate map and silently doubling the
   effective in-flight cap. Now bound once behind one token, with both ports
   derived from it, and the static gate asserts exactly one call site.
2. **The audit builder did not enforce its own failure-class invariant.** Only the
   DB CHECK and the in-memory double did, so a caller that never reached the
   database could construct "it just returned nothing" as a storable state.
   `buildProviderAudit` now enforces the same equivalence in both directions.
3. **The static verifier stripped `//` but not `--`.** The migration necessarily
   spells out the privileges it does *not* grant, so the append-only checks failed
   on their own prose — Session 7's "verifier matched its own prose" bug in a
   different comment syntax. A SQL-aware stripper now runs for SQL.
4. **The grant assertion was wrong** (see §7): it assumed serve held no write
   grants at all.

## 11. Disclosed limitations

### 11.1 Both ports ship dark; no live provider validation was performed

By design and by the session's safety envelope. No credential exists in any
environment, so no live Bedrock call and no live internal-service call was made.
The transport is exercised against scripted responses covering success, throttle,
auth failure, 5xx, malformed body, `NaN` vector, redirect refusal and concurrency
refusal — but a real provider's wire behaviour is unverified until activation.
The runbook covers what to check at that point.

### 11.2 `apps/api` full typecheck has 16 pre-existing errors

`pnpm --filter @capiro/api typecheck` reports 16 errors across five unrelated
modules (`meri`, `reviews`, `memory`, `intelligence/alert-memo`, and four
`rootDir` complaints about `scripts/**` specs). **Proven pre-existing**: stashing
the entire Session 9 change set and re-running produced a byte-identical error
set. Session 9 adds none, and none is in a file this session touched. Out of
Session 9 scope; the encoded Session 4 phase-7 baseline gate is green.

### 11.3 The batched relevance answer is bounded at 200 codes

An over-large batch is refused rather than truncated, so a caller asking about
more than 200 PEs gets an error rather than a silently partial answer. The
adapter's own cap (`DEFENSE_CLIENT_RELEVANCE_MAX_BATCH`, default 50) keeps it
below that; a caller wanting more must page.

### 11.4 No cost accounting

Provider spend is not a funding fact, so no monetary column exists and none is
tracked. Use the AWS billing console. Asserted against `information_schema`.

## 12. Open items for Session 10+

1. **Activation** is a deployment act: provider switch plus credential on a task
   definition, per the runbook. Nothing in this session performs it.
2. **Schedule ownership remains Session 10's.** Session 9 registers none.
3. **The Session 9 table is intentionally absent from the curated `defense-api`
   HTTP Prisma subset** (same precedent as Sessions 6-8); the sink uses
   parameterised raw SQL.
4. **`MAP_STYLE_ATTRIBUTION`** still needs its real value restored — carried
   forward, unrelated to Phase 8.

## 13. Commands

```bash
node scripts/test-phase8-session9-provider-domain.mjs
pnpm --filter @capiro/defense-api exec tsx --test \
  src/program-elements/cross-domain/provider-runtime.spec.ts
node scripts/verify-phase8-session9.mjs
node scripts/verify-phase8-session9-db.mjs
```

**Do not merge until separately authorised.**
