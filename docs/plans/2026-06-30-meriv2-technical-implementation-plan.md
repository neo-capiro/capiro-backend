# MeriV2 — Technical Implementation Plan (Agent Handoff)

Date: 2026-06-30
Owner: Neo Martinez (CTO)
Status: Ready for agent handoff
Supersedes (operationally): `2026-06-29-meriv2-overnight-agent-prompt.md`
Authoritative architecture spec: `2026-06-29-meri-consolidated-command-architecture-plan.md`
Companion kickoff prompt: `2026-06-30-meriv2-agent-handoff-prompt.md`

> This document is the **build spec**. The architecture plan (`…-command-architecture-plan.md`)
> says *what* MeriV2 is and *why*. This document says *how* to build it, *in what order*, *which
> exact files to touch*, and *how each piece is proven done*. Every work item maps to one or more
> success criteria (SC0.1 … SC5.9) from the architecture plan; those criteria are reproduced
> inline and extended with concrete verification commands.

---

## 0. How to use this document

1. Read §1 first. It is a **verified reconciliation** of the architecture plan against the actual
   `capiro-meri` codebase as of 2026-06-30. The architecture plan contains a few stale/contradictory
   current-state claims; §1 corrects them so you do not build against a wrong premise.
2. §2 is the non-negotiable ground rules (paths, commands, guardrails). Read before writing code.
3. §3–§8 are the phases. Each phase has **tasks** (`P{phase}-T{n}`). Each task has: *Goal*,
   *Files to touch* (verified paths), *Implementation notes / interfaces*, *Depends on*, and
   *Done when* (the success criteria + a runnable check). Do tasks in order within a phase; do
   phases in order. **Phase 5 (Live Hearing) is last and gated** — see §8.
4. §9 is the SC → task → verification traceability matrix. §10 is cross-cutting concerns.
   Appendices give the new-sync-job recipe and the tool-registry interface.

Status tags used below: **REUSE** (exists, wire it in unchanged), **EXTEND** (exists, add to it),
**NEW** (greenfield), **GATE** (requires CTO sign-off — see §2.4).

---

## 1. Reconciliation: architecture plan vs. verified codebase reality

This section answers "how does it match up." Each claim in the architecture plan was checked
against the code. **Verdict: the architecture, deployment model (Option B), phasing, and success
criteria are sound and well-matched to the stack. Five current-state claims are stale or
self-contradictory and are corrected here.** None of the corrections invalidate the plan; two of
them make Phase 0 *cheaper* (the orchestrator and feature-flag machinery already largely exist).

### 1.1 Headline corrections (read these)

| # | Architecture-plan claim | Verified reality | Impact on the build |
|---|---|---|---|
| C1 | "Today there is **no orchestrator**… two independent Meri surfaces that each re-assemble the prompt stack by convention." (§0) | **There is a large, mature orchestrator: `apps/api/src/meri/`** — `@Controller('clio')`, `MeriService.streamMessage()` runs a full agentic loop (tool calls, streaming, memory, MCP, deep research, doc-gen), with 40+ helper modules (`meri-compliance`, `meri-citations`, `meri-confidence`, `meri-docgen`, `meri-domain-fanout` = `DOMAIN_PRIMER`, `meri-freshness`, `meri-graph-tools`, `meri-circuit-breaker`, `meri-compaction`, …). It already **exports `MeriToolsService`** (`meri.module.ts`), which `workspace-assistant` reuses. | Phase 0 is **extract-and-share**, not greenfield. `@capiro/meriv2-core` is largely a *refactor* of `apps/api/src/meri` logic into an importable package + a service host. There are effectively **three** prompt-assembly sites to converge, not two: `meri` (full chat), `workspace-assistant` (in-editor, read-only), `apps/workspace` (generation). The richest one (`meri`) is the source of truth to extract from. |
| C2 | §1.2: "Official Source Warehouse PARTIAL … Congress.gov, GovInfo, Fed Register, USAspending, votes mostly **NOT ingested** = bulk of Phase 2." | **Self-contradiction with §7.1, which is the correct one.** `sync-congress`, `sync-federal-register`, `sync-regulations`, `sync-hearings`, `sync-federal-award` (USAspending), `sync-lda`, `sync-fara` all exist as scripts and scheduled jobs (132 ingestion scripts; 48 scheduled jobs in `infra/cdk/lib/ingestion-schedule.ts`). What is **genuinely absent**: votes, floor/rules, eCFR, CBO/JCT, FPDS, CourtListener, SBIR (zero matching scripts). | Phase 2 is **smaller than §1.2 implies**. Do not re-ingest Congress/FedReg/awards. Build only the §7.2 gap jobs. Treat §7.1 as the inventory of record; ignore §1.2's "mostly not ingested." |
| C3 | Phase 0 work item 3: "**Add** per-tenant + per-surface feature flags." | **A per-tenant feature-flag system already exists:** `MeriFeatureFlagsService.isEnabled(tenantId, flag, default)` (reads `tenants.settings_jsonb.clioFeatureFlags`, 60s cache) + pure helper `common/tenant-flags.ts` (`tenantFeatureEnabled`, with env kill-switch). | **REUSE** this. Add two flag keys (`meriv2.inEditorAssistant`, `meriv2.workspaceGen`), default OFF. Do not build a new flag store. |
| C4 | §7.2 note on `sync-house-votes`: "partial `rollcall` code exists; finish + schedule." | **No vote/roll-call ingestion code exists at all** (grep for `vote/rollcall/floor` returns only the unrelated `tracker` change-detector). | `sync-house-votes` / `sync-senate-votes` are **fully greenfield**, including new Prisma models. Budget for it as net-new, not "finish existing." |
| C5 | SC0.6 implies extending a CI gate; guardrail §9.1 says faking `clerkUserId=pending:<id>` "→ 500". | **There is no PR-time CI gate today** — only nightly `clio-evals.yml` and per-app image builds (`api-image`, `workspace-image`, `web-image`, `sandbox-image`). And the `pending:<id>` path is currently **handled gracefully** (self-heal in `tenant-context.middleware.ts`), not a guaranteed 500. | SC0.6 = stand up a **new required PR check** (`meriv2-evals.yml` + a PR lint/typecheck/test workflow), not extend an existing one. The auth guardrail still holds ("don't reimplement / don't fake identity"), but don't rely on the "→ 500" rationale. |

### 1.2 Surfaces (architecture-plan §1.1) — verified

| Surface | Plan's "Today" | Verified today | Target (unchanged) |
|---|---|---|---|
| In-editor Workspace Assistant | own prompt assembly | `apps/api/src/workspace-assistant/workspace-assistant.service.ts` — `run()`, `ASSISTANT_TOOLS` read-only allowlist, reuses `MeriToolsService` + `DOMAIN_PRIMER` + grounding | thin caller of `@capiro/meriv2-core` |
| Workspace generation | own service/ECR/Fargate | `apps/workspace/` standalone Nest service: `main.ts` `setGlobalPrefix('workspace-api')`, own Dockerfile/prisma; only internal dep is `@capiro/shared` | thin caller of `@capiro/meriv2-core` |
| Full Meri Chat | "partial / dashboard copilot prompts" | **understated** — `apps/api/src/meri/` is the full orchestrator (see C1) | orchestrator plan-mode (extracted into core) |
| Issue Dashboard | fragmented (Intel tab / Needs Attention / changes inbox) | confirmed fragmented; `apps/api/src/tracker/` + `apps/api/src/intelligence/` + `emit-changes` | one alert taxonomy (Phase 1) |
| Live Hearing Room | does not exist | confirmed absent | new worker service (Phase 5) |
| Admin / Compliance Console | partial | `AuditLog`/`NotificationLog`/`AlertPreference` exist; no unified precheck-gate console | Compliance/Audit store + console |

### 1.3 Six warehouses (architecture-plan §1.2) — verified status + pointers

| Warehouse | Plan | Verified | Key models / files | Build note |
|---|---|---|---|---|
| 1. Official Source | PARTIAL | **MOSTLY EXISTS** (see C2) | `CongressBill(+Action/Committee/Subject/Text)`, `LdaFiling`, `FederalAward`, `ProgramElement(+Year/Source/Project/Delta)`, `FederalRegisterDocument`, `FaraRegistration`, `SamOpportunity`, `FederalGrant`, `SecFiling` in `apps/api/prisma/schema.prisma`; only `ProgramElementIngestRun` is a true ingest ledger | Add only §7.2 gap sources. Keep public data **global (no `tenant_id`)**; only linkages (`ClientIntelMapping`, `TrackedBill`) are tenant-scoped. |
| 2. Private Firm Memory | EXISTS | **EXISTS** | `Client`, `EngagementContact`, `Meeting`, `MeetingDebrief`(enc), `MeetingNote`(enc), `EngagementTask`, `MailThread`, `MailMessage`, `OutreachRecord`, `ClioArtifact`, `ClioNote`, `ClioMemory` — all `tenant_id`-scoped | No work; reuse. |
| 3. Knowledge Graph | "EXISTS but MISPLACED (embedded in client profile)" | **EXISTS as first-class** `MemoryItem`(node) + `MemoryEdge`(edge); 3D view at `apps/web/src/pages/intelligence/` (Appendix A18 of the plan is accurate; §1.2's "embedded in client profile" is stale) | Phase 1 relocation is mostly a **UI/shell** move + ensuring edges merge FK (`relation='fk'`) with wikilink mentions (`relation='mention'`). Do not build a second graph. |
| 4. Freshness / Change Detection | PARTIAL/SCATTERED | **PARTIAL** | `IntelligenceChange` (global), `ProgramElementDelta` (supersession), `TrackedBill` (snapshot), `SyncRun`; `emit-changes`/`emit-bill-alerts` emitters | Phase 1: unify into one dedup'd event → one alert taxonomy. |
| 5. Claim / Evidence | PARTIAL | **ABSENT as first-class** | evidence is embedded JSON on `ProgramElementDelta.evidence`, `ActionRecommendation.evidence`, `ProvisionPeLink.evidence` | Phase 0 T7: create first-class `Claim`/`Evidence` tables (additive). |
| 6. Compliance / Audit | PARTIAL | **STORE EXISTS; ENGINE ABSENT** | `AuditLog`(before/after/actor/ip), `NotificationLog`, `OutreachRecord`, `AlertPreference`, `SmsVerification` | Phase 0 T7: add `ComplianceCheck` record table. Phase 2: build the PASS/WARN/BLOCK precheck engine that writes to it. |

### 1.4 Ingestion subsystem (architecture-plan §7) — verified

- **Construct is real and reusable.** `SyncRun` model + `apps/api/src/ingestion/sync-run.helper.ts`
  (`runWithSyncRun`, `lastSuccessfulWatermark`, `emptyCounts`) + `infra/cdk/lib/ingestion-schedule.ts`
  (`INGESTION_JOBS`, 48 entries) + `infra/cdk/lib/constructs/scheduled-ingestion-jobs.ts` (one
  EventBridge rule per job, overrides container `command`) + `apps/api/scripts/entrypoint.sh`
  dispatch. The §7 "same `SyncRun`/`ScheduledJob` construct" instruction is correct and should be
  followed exactly (Appendix Z).
- **Caveats the plan understates (must be handled, not assumed):**
  - The **"skip if prior run still active" guard is NOT standardized** — only ad-hoc in some scripts.
    Phase 0 T8 standardizes it in `runWithSyncRun`.
  - **Only ~15 of 48 jobs use `runWithSyncRun`;** the rest hand-roll `SyncRun`. New jobs must use the
    helper; do not copy a hand-rolled one.
  - **No dependency-DAG enforcement** — ordering is purely cron wall-clock staggering. New emitters
    must tolerate stale upstreams (no hard ordering guarantee).
  - **Derived/emitter EventBridge rules are partly missing/orphaned** (a dead `capiro-dev-emit-changes-daily`
    rule with no IAM role). When CDK adopts the full matrix, delete the orphan first.

### 1.5 Deployment + auth + crypto (architecture-plan §2, §5, §9) — verified, strongly matched

- **Option B is the right call and the template is real.** `apps/workspace` is exactly the
  strangler-fig precedent: own ECR repo `capiro/${env}/workspace`, own Fargate task/service, own
  ALB target group + listener rule for `/workspace-api/*` (priority 10) in
  `infra/cdk/lib/compute-stack.ts`, AWS CDK v2. The "copy this to make `apps/meriv2-orchestrator`"
  recipe is concrete (Appendix Y).
- **Auth is fully reusable, do not reimplement (guardrail §9.1 holds).** `TenantContextMiddleware`
  (`apps/api/src/tenant/tenant-context.middleware.ts`), `TenantContextStore` (AsyncLocalStorage),
  `ClerkService.verifySessionToken()` (normalizes Clerk v2 `o.{id,slg,rol}`), and RLS via
  `PrismaService.withTenant()` (sets Postgres GUC `app.current_tenant`). `@capiro/shared` exports
  `TenantContext {tenantId, tenantSlug, userId, clerkUserId, role}`, `TENANT_HEADER`, role helpers.
- **Crypto pattern to mirror for Live Hearing (guardrail §9.3) is pinned:**
  `apps/api/src/common/secret-crypto.ts` (`encryptSecret` → `{ciphertext, iv, authTag}`, AES-256-GCM,
  12-byte IV) and `apps/api/src/engagement/meeting-notes-crypto.service.ts`
  (`MeetingNotesCryptoService.encrypt/decrypt`, `NOTES_ENCRYPTION_KEY`, `keyVersion`). `MeetingDebrief`
  / `MeetingNote` store `bodyCiphertext/iv/authTag/keyVersion`. Live transcript crypto = a new
  injectable that **reuses this exact pattern** with its own env key, no new scheme.

### 1.6 Net effect on the plan

- Phase 0 gets **cheaper on two fronts** (orchestrator core to extract already exists; flags exist)
  and **more expensive on one** (CI has no PR gate to extend — build one). Net: Phase 0 stays the
  critical path but is lower-risk than the plan assumes.
- Phase 1's KG "relocation" is **mostly UI/shell**, since the graph models already exist.
- Phase 2 is **scoped down** to genuine gap sources/capabilities (votes, floor/rules, eCFR/OIRA,
  CBO/JCT, precheck engine).
- Everything else (Phases 3–5, guardrails, SC) stands as written.

---

## 2. Ground rules for the implementing agent

### 2.1 Repo + environment
- Repo root: `C:\Users\neoma\capiro-meri` (branch `main`). Monorepo: pnpm workspaces + turbo.
  Apps: `api`, `web`, `workspace`, `clio-sandbox`. Packages: `shared`.
- Work on a dedicated branch (e.g. `meriv2/phase0`), commit in small logical increments, **never
  push to `main`**, never open an auto-merging PR.
- Verification commands (run from repo root): `pnpm run typecheck`, `pnpm run lint`,
  `pnpm run test`, `pnpm run build`. DB: `pnpm run db:up`, `pnpm run db:migrate`
  (`= pnpm --filter @capiro/api prisma:migrate:dev`).
- New apps/packages are auto-discovered by `pnpm-workspace.yaml` (`apps/*`, `packages/*`, `infra/*`)
  and `turbo.json` — no manifest edits needed beyond the package's own `package.json`.

### 2.2 Definition of done (every task)
- TypeScript strict: no `any`, no `@ts-ignore`. Unit tests for every new module; an integration
  test wherever a boundary is crossed. `typecheck` + `lint` + `test` + `build` all green before a
  task is "done." No TODO/FIXME left in shipped paths.
- Match existing conventions: study `apps/workspace` + `packages/shared` for service/package shape,
  and an existing `runWithSyncRun`-based job (e.g. `sync-congress.ts`) for ingestion shape.

### 2.3 Database rules
- **Additive migrations only.** New tables/columns are fine. **No `ALTER`/`DROP`** on existing
  columns/tables without a GATE sign-off. Run migrations against the **local dev DB only**.
- Public official-source tables are **global (no `tenant_id`)**. Tenant data carries `tenant_id`
  and is RLS-protected; access it through `PrismaService.withTenant()`.

### 2.4 Hard guardrails — require CTO sign-off (GATE)
Reproduced from architecture-plan §9. Do not cross unattended; if a task needs one, stop that
thread, log `NEEDS-APPROVAL`, continue elsewhere.
1. **AUTH** — import/call `@capiro/shared` + `apps/api` tenant-mw / Clerk; never reimplement,
   relax, or fake identity (no synthetic `clerkUserId=pending:<id>`). Clerk v2 `o.{id,slg,rol}`
   stays source of truth.
2. **EMAIL** — `send_email`/`reply_email` route through the existing MS Graph OAuth path; the
   compliance precheck may *gate* them but must not *bypass* OAuth.
3. **CONFIDENTIAL CONTENT / CRYPTO** — debriefs/notes/transcripts stay AES-GCM via the §1.5
   pattern; extracted intel flows to the tenant-members-only KG, never embedded raw. No new scheme.
4. **NO LIVE CUTOVER** — all `meriv2.*` flags ship **OFF**; existing surfaces stay
   byte-for-byte behaviorally unchanged (SC0.2). A human flips the first tenant.
5. **DEPLOY** — you may build/deploy the net-new `apps/meriv2-orchestrator` to `capiro-dev`; you may
   not redeploy/modify `api`/`web`/`workspace`.

### 2.5 Decision log
Maintain `docs/plans/2026-06-30-meriv2-DECISIONS.md`. For each non-trivial judgment call append:
context / options / decision / rationale / reversibility / tag (`DECISION | ASSUMPTION |
NEEDS-APPROVAL | DEVIATION-FROM-PLAN`). Surface `NEEDS-APPROVAL` and `DEVIATION-FROM-PLAN` in the
final report.

---

## 3. Phase 0 — Standalone orchestrator spine (CRITICAL PATH)

Goal: stand up `@capiro/meriv2-core` (importable logic) + `apps/meriv2-orchestrator` (HTTP host at
`/meri-api/*`), prove it deploys and is scope-correct, migrate ONE real tool end-to-end behind an
OFF flag with a green parity harness, promote Claim/Evidence + Compliance to first-class stores, and
land the first CI gates. **Existing surfaces stay untouched.** This phase must hit SC0.1–SC0.7
before any later phase starts.

### P0-T1 — Scaffold `packages/meriv2-core` — NEW (extract from `apps/api/src/meri`)
- **Goal:** a pure, importable package: tool-registry interface, intent-router stub, scoping
  wrapper, grounding/claim-map assembly. Nothing calls it yet.
- **Files to create:** `packages/meriv2-core/package.json` (name `@capiro/meriv2-core`, internal dep
  `@capiro/shared` only), `tsconfig.json`, `src/index.ts`, `src/registry/tool-registry.ts`,
  `src/registry/types.ts`, `src/intent/intent-router.ts`, `src/scoping/scoping-wrapper.ts`,
  `src/grounding/claim-map.ts`, plus a `*.spec.ts` beside each.
- **Interfaces (canonical — see Appendix X):** `ToolHandler<I,O>`, `ToolDefinition`, `ToolRegistry`
  (`register`, `get`, `list`, `invoke(name, input, ctx)`), `MeriContext = { tenantId, userId,
  clerkUserId, role, org }` (mirror `@capiro/shared` `TenantContext`), `ScopingWrapper.enforce(ctx, fn)`.
- **Implementation notes:** extract the *pure* helpers from `apps/api/src/meri` into the package
  where practical (`meri-citations`, `meri-confidence`, `meri-freshness`, `meri-domain-fanout`'s
  `DOMAIN_PRIMER`) — move or re-export, don't fork. The registry handler signature must *require* a
  `MeriContext` argument so "a tool that ignores scope" cannot typecheck.
- **Depends on:** nothing.
- **Done when:** package builds and unit tests pass (`pnpm --filter @capiro/meriv2-core test`);
  nothing imports it in a request path yet (toward SC0.2, SC0.7).

### P0-T2 — Stand up `apps/meriv2-orchestrator` service — NEW (clone `apps/workspace`)
- **Goal:** a thin Nest HTTP service hosting `@capiro/meriv2-core` at `/meri-api/*`, deployable to
  `capiro-dev` Fargate, health endpoint 200.
- **Files to create (clone from `apps/workspace`, see Appendix Y):** under `apps/meriv2-orchestrator/`
  — `package.json` (`@capiro/meriv2-orchestrator`, add dep `@capiro/meriv2-core`), `Dockerfile`,
  `nest-cli.json`, `tsconfig*.json`, `jest.config.cjs`, `src/main.ts` (**`setGlobalPrefix('meri-api')`**,
  port 4300, keep `/health` excluded), `src/app.module.ts`, `src/health/health.controller.ts`,
  `scripts/entrypoint.sh`.
- **Files to modify:** `infra/cdk/lib/config.ts` (+`meriv2OrchestratorCpu/MemoryMib/DesiredCount/MaxCount`),
  `infra/cdk/lib/compute-stack.ts` (ECR repo `capiro/${env}/meriv2-orchestrator`, Fargate task def +
  service, target group on port 4300, listener rule for `/meri-api/*` at an unused priority); new
  `.github/workflows/meriv2-orchestrator-image.yml` (clone `workspace-image.yml`; swap paths,
  Dockerfile, ECR tag, cache scope); `infra/deploy/meriv2-ecr-pull-policy.json` (clone workspace).
- **Auth:** mount the imported `TenantContextMiddleware` + Clerk validation; **do not** reimplement
  (GATE §2.4.1).
- **Depends on:** P0-T1.
- **Done when (SC0.1):** service deploys to `capiro-dev`; **running-task imageDigest == ECR `:latest`
  digest == merge SHA** (record all three); `curl https://<dev-host>/meri-api/health` → 200;
  `api`/`web`/`workspace` untouched (SC0.2).

### P0-T3 — Reuse the feature-flag system; add MeriV2 flags (OFF) — REUSE/EXTEND (corrects C3)
- **Goal:** two per-tenant + per-surface flags, default OFF, governing whether a surface proxies to
  the orchestrator.
- **Files:** reuse `apps/api/src/meri/meri-feature-flags.service.ts` (`MeriFeatureFlagsService.isEnabled`)
  and `apps/api/src/common/tenant-flags.ts`. Add flag keys `meriv2.inEditorAssistant` and
  `meriv2.workspaceGen` to the `clioFeatureFlags` set; add env kill-switch `MERIV2_ENABLED`
  (default false) ANDed in via `tenantFeatureEnabled`.
- **Done when:** `isEnabled(tenant, 'meriv2.inEditorAssistant', false)` is false everywhere by
  default; flipping `settings_jsonb.clioFeatureFlags` to true is read within the 60s cache window
  (unit test) — foundation for SC0.4.

### P0-T4 — Wire the dormant proxy path in both surfaces — EXTEND (behind OFF flag)
- **Goal:** `workspace-assistant` and `apps/workspace` each gain a flag-checked branch: flag OFF →
  today's in-process path (unchanged); flag ON → proxy the request to `meriv2-orchestrator`.
- **Files to modify:** `apps/api/src/workspace-assistant/workspace-assistant.service.ts` (early in
  `run()`); `apps/workspace/src/generation/*` (entry of the generation request). Add a small typed
  `MeriV2OrchestratorClient` (HTTP) to each.
- **Critical:** the OFF branch must be byte-for-byte the existing path. Prove with `git diff` that
  existing logic is *wrapped*, not *edited* (SC0.2).
- **Depends on:** P0-T2, P0-T3.
- **Done when (SC0.2):** with flags OFF, `git diff` shows only additive wrapping; existing
  unit/integration tests for both surfaces stay green.

### P0-T5 — Migrate ONE tool end-to-end: `get_client_context` — NEW (the template)
- **Goal:** prove the whole loop on the lowest-risk real tool. This is architecture-plan PR3 and the
  template every other tool follows.
- **Files:** `packages/meriv2-core/src/tools/client/get-client-context.ts` (implement as a
  `ToolHandler`, register it); orchestrator invokes it with the resolved `MeriContext`. Reuse the
  existing client-context query the `meri` module already uses — do not duplicate SQL.
- **Depends on:** P0-T1, P0-T2.
- **Done when:** a flag-ON request to `/meri-api/*` returns `get_client_context` output scoped to the
  caller's tenant/user; the tool cannot be invoked without a `MeriContext` (toward SC2.1).

### P0-T6 — Parity harness — NEW
- **Goal:** same input → both paths (flag OFF vs ON) → structured diff; the gate before any tenant
  is flagged on.
- **Files:** `packages/meriv2-core/test/parity/` harness + a fixed corpus of **N≥20** representative
  requests per surface (`fixtures/in-editor/*.json`, `fixtures/workspace-gen/*.json`). Diff policy:
  text-identical for deterministic fields; semantic-equivalent (graded) for model output — reuse the
  grading approach in `apps/api/src/meri/evals/`.
- **Depends on:** P0-T4, P0-T5.
- **Done when (SC0.3):** harness runs both paths over the corpus and reports a pass within tolerance;
  exposed as `pnpm --filter @capiro/meriv2-core parity`.

### P0-T7 — First-class Claim/Evidence + Compliance stores — NEW (additive Prisma; corrects warehouses 5/6)
- **Goal:** promote Claim/Evidence and Compliance check records to first-class tables.
- **Files to modify:** `apps/api/prisma/schema.prisma` — add `Claim` (id, tenantId, subjectType,
  subjectId, statement, confidence, freshnessAt, userEdited, originalStatement, artifactId?,
  transcriptSegmentId?), `Evidence` (id, claimId, sourceType, sourceId, url, quote, pageNumber?,
  accessedAt), `ComplianceCheck` (id, tenantId, trigger, decision `PASS|WARN|BLOCK`, reason,
  ruleSource, requiredApproval, actorUserId, entityType, entityId, occurredAt). Then
  `pnpm run db:migrate` to generate an **additive** migration.
- **Depends on:** none (can run parallel to P0-T1).
- **Done when (SC0.5):** migration is additive only (no ALTER/DROP on existing columns); applies clean
  on a prod-shaped DB copy; `Claim`/`Evidence` rows create tenant-scoped and read back via RLS.

### P0-T8 — Standardize the ingestion concurrency guard — EXTEND (corrects §1.4 caveat)
- **Goal:** make "skip if prior run still active" a property of the shared helper, not ad-hoc.
- **Files to modify:** `apps/api/src/ingestion/sync-run.helper.ts` — at the top of `runWithSyncRun`,
  check for an existing `SyncRun{ source, status:'running' }` younger than a TTL and exit 0 if found;
  extend `sync-run.helper.spec.ts`.
- **Done when:** a second concurrent invocation of the same job no-ops; existing helper-based jobs
  still pass. (Prereq for every Phase-2 job to be safe.)

### P0-T9 — Scoping parity test (the SC0.7 gate) — NEW
- **Goal:** prove MeriV2 returns *exactly* what current Meri returns for the same `(user, tenant)`,
  and rejects bad/cross-tenant tokens.
- **Files:** `apps/meriv2-orchestrator/test/scoping-parity.e2e-spec.ts` — for a fixed set of
  `(user, tenant)` pairs, assert the row/entity set from a MeriV2 tool == the set from the equivalent
  `meri`/`workspace-assistant` call; assert 401 on missing/invalid JWT and 403 on cross-tenant token,
  using the **imported** middleware.
- **Depends on:** P0-T2, P0-T5.
- **Done when (SC0.7):** green for every pair (no broadened visibility, no relaxed per-user
  permission) + 401/403 cases pass + code review confirms no auth was reimplemented.

### P0-T10 — CI gates: PR check + leakage/grounding evals — NEW (corrects C5)
- **Goal:** a build that fails on cross-client-leakage or grounding-eval regression.
- **Files to create:** `.github/workflows/ci-pr.yml` (on `pull_request`: `turbo run typecheck lint test`)
  as a required check; `.github/workflows/meriv2-evals.yml` (leakage suite + grounding suite; non-zero
  exit on regression). Seed `packages/meriv2-core/test/evals/leakage/` and `…/grounding/` with ≥1 case
  each, **including one deliberately failing case** used once to prove the gate red, then fixed.
- **Depends on:** P0-T5, P0-T6.
- **Done when (SC0.6):** a PR with a seeded leakage/grounding regression turns the build red; removing
  it turns it green (capture both runs).

### P0-T11 — Demonstrate flag flip + rollback — VERIFY
- **Done when (SC0.4):** for one internal tenant, flipping `meriv2.*` ON routes to the orchestrator and
  flipping OFF restores prior behavior in **< 5s with no redeploy**; capture timestamps/logs.

**Phase 0 exit:** SC0.1–SC0.7 all green with captured evidence. Tag `meriv2-phase0-complete`.

---

## 4. Phase 1 — Alert / KG consolidation

Goal: ONE alert taxonomy across Intel tab + Needs Attention + changes inbox; lift the KG into the
Intelligence Center shell (mostly UI — models already exist per §1.3); make the Freshness/Change
layer the single dedup'd alert source. Depends on Phase 0.

### P1-T1 — Single alert-taxonomy type — NEW (shared module)
- **Goal:** one canonical `Alert` shape backing all three surfaces; no surface defines its own.
- **Files:** add `packages/meriv2-core/src/alerts/alert.ts` defining the seven-field `Alert`
  (whatChanged, whyItMatters, clientId+issueId, whoActs, deadline?, draftArtifactId?, complianceCheckId?)
  + a `SourceType` union. Refactor existing consumers — `apps/api/src/tracker/*`,
  `apps/api/src/intelligence/*`, and the changes-inbox UI in `apps/web` — to import this single type.
- **Done when (SC1.1):** an import-graph check shows all three surfaces import the one type; no local
  alert shape remains (grep for ad-hoc alert interfaces returns none).

### P1-T2 — Seven-field completeness enforcement — EXTEND
- **Goal:** every alert renders all seven fields; missing fields are *flagged*, not dropped.
- **Files:** validation in the alert constructor/factory; surface a "needs-attention: incomplete"
  state in `apps/web` alert components.
- **Done when (SC1.2):** an alert missing a field renders flagged; a unit test asserts no silent drop.

### P1-T3 — Relocate KG into Intelligence Center shell — EXTEND (UI-led; corrects §1.2)
- **Goal:** KG reachable from the Intelligence Center shell, not hard-embedded in client profile.
- **Files:** `apps/web/src/pages/intelligence/` (existing `react-force-graph-3d` view) becomes the
  canonical entry; remove the old embed in the client-profile component (delete, don't duplicate).
  Confirm `MemoryEdge` rows merge FK edges (`relation='fk'`) with wikilink mentions
  (`relation='mention'`) per Appendix A18.
- **Done when (SC1.3):** KG renders from the Intelligence Center; the old client-profile embed is
  removed (grep confirms single mount point).

### P1-T4 — Freshness layer = single dedup'd event source — EXTEND
- **Goal:** one deduplicated change event per tracked source type feeding the taxonomy.
- **Files:** consolidate `IntelligenceChange` emission through `emit-changes`/`emit-bill-alerts`
  (`apps/api/scripts/`), keyed for idempotency so the same underlying change fires once.
- **Done when (SC1.4):** firing the same change twice yields one alert (integration test).

**Phase 1 exit:** SC1.1–SC1.4 green. Tag `meriv2-phase1-complete`.

---

## 5. Phase 2 — Highest-leverage missing capabilities (+ paired ingestion)

Principle (architecture-plan §7.3): **a capability without its source is a stub — build the module
and its `sync-*` job together.** Each capability is a tool bundle on the spine, NOT a new service.
Order: Vote/Whip/Office → Calendar/Floor → Regulatory lifecycle → Compliance precheck → CBO/JCT.

> **Ingestion pattern for every new job in this phase: follow Appendix Z exactly** — a `tsx` script
> using `runWithSyncRun` (with the P0-T8 guard), one `entrypoint.sh` case, one `INGESTION_JOBS` entry
> with the cron from §7.2. Public data is **global (no `tenant_id`)**; only client/issue linkages are
> tenant-scoped.

### P2-T1 — Vote / Whip / Office Targeting — NEW capability + NEW sources (corrects C4: greenfield)
- **Sources (greenfield):** `sync-house-votes` (House Clerk roll-call XML, daily `10 6 * * *`),
  `sync-senate-votes` (Senate.gov XML, daily `12 6 * * *`). New Prisma models: `RollCallVote`,
  `MemberVote` (global), keyed on Bioguide ID + Congress.gov bill ID (Appendix B).
- **Tools (registry):** `search_roll_call_votes`, `analyze_member_vote_history`, `build_whip_count`,
  `score_member_alignment`, `recommend_cosponsor_targets`, `map_committee_gatekeepers`,
  `track_member_public_positions`, `build_member_issue_dossier`, `rank_office_targets`
  (architecture-plan Appendix A3).
- **Done when (SC2.2):** for a real tracked bill, `build_whip_count` + `rank_office_targets` return a
  whip count and office priority list grounded in ingested vote/sponsor rows — **no fabricated
  members** (eval asserts every member resolves to a real Bioguide ID).

### P2-T2 — Congressional Calendar / Floor Monitor — NEW capability + NEW sources
- **Sources (greenfield):** `sync-floor-schedule` (House Majority Leader + Senate floor, daily
  `5 6 * * *`, FULL upsert), `sync-house-rules` (House Rules Committee, daily `8 6 * * *`, FULL upsert).
- **Tools:** `search_floor_schedule`, `search_house_rules_activity`, `search_suspension_calendar`,
  `search_senate_floor_schedule`, `track_committee_notice_changes`, `alert_markup_or_vote_window`,
  `detect_vehicle_opportunity` (Appendix A4).
- **Done when:** "what can move this week" returns floor/markup/amendment-deadline alerts via the
  Phase-1 taxonomy (SC2.1; SC3.2 precursor).

### P2-T3 — Regulatory lifecycle — EXTEND capability + NEW sources
- **Existing sources:** `sync-federal-register`, `sync-regulations` (REUSE). **New (greenfield):**
  `sync-ecfr` (+ derived `diff-ecfr`, weekly Mon `0 4 * * 1`), `sync-reginfo-oira` (weekly Mon
  `30 4 * * 1`), `sync-unified-agenda` (monthly `0 3 5 * *`, FULL upsert).
- **Tools:** `query_regulatory_dockets`, `search_federal_register`, `search_ecfr`, `diff_ecfr_text`,
  `search_unified_agenda`, `search_oira_reviews`, `search_12866_meetings`, `track_comment_deadlines`,
  `summarize_comment_record`, `draft_regulatory_comment`, `compare_final_rule_to_proposed_rule`
  (Appendix A7).
- **Done when:** rule diff + comment-deadline alert produced for a real RIN/docket (SC2.1).

### P2-T4 — Compliance / Ethics / Risk precheck engine — NEW engine (store exists per §1.3)
- **Goal:** the PASS/WARN/BLOCK gate writing to `ComplianceCheck` (P0-T7).
- **Tools:** `compliance_precheck` + `check_lda_thresholds`, `draft_ld2_activity_summary`,
  `check_ld203_obligations`, `gift_travel_rule_check`, `fara_risk_check`,
  `procurement_integrity_check`, `pay_to_play_state_check`, `conflict_check_client_positions`,
  `audit_outbound_contact_log` (Appendix A8). Wire `compliance_precheck` as an **approval-gate hook**
  in front of gated writes (esp. `send_email`/`reply_email` — must gate, never bypass MS Graph OAuth,
  GATE §2.4.2).
- **Done when (SC2.3):** each §3 trigger returns PASS/WARN/BLOCK + reason + rule source + an audit
  record; a BLOCK actually prevents the gated write (integration test on a draft email).

### P2-T5 — Budget Score / Fiscal — NEW capability + NEW sources
- **Sources (greenfield):** `sync-cbo` (weekly Mon `0 5 * * 1`), `sync-jct` (weekly Mon `30 5 * * 1`),
  `sync-treasury-fiscal` (monthly `0 4 10 * *`, FULL upsert).
- **Tools:** `search_cbo_cost_estimates`, `search_jct_revenue_estimates`, `extract_payfors`,
  `compare_budgetary_effects`, `estimate_score_risk`, `map_bill_to_budget_accounts`,
  `search_treasury_fiscal_data`, `search_federal_budget_accounts` (Appendix A11).
- **Done when (SC2.4):** maps a bill to its cost estimate / score-risk note where one exists, and
  returns **"no estimate found"** (not a guess) where none exists (eval covers both).

### P2-T6 — Per-tool grounding eval in the CI gate — EXTEND
- **Done when (SC2.5):** every tool added in Phase 2 ships ≥1 grounding-eval case wired into
  `meriv2-evals.yml`; the suite fails if a tool fabricates an entity.

### Phase 2/3 follow-on sources (build after the five above land)
`sync-sbir-sttr` (weekly Mon `0 6 * * 1`), `sync-fpds` (weekly Mon `0 7 * * 1`), `sync-sam-entity`
(weekly Mon `30 7 * * 1`), `sync-dote` (seasonal, on-artifact), `sync-unfunded-priorities` (seasonal,
on-artifact) — deepen Defense/Procurement (Appendix A9/A10). **Deferred** (architecture-plan §3 DEFER):
`sync-courtlistener`, `sync-doj-press`, `sync-agency-enforcement`, `sync-opensecrets`,
`sync-state-regs`, `sync-state-procurement`, `sync-govinfo-backup`.

**Phase 2 exit:** SC2.1–SC2.5 green; each new job visible in `INGESTION_JOBS` and firing on schedule
in `capiro-dev`. Tag `meriv2-phase2-complete`.

---

## 6. Phase 3 — Command center

Goal: turn capabilities into an operator surface — one issue object, action-oriented monitoring
inbox, claim-store-backed client packets. Depends on Phases 0–2.

### P3-T1 — Unified Issue object — NEW
- **Goal:** an issue carries status + "what changed" + deadlines + office targets + open tasks +
  artifacts from one object.
- **Files:** `Issue` aggregate in `apps/api/prisma/schema.prisma` (additive) linking `TrackedBill`,
  alerts (P1-T1), `EngagementTask`, `ClioArtifact`, and office-target output (P2-T1); render in
  `apps/web` issue dashboard.
- **Done when (SC3.1):** an issue renders all of the above from the single object end-to-end.

### P3-T2 — Path-to-Win planner + amendment/report-language workbench + office-priority scoring — NEW
- **Tools/plan-modes:** `build_office_priority_score`, amendment/report-language drafting via
  Document Generation (Appendix A16), reusing P2-T1 targeting + P2-T3 regulatory.
- **Done when:** a planner produces a ranked path (offices, vehicles, deadlines) for a real issue.

### P3-T3 — Campaign objects + client-ready update packets — NEW (uses claim store)
- **Goal:** generate a client packet from a campaign object where every claim carries source +
  freshness + confidence (uses `Claim`/`Evidence` from P0-T7).
- **Done when (SC3.3):** a generated packet's every claim links to ≥1 `Evidence` row with source +
  `freshnessAt` + confidence; unsupported claims are flagged, not emitted.

### P3-T4 — Monitoring inbox = action-oriented alerts — EXTEND
- **Done when (SC3.2):** the inbox renders the seven-field alerts (P1-T1), never bare "new result
  found" rows.

**Phase 3 exit:** SC3.1–SC3.3 green. Tag `meriv2-phase3-complete`.

---

## 7. Phase 4 — Reliability & enterprise trust

Goal: the full eval/red-team suite as enforced CI thresholds + an artifact-review feedback loop into
the claim store. Builds on the P0-T10 gate. **This is the gate Phase 5 depends on.**

### P4-T1 — Full eval suite — EXTEND
- **Goal:** cover every category: hallucination, stale-source, wrong bill version, wrong
  member/district, missed deadline, unsupported claim, tool-selection accuracy, cross-client leakage,
  compliance false-negative, citation precision, "what changed?" recall (architecture-plan Appendix A19).
- **Files:** `packages/meriv2-core/test/evals/<category>/` datasets; runner in `meriv2-evals.yml`.
- **Done when (SC4.1, SC4.2):** all categories covered; each has a published baseline + a CI threshold
  that fails the build on regression.

### P4-T2 — Cross-client leakage = 0 across the tenant matrix — EXTEND
- **Done when (SC4.3):** leakage test = 0 leaks across the full tenant test matrix (extends P0-T10).

### P4-T3 — Artifact-review feedback loop — NEW
- **Goal:** reviewer edits flow back into the claim store (`Claim.userEdited` set, `originalStatement`
  preserved).
- **Done when (SC4.4):** editing a generated artifact sets the flag and preserves the original
  (integration test).

**Phase 4 exit:** SC4.1–SC4.4 green. Tag `meriv2-phase4-complete`. **Phase 5 may now begin.**

---

## 8. Phase 5 — Live Hearing Intelligence (FINAL — GATED)

> **Do not start Phase 5 until Phases 0, 1, and 4 are complete and tagged.** It depends on the tools +
> claim store (P0), the alert taxonomy + issue dashboard (P1), and the grounding/leakage gates (P4).
> It also touches the confidential-content crypto guardrail (GATE §2.4.3). Build LAST, on a proven spine.

Internal order (architecture-plan §6 Phase 5): session object → Deepgram streaming → segment store →
live transcript UI → entity extraction → key-quote capture → action-item extraction → post-hearing
summary → issue-dashboard update → claim map with transcript timestamps.

### P5-T1 — `LiveHearingSession` + `TranscriptSegment` Prisma models — NEW (tenant-scoped from row one)
- **Files:** `apps/api/prisma/schema.prisma` (additive). `LiveHearingSession` and `TranscriptSegment`
  exactly per architecture-plan §4.2 (incl. `consent_status`, `recording_policy`, `claim_map_id?`).
- **Done when:** models migrate additively; both carry `tenant_id` and are RLS-scoped.

### P5-T2 — Live Hearing worker service — NEW (clone the `apps/workspace`/orchestrator pattern)
- **Goal:** the only genuine second runtime — WebSocket audio, low-latency interim/final, reconnect,
  stateful. Own service/ECR/Fargate (Appendix Y), deps `@capiro/shared` + `@capiro/meriv2-core`.
- **Done when (SC5.1):** the worker calls registry tools and reimplements NO reasoning (code review).

### P5-T3 — Deepgram streaming + live transcript UI — NEW
- **Division of labor (architecture-plan §4.1):** Deepgram = STT only (interim→final, endpointing,
  diarization, timestamps, reconnect). Orchestrator = all policy-side reasoning.
- **UI:** Live Hearing Room (architecture-plan §4.5): LEFT transcript / CENTER summary cards / RIGHT
  relevance+quotes+actions / BOTTOM timeline.
- **Done when (SC5.2):** browser-mic audio streams to Deepgram; interim then final segments render with
  **< 2s perceived caption latency**. (SC5.9) a forced WebSocket drop reconnects and resumes committing
  final segments without losing prior committed transcript.

### P5-T4 — `recording_policy` enforced at the storage layer — NEW (GATE §2.4.3)
- **Done when (SC5.3):** `no_storage` persists nothing; `transcript_only` persists no audio;
  `audio_and_transcript` persists both — verified by DB + object-store inspection, **not UI**.

### P5-T5 — Transcript crypto mirrors debriefs — NEW (GATE §2.4.3; reuse §1.5 pattern)
- **Files:** a new injectable mirroring `MeetingNotesCryptoService` (AES-256-GCM, 12-byte IV,
  `keyVersion`, own env key) — **no new scheme**.
- **Done when (SC5.4):** client-relevant segments are AES-GCM encrypted at rest using the same pattern
  as `meeting_debriefs` (code-review sign-off).

### P5-T6 — Extraction reusing Phase-0 tools + KG/claim/alert wiring — NEW
- **Streaming tools (registry):** the 18 tools in architecture-plan §4.4 (`create_live_hearing_session`
  … `draft_hearing_followup_email`).
- **Done when:** SC5.5 extracted intel flows to the tenant-members-only KG, never embedded raw (leakage
  test on hearing data = 0); SC5.6 each saved quote/claim points to a `TranscriptSegment` id + timestamp;
  SC5.7 post-hearing, the **chat surface** answers "pull every quote on `<topic>`" against the finished
  session using the SAME registry tools; SC5.8 a captured quote raises an alert through the Phase-1
  taxonomy (no separate live-hearing silo).

**Phase 5 exit:** SC5.1–SC5.9 green. Tag `meriv2-phase5-complete`.

---

## 9. Success-criteria traceability matrix

Each SC (architecture-plan §6) → owning task → how to verify. "Verify" is the runnable/observable
proof an agent must capture as evidence.

| SC | Task | Verify |
|---|---|---|
| SC0.1 deploy + digest match + health 200 | P0-T2 | record running-task imageDigest, ECR `:latest` digest, merge SHA (equal); `curl …/meri-api/health` → 200 |
| SC0.2 existing surfaces unchanged, flags OFF | P0-T4 | `git diff` shows only additive wrapping in `workspace-assistant.service.ts` + `apps/workspace`; their tests green |
| SC0.3 parity harness | P0-T6 | `pnpm --filter @capiro/meriv2-core parity` passes on N≥20/ surface |
| SC0.4 flag flip rollback < 5s | P0-T11 | timestamped log of ON→OFF restoring behavior, no redeploy |
| SC0.5 additive migrations | P0-T7 | migration SQL has no ALTER/DROP on existing columns; `db:migrate` clean on prod-shaped copy |
| SC0.6 CI fails on leakage/grounding regression | P0-T10 | red build on seeded regression, green after fix (both captured) |
| SC0.7 scoping parity + 401/403 | P0-T9 | `scoping-parity.e2e-spec.ts` green for all `(user,tenant)` pairs; 401/403 cases pass; review = no auth reimplemented |
| SC1.1 one alert type | P1-T1 | import-graph shows single type; no local alert shapes |
| SC1.2 seven fields or flagged | P1-T2 | incomplete alert renders flagged; no silent drop (test) |
| SC1.3 KG relocated | P1-T3 | KG mounts from Intelligence Center; old embed removed (grep) |
| SC1.4 dedup change events | P1-T4 | same change twice → one alert (test) |
| SC2.1 capability registered + scoped | P2-T1…T5 | each tool callable through orchestrator with tenant scope enforced |
| SC2.2 whip count grounded | P2-T1 | whip count + office list for a real bill; every member resolves to a real Bioguide ID |
| SC2.3 precheck PASS/WARN/BLOCK + BLOCK prevents write | P2-T4 | BLOCK on a draft email actually prevents send; audit row written |
| SC2.4 fiscal estimate or "no estimate found" | P2-T5 | eval covers both the present-estimate and absent-estimate cases |
| SC2.5 per-tool grounding eval | P2-T6 | each Phase-2 tool has ≥1 case in `meriv2-evals.yml` |
| SC3.1 end-to-end issue | P3-T1 | one issue renders status/changes/deadlines/targets/tasks/artifacts |
| SC3.2 action-oriented inbox | P3-T4 | inbox rows are seven-field alerts, not "new result found" |
| SC3.3 claim-backed packet | P3-T3 | every claim in a packet links to Evidence(source+freshness+confidence) |
| SC4.1/4.2 eval coverage + thresholds | P4-T1 | all categories present; baselines + CI thresholds enforced |
| SC4.3 zero leakage | P4-T2 | leakage = 0 across tenant matrix |
| SC4.4 review feedback loop | P4-T3 | edit sets `userEdited`, preserves `originalStatement` |
| SC5.1 worker reuses registry | P5-T2 | code review: no reasoning reimplemented |
| SC5.2 live latency < 2s | P5-T3 | measured caption latency interim→final |
| SC5.3 recording_policy at storage | P5-T4 | DB + object-store inspection per policy |
| SC5.4 transcript crypto = debrief pattern | P5-T5 | code-review sign-off; AES-256-GCM reuse |
| SC5.5 KG flow, leakage 0 | P5-T6 | hearing-data leakage test = 0 |
| SC5.6 quote→segment+timestamp | P5-T6 | each saved quote references a `TranscriptSegment` id + ms |
| SC5.7 chat answers over finished session | P5-T6 | "pull every quote on X" uses the same registry tools |
| SC5.8 hearing alert via Phase-1 taxonomy | P5-T6 | captured quote raises a seven-field alert |
| SC5.9 reconnect resilience | P5-T3 | forced WS drop resumes without losing committed transcript |

---

## 10. Cross-cutting concerns

- **Auth/scoping (every task that reads tenant data).** Resolve `MeriContext` from the imported
  `TenantContextMiddleware` + `ClerkService`; access tenant rows only via `PrismaService.withTenant()`.
  Public official-source tables are global — read directly, never per-tenant them.
- **Migrations.** Additive only without a GATE. Generate via `pnpm run db:migrate`; review the SQL
  diff before commit. New public-source tables: no `tenant_id`. New private tables: `tenant_id` + RLS.
- **Ingestion (every new job).** Appendix Z. `runWithSyncRun` + the P0-T8 guard; correct tier/cron from
  §7.2; opt the new table into `embed-backfill` only if it needs vector search.
- **Entity normalization (KG).** Resolve on canonical IDs (architecture-plan Appendix B: Bioguide,
  Congress.gov bill ID, committee ID, CIK, UEI, CAGE, RIN, docket ID, award ID, FAIN, NAICS/PSC, PE ID,
  internal client/contact ID, hearing-session/transcript-segment ID). A new entity without its
  canonical ID is a flag, not a silent dual-write.
- **Bill Tracker ↔ Hearing Watch (architecture-plan Appendix E).** Do NOT build Hearing Watch / Live
  Hearing with its own change-detection + alerting. Register its events INTO the existing
  `apps/api/src/tracker/tracker-change-detector.service.ts` → `emit-changes` → the one §8 taxonomy.
  The bill↔hearing cross-link is a KG edge on canonical IDs, not a string match.
- **Email (GATE §2.4.2).** `send_email`/`reply_email` always go through the existing MS Graph OAuth
  path; the precheck gates, never bypasses. Strict client-scoped context only; never leak
  coworker/other-attendee domains in TO/CC.

---

## Appendix X — Tool-registry interface (canonical sketch)

```ts
// packages/meriv2-core/src/registry/types.ts
export interface MeriContext {           // mirrors @capiro/shared TenantContext
  tenantId: string; userId: string; clerkUserId: string;
  role: TenantRole; org?: { id: string; slug: string; role: string };
}
export interface ToolDefinition<I, O> {
  name: string;                          // canonical handle, e.g. 'get_client_context'
  inputSchema: ZodSchema<I>;             // validated before handler runs
  handler: (input: I, ctx: MeriContext) => Promise<O>;  // ctx REQUIRED — scope cannot be ignored
  readOnly: boolean;                     // write tools route through the approval-gate hook
}
export interface ToolRegistry {
  register<I, O>(def: ToolDefinition<I, O>): void;
  get(name: string): ToolDefinition<unknown, unknown> | undefined;
  list(): string[];
  invoke<O>(name: string, input: unknown, ctx: MeriContext): Promise<O>;  // enforces scoping + gate
}
```

`invoke` always runs the scoping wrapper and, for `readOnly:false`, the `compliance_precheck`
approval-gate hook (P2-T4) before the handler. A handler that does not filter on `ctx` is a bug.

## Appendix Y — Cloning `apps/workspace` → a new service (verified recipe)

To stand up `apps/meriv2-orchestrator` (P0-T2) and later the Live Hearing worker (P5-T2):

1. **App files (copy + edit):** copy `apps/workspace/{Dockerfile,nest-cli.json,tsconfig*.json,jest.config.cjs,package.json,scripts/entrypoint.sh,src/main.ts,src/health/*}`. In `package.json` set the new name + add `@capiro/meriv2-core`. In `src/main.ts` set `setGlobalPrefix('meri-api')` and the port (4300). Keep `/health` excluded.
2. **Infra (`infra/cdk/`, AWS CDK v2):** in `lib/config.ts` add `meriv2Orchestrator{Cpu,MemoryMib,DesiredCount,MaxCount}`. In `lib/compute-stack.ts` duplicate the workspace blocks: ECR repo `capiro/${env}/meriv2-orchestrator`, `FargateTaskDefinition`, `FargateService`, `ApplicationTargetGroup` (port 4300, health `/health`), and a listener rule `pathPatterns(['/meri-api/*'])` at an unused priority. (`bin/capiro.ts` needs no change.)
3. **CI:** create `.github/workflows/meriv2-orchestrator-image.yml` by cloning `workspace-image.yml` — swap the Dockerfile path, trigger paths (`apps/meriv2-orchestrator/**`, `packages/shared/**`, `packages/meriv2-core/**`, `pnpm-lock.yaml`), ECR tag, and cache scope.
4. **Deploy proof (SC0.1):** push image; `cdk deploy` the compute stack to `capiro-dev`; confirm running-task imageDigest == ECR `:latest` == merge SHA; `curl …/meri-api/health` → 200.

`pnpm-workspace.yaml` / `turbo.json` need no edits — `apps/*` is auto-discovered.

## Appendix Z — Adding a new `sync-*` job (verified recipe)

For every Phase-2 source. Mirrors the existing helper-based jobs (e.g. `sync-congress.ts`):

1. **Script:** `apps/api/scripts/sync-<name>.ts` using `runWithSyncRun(prisma, 'sync-<name>', async (ctx) => { /* fetch since ctx.sinceDate; upsert; */ return { inserted, updated, skipped, errors }; })`. The P0-T8 guard (skip if a `running` run exists) lives in the helper.
2. **Dispatch:** add one case to `apps/api/scripts/entrypoint.sh`: `sync-<name>) exec ./node_modules/.bin/tsx scripts/sync-<name>.ts ;;`.
3. **Schedule:** add one object to `INGESTION_JOBS` in `infra/cdk/lib/ingestion-schedule.ts` — `{ id, command: ['sync-<name>'], cron: {…from §7.2…}, tier, description }`. The `ScheduledIngestionJobs` construct wires the EventBridge rule automatically.
4. **Models:** additive Prisma tables, **global (no `tenant_id`)** for public data; client/issue linkages stay tenant-scoped (mirror `ClientIntelMapping`/`TrackedBill`).
5. **Embeddings (optional):** if the source needs vector search, add its table to the `embed-backfill` source list (content-hash idempotent).
6. **Verify:** run the script locally against the dev DB; confirm a `SyncRun` row with correct counts; confirm `cdk synth` shows the new rule.

---

*End of plan. Companion kickoff prompt: `2026-06-30-meriv2-agent-handoff-prompt.md`.*
