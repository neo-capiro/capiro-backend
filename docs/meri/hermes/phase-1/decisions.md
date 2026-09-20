# Phase 1 decision record — recovered decisions, configuration, enabled capabilities, pilot limits

Prepared 2026-09-19 as part of the Phase 0/1 closeout. **Purpose: stop re-asking settled questions.** Every row states its provenance honestly — an explicit user choice, an adoption-by-non-objection of a stated recommendation, or a value inherited from Phase 0 configuration. Where something is genuinely still unresolved it is listed in §6, not disguised as a decision.

Tested implementation revision for everything referenced here: branch `feat/meri-hermes-phase-0`, see `closeout-report.md` for the exact commit each check ran against.

## 1. Settled decisions

| # | Decision | Value | Provenance | Affects |
|---|---|---|---|---|
| D1 | Model credential shape | **Platform key via the `custom` provider** (the Phase 0 default), not a per-tenant budget-capped key. Revisit when a second, externally-billed pilot tenant exists. | Recommendation stated to the product owner on 2026-09-19 with "I'll proceed on defaults 1, 2 and 4 unless you want different values"; no objection, and work was explicitly directed to continue. **Adopted by non-objection, not an explicit confirmation.** | Worker env (`pilot-configuration.md` §3), ticket #2 provisioning |
| D2 | Warm capacity / idle grace | **No standing warm pool.** Idle grace **10 minutes** after the last activity on a scope, teardown gated on no active run. | Same as D1 (adopted by non-objection). 10 min chosen from the 5–10 min range stated. | Ticket #2 lifecycle, cost envelope |
| D3 | Designated pilot identities | **Neo Martinez (`neo@capiro.ai`)** and **Jordan Clayton (`jordan@capiro.ai`)**, separate private scopes, tenant `capiro-internal`. | **Explicit** user answer, 2026-09-19 ("for three. neo@capiro.ai and jordan@capiro.ai", then "full names are Neo Martinez and Jordan Clayton"). | Deployment validation only; local tests use synthetic identities |
| D4 | Native command approvals | **Exposed to pilot users.** `HERMES_EXEC_ASK=1`; the UI offers exactly **Run once / Deny** and never Hermes's `always` / `session` choices. | **Explicit** user answer to a direct question on 2026-09-19 ("Expose native command approvals too"). | Ticket #5 UI, worker env |
| D5 | Approval retention window | Hermes's own **`approvals.timeout` default, 300 s.** The pending interaction carries `expiresAt`; an expired approval is shown as expired and is not answerable. | Recommendation adopted by non-objection (D1 provenance). | Ticket #5 UI, broker |
| D6 | Default models | Turns: **`gpt-5.6-terra`**. Auxiliary (background review/compression, when enabled): **`gpt-5.6-luna`**. Region `us-east-1`, no stated residency constraint. | `pilot-configuration.md` §4 recommendation, derived from the platform's already-approved OpenAI standardisation; adopted by non-objection. | Worker config |
| D7 | Tenant persona ownership | For Phase 1 the tenant persona is **Meri-owned and rendered on every worker start** from `MERI_SOUL_B64` (fix from Phase 0 D3a). A persona settings UI, versioning and agent-proposed persona diffs are **Phase 2B**, not Phase 1. | Phase 0 D3a fix + explicit Phase 2B assignment in this closeout (`checks-report.md` C3). | Worker entrypoint; 2B backlog |
| D8 | Cloud/AWS scope for this closeout | **No live AWS changes.** Prepare a concrete validation + rollback package only. Do not activate the pilot, do not modify shared production resources, do not apply migrations to a deployed environment. | **Explicit and superseding.** An earlier 2026-09-19 answer selected "also actually provision AWS resources"; the product owner then explicitly narrowed it ("Do not modify live AWS resources, apply production migrations, or enable the pilot flag. capiro-dev serves production; there is no verified separate staging environment"), and the closeout handoff repeats it. **The earlier broader approval is superseded and must not be reused.** | Tickets #2/#3, deployment package |

## 2. Configuration values (names, not secrets)

API side (`pilot-configuration.md` §2): `MERI_HERMES_ENABLED`, `MERI_HERMES_PILOT_TENANT_IDS`, per-tenant flag `meri.hermesRuntime`, `MERI_HERMES_RUNTIME_URL`, `MERI_HERMES_API_KEY`, `MERI_HERMES_BROKER_SIGNING_KEY` (≥32 chars, **never** `INTERNAL_SERVICE_SECRET`), `MERI_HERMES_MODEL`, `MERI_HERMES_RUN_MAX_WALL_MS`, build-identity vars.

Worker side (`pilot-configuration.md` §3): `API_SERVER_KEY`, `MERI_BROKER_URL`, `MERI_WORKER_TOKEN` (scope-bound, ≤12 h), `MERI_EXECUTION_SCOPE_ID`, model credential, `MERI_SOUL_B64`, `HERMES_EXEC_ASK=1`. The worker never receives `INTERNAL_SERVICE_SECRET`, `DATABASE_URL`, Clerk keys or connector OAuth material.

Gate state everywhere today: **all three keys closed.** No deployed environment has been changed.

## 3. Capabilities enabled for the pilot

**Enabled:** agent loop and multi-step tool use; streamed text and public tool progress; native terminal execution **behind the approval gate** (D4); native file read for attachment ingestion; clarification (durable continuation adapter); artifact publication and authorized download; governed institutional-memory recall and *proposal*; stop / detach / reconnect; per-call broker re-authorization and revocation fencing.

**Explicitly disabled or not wired for Phase 1** (each with its real milestone, so none is silently dropped): background review / automatic skill learning, skill registry, curator, staged skill approval, persona settings UI — **2B**. MCP connectors, indexed mail, reused native Meri tools, comprehensive data gateway — **2 / 2A**. Delegation and subagents, browser automation, media, Bot Mode specialists, goals / heartbeat / cron wake, kanban — **5 / 5A**. Steering: the endpoint exists and is wired server-side; the UI must state the capability explicitly rather than silently omitting it (see `closeout-report.md`).

**Required verification, not assumption:** because background review is *disabled* for Phase 1, the closeout must positively verify it is off rather than merely not observed — an idle timer must never be able to discard enabled unfinished work.

## 4. Declared pilot envelope (limits declared *before* the acceptance run)

These are **declarations to be enforced and tested**, not measurements, and not inferred from AWS quota or local timings. Measured values appear in `validation-evidence.md`.

| Control | Declared pilot limit | Expected behavior at the limit |
|---|---|---|
| Concurrent Hermes runs, global | 8 | Queue, bounded; oldest-waiting first |
| Concurrent runs per tenant | 4 | Queue with visible queued state |
| Concurrent runs per execution scope | 2 | Queue; one active run per *conversation* is a hard invariant (DB-enforced) |
| Queue depth per tenant | 8 | Beyond this, reject admission with an actionable conflict, never silently drop |
| Per-run tool calls | 40 | Broker refuses further tool admission (`tool_budget_exhausted`) |
| Per-run output tokens | 8 000 | Run ends; partial result reported honestly |
| Per-run wall clock | 600 s (`MERI_HERMES_RUN_MAX_WALL_MS`) | Stop requested; terminal state `expired` |
| Per-run total tokens (in+out), all call paths | 50 000 | Reserved atomically at admission; retries/compression/children draw from the same parent reservation |
| Per-tenant tokens per day | 2 000 000 | New admissions refused with an actionable message; in-flight runs finish |
| Per-tenant spend per day | USD 25 | Same as above; hard stop, not advisory |
| Hermes-attributable DB connections | ≤ 20 % of the API pool | Application headroom preserved; bounded query/result sizes with pagination |
| Warm capacity | 0 workers | Cold start on first use; idle grace 10 min (D2) |

Scope of the pilot itself: **1 tenant, 2 designated users, private scopes only.** 25 / 100 / 500-scope benchmarks are later hardening and are explicitly *not* claimed.

## 5. Identity validation status

| Item | Status |
|---|---|
| Canonical tenant id `17b63099-bc0f-4ac5-b596-496161e9481e` for `capiro-internal` | Recorded in Phase 0 from an authorized read-only lookup. **Must be revalidated in the target environment before activation** — not revalidated in this closeout (no environment access was exercised). |
| Application user ids for `neo@capiro.ai` / `jordan@capiro.ai` | **Not resolved.** Deliberately deferred to environment validation via an authorized read-only lookup. Local tests use explicit synthetic identities and never these accounts. |
| Clerk organization `org_3DB7EKoeKfF8ZLu6cW4d9Vn6CT0` | Recorded in Phase 0; revalidate with the tenant id. |

## 6. Genuinely open (not decisions anyone has made yet)

1. **An authorized isolated validation environment.** No isolated staging environment has been verified to exist; `capiro-dev` is production. Every cloud gate depends on this. The concrete ask is in `deployment-validation-and-rollback.md`.
2. **Per-tenant spend/token ceilings for anything beyond the pilot envelope** in §4 — the pilot numbers are deliberately small and are not a launch capacity statement.
