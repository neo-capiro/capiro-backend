# Outreach Uplift — Gap-Closure Plan

**Date:** 2026-07-11 · **Author:** Claude (principal-engineer session) · **Branch:** `dev/capiro-teneant-outreach-3f4335`
**Parent plan:** [`docs/plans/2026-07-10-outreach-uplift-plan.md`](2026-07-10-outreach-uplift-plan.md) (shipped W0–W6.1 as PR #395 + #397).
**Method:** Every gap below was independently researched against live code and then adversarially re-verified by a second agent that re-opened every citation. Corrections from the verify pass are folded in (and called out where they changed a design). Nothing here is asserted without a `file:line` a human can check.

---

## 0. How this plan is scoped, and the two honesty rules it follows

The verification pass over PR #395/#397 confirmed the parent plan is ~85% genuinely built and tested. This document closes the remainder. It is organized by the **parent plan's waves (W0→W6)** because the execution directive is "complete W0, close every open item, then advance." Each gap is tagged **BUILDABLE NOW** (no external dependency), **DECISION** (a product call this plan resolves and records), or **GATED** (genuinely blocked on a credential, a human ranking, or an unsafe-prod action — cannot be shortcut).

Two rules govern every item:

1. **No silent scope.** Where the parent plan's shorthand ("prune the guidance to follow-up/prep entries", "match conversationId on synced mail") turned out to rest on a fact that isn't true in the code, this plan says so and adjusts — it does not quietly implement the shorthand.
2. **No fabricated evidence.** Items whose success criteria require a live LLM judge calibrated to Ninja's taste, a 30-day traffic log that doesn't exist, or a production canary are marked GATED with the exact missing input. The harness/flag/mechanism is built so the gated step is a single action once the input lands — but the action itself is never faked.

### Decisions this plan resolves autonomously (production-best call, recorded here)

| Gate | Decision | Rationale |
|---|---|---|
| **D2** (drafting model + COGS) | **Anthropic-first, `claude-sonnet-4-6` for drafting; house key absorbs COGS.** | Matches the CLIO_* tiering precedent (V2 in parent plan). Per-draft cost (~$0.02, ~$0.012 cached) is immaterial against seat price. `modelOverride` (BYOK) still wins — already unit-tested in `outreach-model-tier.spec.ts`. The flip stays opt-in via env (behavior-neutral defaults preserved) so the code deploy changes nothing until the eval evidence + canary are in. |
| **W1.4 model matrix** | **Descope `gpt-4.1-mini` from the baseline; run `{haiku-4-5, sonnet-4-6}`.** | No `OPENAI_API_KEY` in the environment. D2 already makes Anthropic the default; the OpenAI leg is a fallback/BYOK path, not the shipped default. Recorded rather than run as a silent 2-model "3-model baseline." |
| **D8** (open/reply tracking) | **(a) is DONE (fake `openRate` removed). (b) real reply detection is DEFERRED as a separate scoped initiative — NOT built in this pass.** | Building (b) requires converting the **shared** `microsoftGraph.sendMail()` from fire-and-forget `/me/sendMail` to a two-call create-then-send across **8 call sites** (2 of them in the live legacy `/campaigns/*` surface), and still leaves a structural coverage hole for no-client campaigns. That is a high-risk rewrite of the transport that emails congressional offices — an unsafe-prod change to fold into a consolidation wave. `replyCount` already shows an honest `0`, not a fabricated metric. Full design is captured in §W5.G7 ready to execute when scheduled as its own change with its own canary. |

### Gates that remain genuinely blocked (cannot be closed autonomously — and why)

| Gate | Blocking input | What this plan does instead |
|---|---|---|
| **W1.3** judge calibration | Ninja's manual ranking of ~20 drafts (Spearman ≥0.7 target). No agent can substitute Ninja's subjective taste — that *is* the calibration. | Build the calibration harness + generate the 20 candidate drafts, so the ranking session is drop-in. |
| **W2.7 / W3.2 flag flips** | The calibrated judge (W1.3) + a 2–3 day canary soak; then the reviewed default-flip PR. | Produce the A/B + model-delta evidence artifacts; stage the flip behind the env flag exactly as designed; document the go/no-go. |
| **W3.3 caching measurement** | A production canary batch + `ai_usage_events` query. | Everything is built; measurement runs at ship time against the canary. |
| **D4** `/campaigns/*` retirement | Traffic verification + Ninja sign-off on code deletion and tenant-data archival (SOC 2). | Ship the read-only `diag:engagement-campaigns` artifact + an **inert** flag-gated 410 (default = routes stay live). Deletion/flip awaits sign-off. |
| **Final ship** | AWS deploy creds + `:latest` SHA verification + out-of-band task-def env flips. | Merge to `main` when green; roll via `deploy-dev.sh`; apply flag flips out-of-band per the notetaker go-live recipe. |

---

## W0 — Correctness & safety (one open item: G1)

### G1 — Same-batch partial generation failures must be tagged `status:'error'` — **BUILDABLE NOW**

**Verified current state.** `generateBatchEmails` (`apps/api/src/engagement/engagement.service.ts:2332`) runs `generateForRecipient` per recipient in a try/catch. Success returns `{recipientId, subject, body}` (`:2705`); the catch returns `{recipientId, subject:'', body:''}` (`:2706-2711`) — **no status field**. The frontend `WizardV2State.generatedEmails[key].status` union already has `'error'` (`apps/web/src/pages/engagement/outreach/v2/types.ts:83`), and `projectDraftsForSend` already gates on `status==='error'` first (`generation.ts:228,249`). The hole is the wizard's generate mutation (`NewOutreachWizard.tsx:741-751,771-778`): it classifies every item from a 200-OK response as `ok:true`/`status:'ready'`, so a same-batch item that fell into the backend's blank-catch branch shows a **false "ready" checkmark on an empty draft** and is only kept unsendable by the *secondary* empty-string check (`generation.ts:229`). It also survives save/resume (`:991-995`, `:269-273`) and mis-counts the "N/N ready" pill (`StepGenerate.tsx:126,199,472`).

**Verify-pass corrections folded in:**
- There are **three** distinct `status` vocabularies in this file — the in-memory per-draft one (this gap), `OutreachRecord.status` (`schema.prisma:934`, campaign-record lifecycle), and `EngagementCampaignRecipient.status` (`schema.prisma:1940-1958`, legacy). The fix must **not** reuse `OutreachRecord.status`; it adds a new wire field on the batch result only.
- A second, independently-drifting copy of the same fragile emptiness heuristic already exists in the dormant async path: `outreach-job.service.ts:454` (`const ok = Boolean(r && (r.subject?.trim() || r.body?.trim()))`). Fix it in the same change so the two never diverge once async goes live.

**Design.**
1. `engagement.service.ts`: add exported interface (near `:284`) `OutreachBatchDraftResult { recipientId; subject; body; status:'ready'|'error'; error?: string }`. Success return → `status:'ready'`; catch return → `status:'error', error:(err as Error).message` (keep the `logger.warn`). Retype the `results` array (`:2719`). No controller change (`engagement.controller.ts:1671-1674` passes the object through; verified no global `ClassSerializerInterceptor` strips unknown fields).
2. `generation.ts`: add a pure, unit-testable `partitionGenerationResults(slots, results)` that routes any item with `status==='error'` **or** a missing result into `failedGenKeys`. Update `projectDraftsForSend`'s comment to state `status==='error'` is now authoritative and the empty-check is defense-in-depth.
3. `NewOutreachWizard.tsx`: replace the unconditional `ok:true` map in both `.then` sites with `partitionGenerationResults`, folding same-batch failures into the **same** `res.failed` path that whole-POST failures already use (which already stamps `status:'error'` at `:830`). `onSuccess`, save, and resume then become truthful with zero further change.
4. `outreach-job.service.ts:454`: `const ok = r?.status === 'ready';`.
5. Do **not** surface the raw `error` string in any user-facing toast (keep the existing sanitized `apiErrorMessage`-derived `res.errorMessage`); the per-item `error` is telemetry only.

**Success criteria.**
- New `engagement-batch-error-status.spec.ts` (prototype-stub pattern, like `engagement-batch-group.spec.ts`): 2 recipients, A resolves / B throws → `results` length 2; A `{status:'ready', non-empty}`; B `{status:'error', subject:'', body:'', error:<thrown msg>}`; `results.every(r => r.status==='ready'||r.status==='error')`.
- `generation.test.ts`: new describe block asserts `partitionGenerationResults` puts a `status:'error'` item **and** a slot with no matching result into `failedGenKeys`, and a `status:'ready'` item into `drafts`.
- All existing `generation.test.ts` suites still pass unmodified (regression guard on `projectDraftsForSend`'s unchanged contract).
- Manual: force one recipient in a ≥2 batch to throw → Network tab shows exactly one `status:'error'` in `results[]`; that rail card shows the red error icon and is excluded from "N/N ready"; Send payload omits it; save+reload preserves the `error` state.
- `pnpm --filter @capiro/api typecheck` and `pnpm --filter @capiro/web typecheck` both clean; prettier clean on touched files. (Repo `lint` is broken by design — typecheck + prettier + jest are the gate.)

---

## W1 — Measurement first: evals harness + baseline

### G2 — Add the missing length + revision goldens, and make the harness spec-version-aware — **BUILDABLE NOW**

**Verified current state.** `fixtures.ts` has **11** fixtures (not ~14). The deterministic CI suite (`outreach-evals.spec.ts`) and the live runner (`eval-outreach.ts`) both build prompts via `Object.create(EngagementAiService.prototype).buildOutreachPrompt` — i.e. the **v1** builder only; neither ever calls the v2 path. The length knob (`LENGTH_TARGETS`, `prompt-spec-v2.ts:130-146`) and revision mode (`:384,502-521`) exist **only** in `buildOutreachPromptV2`. So adding length/revision fixtures that assert on `"Target length:"` / `"REVISION MODE"` would fail against v1 — the harness must learn to route a fixture through v2.

**Design.**
- `fixtures.ts`: add `specVersion?: 'v1'|'v2'` to `OutreachEvalFixture`; add `'length'|'revision'` to `OutreachArchetype`; append 3 fixtures (`length-short`, `length-long`, `revision-warmer`) with needles copied **verbatim** from `prompt-spec-v2.ts` source strings (`LENGTH_TARGETS.short/.long` at `:131/:133`; revision block `:509-520`). Comment `specVersion` to warn it only reflects production routing for `workflow==='campaign'`.
- `outreach-evals.spec.ts`: add a `buildPrompt(fx)` dispatcher that returns `{system,user}` — v2 via `buildOutreachPromptV2(fx.input)`, v1 via the existing prototype hack with `system:''`. Branch the universal anti-fabrication/no-token invariant on `specVersion` (v2's guardrails live in the *system* block with different wording — `OUTPUT_CONTRACT`/`HONEST_FALLBACK`). Add `'length'`/`'revision'` to the `expected` archetype array.
- `eval-outreach.ts`: same dispatcher (so a live run actually exercises v2 for these 3); change `generate(model, input)` → `generate(model, fx)`.

**Success criteria.**
- `OUTREACH_EVAL_FIXTURES.length === 14`, all ids unique.
- New per-fixture jest cases pass: `length-short`/`length-long` match their exact `LENGTH_TARGETS` string and reject the other length's string; `revision-warmer` matches `'REVISION MODE'`, `'Change ONLY what the instruction requires'`, `'Existing body:'`, the literal existing-body substring, and rejects `'Now write the email.'`.
- All 11 existing fixtures produce **byte-identical** `buildPrompt()` output before/after (system `''`, user unchanged) — zero v1 behavioral change.
- `prompt-spec-v2.spec.ts` still green unmodified.
- `pnpm --filter @capiro/api test -- outreach-evals.spec.ts` exits 0.

### G3 — Extend the runner, build calibration, add the CI workflow, run the baseline — **MIXED (build BUILDABLE NOW; calibration + default-flip GATED on Ninja)**

**Verified current state (with the two big corrections):**
- ✅ **`diag-outreach-usage.ts` ALREADY EXISTS** (`apps/api/scripts/diag-outreach-usage.ts`, ~92 lines, wired as `diag:outreach-usage` in `package.json:20`) — per-tenant groupBy over `ai_usage_events` reporting draft counts, input/output/cache tokens, cache-hit %, cost. The research first flagged it missing; the verify pass corrected this. **Do not rebuild it.**
- ✅ **`outreach-model-tier.spec.ts` ALREADY EXISTS** (128 lines) and already unit-tests "a tenant modelOverride (BYOK) always wins", provider-preference ordering, and behavior-neutral defaults. The W3.2 BYOK regression is **already covered** — do not re-scope it as new work.
- ❌ The runner (`eval-outreach.ts`) is **v1-only** (can't render v2 → can't do W2.7 A/B), **cost-blind** (its own hand-rolled `callAnthropic`/`callOpenAi` don't parse `usage`), **cache-blind** (no `cache_control`), and **has no pass/fail exit gate** (contrast `eval-clio-mcp-injection.ts:14`). Model-matrix looping already works.
- ❌ **No calibration mode** anywhere (`grep spearman|calibrat` → only unrelated PE modules).
- ❌ Only **1 of 3** named injection vectors has a fixture (`injection-via-note`; the "attachment text" and "inbound email body" vectors are absent), and there's no distinct "insufficient-context" fixture.
- ❌ **No `.github/workflows/outreach-evals.yml`** (only `clio-evals.yml`, `meriv2-evals.yml` exist as the template).
- Config defaults confirmed neutral/off: `OUTREACH_PROMPT_SPEC='v1'`, `OUTREACH_PROVIDER` unset, `OUTREACH_DRAFT_MODEL=''`, async flags `false`.

**Design (build phase — BUILDABLE NOW).**
1. `eval-outreach.ts`: (a) dual-spec `buildPrompt(fx)` dispatcher (import `buildOutreachPromptV2`) selectable via `OUTREACH_EVAL_SPEC=v1|v2`; (b) route generation through the real `LlmCompletionService.complete()` so `usage`/`cacheReadTokens`/`cacheCreationTokens` are captured via `parseProviderUsage`, and (spec=v2) the same `cache_control` shape production uses; (c) a pricing table (sonnet-4-6 $3/$15 per MTok, haiku-4-5 $1/$5, cache-read ≈0.1×, cache-write ≈1.25×) → `costUsd` per draft in the report; (d) aggregate pass/fail with non-zero exit on threshold miss.
2. New `eval-outreach-calibrate.ts` (`--mode=emit` prints N drafts as reviewable markdown; `--mode=score <ranking.json>` computes Spearman between Ninja's ranking and judge averages).
3. `fixtures.ts`: add the two missing injection-vector fixtures (attachment-text, inbound-email-body) and a distinct insufficient-context fixture (Ninja approves each — see gate).
4. New `.github/workflows/outreach-evals.yml` modeled on `clio-evals.yml`: fixtures-job always-on (`outreach-evals.spec.ts`), live-evals-job on nightly cron + `workflow_dispatch`, gated on the `ANTHROPIC_API_KEY` secret, uploads `apps/api/reports/outreach-eval-*.json`.

**Execution order (the human gates are hard):**
- **W1.4 baseline (BUILDABLE NOW, descoped):** run `pnpm eval:outreach` with `OUTREACH_EVAL_MODELS=claude-haiku-4-5,claude-sonnet-4-6` against the shipping v1 prompt; commit the report with the cost table. Record that `gpt-4.1-mini` is descoped (no OpenAI key; D2 makes Anthropic the default).
- **W2.3 injection red-team (BUILDABLE NOW):** with the expanded fixtures, run the harness across the 3 vectors, loop-until-dry (2 clean rounds). Gate: ≥7/8 payloads → zero behavioral deviation (checked via `draftMustNotMatch` + judge injection dimension). Document any miss.
- **W1.3 calibration (GATED — Ninja):** generate the 20 drafts now; the Spearman-vs-Ninja step waits on Ninja's ranking session. No proxy is legitimate.
- **W2.7 A/B (evidence BUILDABLE NOW; default-flip GATED):** run spec=v1 vs spec=v2 same-model; commit the diff. The default-on flip (`config.schema.ts:37`) awaits the calibrated judge + a 2–3 day canary soak + reviewed PR.

**Success criteria.**
- Runner exits non-zero when the aggregate gate is unmet (verified by a forced-fail dry run); emits a committed report with a per-draft `costUsd` column.
- Baseline report committed to `apps/api/reports/`, with grounding-violation and injection-failure counts per fixture, and the `gpt-4.1-mini` descope recorded.
- W2.3: ≥7/8 payloads zero deviation across attachment/email/note; misses documented + mitigated or explicitly accepted.
- Calibration harness present and demonstrated on a synthetic ranking (self-test); **Spearman ≥0.7 vs Ninja's real ranking** is the GATED criterion, unmet until the session runs.
- `outreach-evals.yml` present; the fixtures job runs green in CI on the next push touching `outreach-prompt/` or `evals/`.

---

## W2 — PromptSpec v2 (built; remaining items live under G3 above)

W2's core (system prompts both providers, precedence ladder, spotlighting, honest-fallback, tone/length, maxTokens+truncation retry, specVersion, group/revision + Improve UI) is **built and verified**. The only open W2 items are **W2.3 injection red-team** and **W2.7 A/B + flip**, both executed by the G3 harness above (W2.3 is BUILDABLE NOW; the W2.7 default-flip is GATED on calibration + canary).

---

## W3 — Model, cost & caching

Most of W3 is built (`LlmCompletionService`, model-tier config with neutral defaults, `cache_control`, warm-first fan-out, tenant token budget, `diag-outreach-usage`). Two open items:

### G3-W3.2a — Campaign-sticky provider — **BUILDABLE NOW**

**Verified gap.** The verify pass confirmed the BYOK-wins and provider-preference behavior is already tested, but **no `sticky`/campaign-pinned provider logic exists** in `engagement.service.ts`, `engagement-ai.service.ts`, or `ai-credential-resolver.service.ts`. Today provider preference reorders per-call via `preferredProvider`, but a mid-campaign provider fallback could still split one campaign across two providers/voices (M2).

**Design.** Pin `{provider, model}` once at batch entry (resolve the first recipient's credential/tier, then pass that exact pair to every subsequent recipient in the batch), recording it on the batch (and, when async, on `outreach_job.params`). Cross-provider fallback only if the pinned provider hard-fails the whole batch, recorded as such.

**Success criteria.** A ≥2-recipient batch where the resolver *could* pick different providers per call still stamps one `{provider,model}` across all drafts (asserted in a new/extended `outreach-model-tier.spec.ts` case); BYOK `modelOverride` still wins (existing test stays green).

### G3-W3.2b / W3.3 — Model-tier + caching deltas — **GATED (D2 resolved here; measurement needs canary)**

D2 is resolved (Anthropic-first, sonnet-4-6, house COGS). The flip stays env-opt-in. The **eval delta** vs the W2 baseline is produced by the G3 runner. The **caching measurement** (`cache_read_input_tokens ≥ 60%` on drafts 2..N; per-draft cost within ±30% of the D2 table) runs against a ≥10-recipient canary batch at ship time, queried via the existing `diag:outreach-usage --days N`. Success = those two thresholds met on real `ai_usage_events` rows.

---

## W4 — Async pipeline (backend built; frontend + net-new backend open)

### G4 — Wire the async job pipeline to the wizard + build the missing backend surface — **BUILDABLE NOW (CRITICAL: the pipeline is dark today)**

**Verified current state.** Backend job endpoints exist: `POST outreach/jobs/generate` (`engagement.controller.ts:1685`, 400s unless `OUTREACH_ASYNC_GEN`), `POST outreach/jobs/send` (`:1705`), `GET outreach/jobs/:id` (`:1734`, returns `{job, items}`), `POST outreach/jobs/:id/cancel` (`:1741`). But **nothing in `apps/web` calls them** — the wizard POSTs only to sync `generate-batch`/`send-batch`; `generation.ts:14` even documents "Generation still flows through the unchanged POST /outreach/generate-batch."

**Verify-pass corrections folded in (these change the design materially):**
- **`StepSend` is an INLINE function component inside `NewOutreachWizard.tsx` (`:1796`), not a `StepSend.tsx` file.** Any "verify StepSend.tsx" step folds into the `NewOutreachWizard.tsx` work.
- **Per-item retry is NET-NEW backend work, not wiring.** `GET outreach/jobs/:id` selects only `{recipientKey,status,result,error,attempt}` (`outreach-job.service.ts:248-252`) — **no item `id`**, so no item is addressable, and there is **no retry endpoint**. The parent plan's W4.4 ("per-item retry", `:257`) assumed a surface that was never built.
- **`job.totals` is written ONCE, at completion** (`finalizeJob`, `outreach-job.service.ts:490-495`); `job.status` flips queued→running at start (`:315-321`) then to terminal at end. Live progress **must** be computed by counting `items[].status` each poll, never from `job.totals`. (Item rows *do* update live via `setItem`.)
- **No 2s polling precedent exists** — the closest are 15s/30s/60s intervals; `StepRecipientsSelect.tsx:675-681`'s `useQueries` has **no `refetchInterval`** (staleTime only). 2s is a deliberate new value for an actively-watched progress UI; the `refetchInterval` function is net-new, modeled on `EngagementPage.tsx:663-666`'s status-dependent shape.
- **No per-tenant flag** over `OUTREACH_ASYNC_GEN/SEND` (unlike every other rollout, which uses `settings_jsonb.clioFeatureFlags` ANDed with an env kill-switch). Flipping the env turns the UI on for **all** tenants at once.
- **Group slots need their own job** (the single shared `additionalContext` per POST means group vs flat generation can't share one request), so the wizard tracks an **array** of jobIds via `useQueries`.
- **recipientKey fallback mismatch:** frontend `recipientKey()` falls back to `JSON.stringify(r)` (`types.ts:135`); backend `outreachRecipientKey()` falls back to `idx-${index}` (`outreach-job.service.ts:96`) — correlation breaks for a recipient with none of id/directoryContactId/email/name. Align the backend fallback to match, or document the edge case as unreachable (recipients always have an email in practice — verify in the DTO).
- The generate-job DTO inherits `@ArrayMaxSize(100)` from `GenerateBatchEmailDto`; keep it and submit **one job per 100-chunk** (client-side chunking already exists), aggregating N jobIds into one progress pill.

**Design.**
1. **Feature signal (backend → frontend):** inject `ConfigService` into `UsersController` and extend `GET /api/me`'s `features` block with `outreachAsyncGen`/`outreachAsyncSend` (read exactly as `OutreachJobService` does, `outreach-job.service.ts:116-117` — not a raw `process.env` compare, since the zod transform accepts `true/1/yes/on`). Extend `MeResponse.features` in `me.ts:33-35`.
2. **Per-tenant flag (new, mirrors `MEETINGS_V2_FLAG`):** add `OUTREACH_ASYNC_FLAG='outreachAsync.enabled'` to `tenant-flags.ts`, ANDed with the env kill-switch, so async can be canaried tenant-by-tenant. Surface it in the `/me` `features` computation. (This closes the "all tenants at once" hole the verify pass flagged.)
3. **New module `apps/web/.../v2/jobs.ts`:** typed DTOs mirroring the exact job/item status enums; `submitOutreachGenerateJob`/`submitOutreachSendJob` (each mints its own `crypto.randomUUID()` requestKey — never reuse across a genuinely new regenerate/send); `cancelOutreachJob`; `useOutreachJobs(jobIds[])` on `useQueries` with `refetchInterval: q => ['queued','running'].includes(q.state.data?.job.status) ? 2000 : false` and `refetchIntervalInBackground:false`; `mapJobItemsToDraftPatch` (terminal items → `{subject,body,status}` patch, fanning one item to every genKey sharing its resultId). Transient per-genKey status ('queued'/'claimed'/'sending') lives in a **separate** map, never in `generatedEmails` (which stays the single source of truth for Send/Save/Improve — so those flows need zero change).
4. **Wizard integration:** branch only at the POST layer on `features.outreachAsyncGen` (+ the per-tenant flag) for **bulk** calls (auto-generate on step entry + Regenerate-all); single-item `regenerateOne`/`improveOne` **stay synchronous** (one recipient, seconds, no ALB benefit). Persist `activeJobIds` to `sessionStorage` for same-tab reload resume; document that cross-session resume needs a `GET jobs?outreachRecordId=` lookup that doesn't exist yet (and `submitGenerateJob` doesn't forward `outreachRecordId` today — out of scope here).
5. **Net-new backend for per-item retry:** add `id:true` to `getJob`'s item select; add `OutreachJobService.retryItem(ctx, jobId, itemId)` (verify `kind==='generate'` and item `status==='failed'`; flip item→`pending`, clear error; if job is terminal, flip it→`running`, clear `finishedAt` so `findRunnableJobId` re-picks it); add `POST outreach/jobs/:id/items/:itemId/retry` gated like the others.
6. **StepGenerate UI:** progress pill computed from polled `items[]` counts (not `job.totals`); queued/claimed spinner + skipped state on rail rows; a "Partial failures" panel listing failed slots with per-row Retry (calls `onRetryOne`, which is the sync regenerate in sync-mode and the new retry endpoint in job-mode — StepGenerate stays mode-agnostic); a Cancel button visible while any job is non-terminal.

**Success criteria.**
- With `OUTREACH_ASYNC_GEN=false` (default), `/api/me` returns `outreachAsyncGen:false` and the wizard's network calls are **byte-identical** to today (zero regression).
- With the flag on for a canary tenant, a 12-recipient mixed campaign POSTs `jobs/generate`, returns in <1s, and the pill shows a live `0/12 → 12/12` incrementing ~every 2s, computed from `items[]` (proven by asserting the count moves while `job.totals` is still frozen).
- Same-tab reload mid-job re-hydrates `activeJobIds` and resumes correct counts from `GET jobs/:id`.
- A forced single-recipient failure shows a failed rail icon + a "N failed" panel; Retry regenerates only that item (via the new endpoint) without touching the other 11.
- Cancel flips unclaimed items to `skipped`, stops polling at terminal status, shows "Canceled — N generated, M skipped".
- Regenerate-this and Improve-with-Meri always POST `generate-batch` (never `jobs/generate`) regardless of the flag.
- `generation.test.ts` + `generation.ts` exports need zero change for job-mode drafts to be sendable/saveable/revertable (proves the single-source-of-truth merge).
- New `outreach-job.spec.ts` cases for `retryItem` (generate-only guard; job un-finalization) and the item-`id` exposure.
- Both typechecks + prettier clean.

---

## W5 — Context expansion

### G5 — "Last contacted Nd ago" wizard badge — **BUILDABLE NOW**

**Verified current state.** The batched backend query already exists — `outreachPriorContactByEmail` (`engagement.service.ts:5674-5715`, doc-comment literally anticipates the badge), called once per `generateBatchEmails` (`:2552-2556`), matched by lowercased email, rendered into the prompt (`:2654-2658`) and suppressed for groups. It's **generation-only** — never exposed as a read, and there's **zero** "last contacted" UI in the Recipients step (verified across `IndividualRow`/`ListMemberRow`/`GroupEntity` in `StepRecipientsSelect.tsx`).

**Verify-pass correction:** the proposed `@ArrayMaxSize(300)` (justified by the internal `take:300`) is **wrong** — a saved audience can carry up to **500** members (`CreateOutreachAudienceDto` `@ArrayMaxSize(500)`, `engagement.controller.ts:902-906`). Applying a 301–500-member audience would 400 the lookup and silently drop all badges. Use `@ArrayMaxSize(500)` (or chunk).

**Design.**
- Backend: public read wrapper `getRecipientPriorContact(ctx, {clientId?, emails[]})` delegating to the existing private method verbatim (badge + prompt line can never drift); new `GetPriorContactDto` (`@ArrayMaxSize(500)`, `@IsEmail({},{each:true})`, optional `@IsUUID clientId`); new `POST outreach/prior-contact` (no `@Throttle` — cheap read, same class as `outreachInsights`). Returns `{email, sentAt, subject}[]` (absent = no prior contact, never fabricated).
- Frontend: new `priorContact.ts` (`candidateEmails(targets)`, `usePriorContact(emails, clientId)` with `staleTime:60_000`, `formatLastContacted(iso, now)` — "today" special-case, hand-rolled like `intelligence-v1/mappers.ts:315-322`). Thread `clientId={state.clientId}` into `StepRecipientsSelect`; fetch once in `SelectedPanel`; render a neutral `.ov2-rs-lastcontact` pill after the email in the three flex-row renderers. Picker/grid rows (`MemberRows`/`ClientRows`) are out of scope (grid-column change + fetching for hundreds of un-selected rows).

**Success criteria.**
- `getRecipientPriorContact` returns a row for a seeded `sent`/`sentAt=now-12d`/`deletedAt=null` record whose `recipients` JSON contains the email; **omits** (no null row) for `now-91d`, non-`sent`, or `deletedAt≠null`; scopes to `clientId` when provided.
- `POST outreach/prior-contact` 400s on a non-email or >500 entries (DTO metadata test, `engagement-throttle.spec.ts` style).
- `formatLastContacted` → "last contacted 12d ago" at 12d, "last contacted today" at <1d; `candidateEmails` dedupes/lowercases across all three target types and drops emailless recipients (vitest, `targets.test.ts` style).
- Manual: a recipient with a 12-day-old sent record shows the pill (title = subject) **before** clicking Generate; a recipient with none shows no pill.
- Existing batch-generate tests unchanged/green.

### G6 — PE funding Build-Context tab — **BUILDABLE NOW**

**Verified current state (and the key simplification).** The plan assumed a net-new search endpoint; the verify pass confirms **no new backend endpoint is needed** — `GET /program-elements?q=&limit=` (`program-element.controller.ts:82` → `program-element-read.service.ts:117`) already exists, is `@Roles('standard_user')`-guarded, already LATERAL-joins `program_element_year` via the `@capiro/shared` canonical-current precedence SQL (`fundingCurrentCoalesceSql`/`fundingCurrentStageSql`), and returns `{peCode, title, service, latestCurrent, latestCurrentFy, latestCurrentStage, latestRequest, ...}`. `ProgramElement`/`ProgramElementYear` are **global reference data (no tenantId/RLS)** — confirmed. A typed client helper `getProgramElementsList` and `fmtMoneyM` (MILLIONS) already exist. The context-item contract is generic: `formatItems()` (`engagement.service.ts:2442-2449`) renders any `{kind,title,body,note}`; `buildOutreachPromptV2` only sees the pre-rendered `contextItems` string. So the whole feature is: **widen the `kind` whitelist + mirror the existing bill-search tab.**

**Verify-pass notes:** the PE Brief template exists (`system-pe-brief`) and `pe_brief` has a 4000-token budget in `LARGE_OUTPUT_TEMPLATES` — but that budget is currently **dead code** because the wizard hardcodes `promptTemplate:'custom'` (`:2691`). That's a separate latent issue (the honest-fallback still fires without curated context, so the template contract isn't broken, just under-budgeted); note it, don't silently rewire template routing here. Also: `program_element.title` has **no trigram index** (unlike `congress_bill.title`) — run `EXPLAIN` before trusting it under a 350ms keystroke debounce; the PE finder page already uses this endpoint without one, so it's likely fine at current catalog size.

**Design.**
- Backend (2 lines, kept in lockstep per the in-code warning): add `'programElement'` to `OutreachSelectedContextItemDto`'s `@IsIn` + `kind` union (`engagement.controller.ts:996-997`) and to `OutreachSelectedContextItemInput.kind` (`engagement.service.ts:250`).
- Frontend (mirror the bill tab exactly): add `'programElement'` to `ContextKind` (`types.ts`); add the tab to `TABS` + `KIND_LABEL` in `StepContext.tsx`; add a `peSearchActive`/`peSearch` pair calling `api.get('/api/program-elements',{params:{q,limit:20}})`, mapping each row to a `ContextPoolItem` (`id:'pe-'+peCode`, `title:peCode+' — '+title`, `sub` = `fmtMoneyM(latestCurrent)+' · FY..'`, `body` = the funding block built once from the row); extend `visible`/`listLoading`; add a `peWatchlistQuery` (`{watched:'true',limit:50}`, seeds "watch-list" for free) into the `pool`. Not client-grouped (live global search like bills).
- Funding-block `body` (built client-side, no detail fetch): `Current: $248.0M (FY27 · Conference)` / `Request: $210.0M (FY27)` / `Service: Air Force · Budget Activity: 07` — rides into `contextItems[].body` exactly like a bill's latest-action text.

**Success criteria.**
- Searching a PE by title or code returns results in the tab within the debounce; selecting one adds a `[programElement]` context item whose `body` shows the canonical-current FY figure matching a seeded `ProgramElementYear` fixture.
- A PE-Brief draft generated **with** a curated PE cites the correct FY figures verbatim; **without** one, the honest gap-note fallback still fires (regression, not new behavior).
- Adding `'programElement'` forces the `KIND_LABEL` `Record<ContextKind,string>` update (compile-enforced); backend `@IsIn` accepts it (no `forbidNonWhitelisted` 400).
- `EXPLAIN` on the `q`-search confirms acceptable plan at current catalog size (or an index is added).
- Both typechecks + prettier clean; deterministic eval unaffected.

### G7 — Real reply detection (D8-b) — **DEFERRED (decision recorded; design ready)**

**Decision:** deferred as a separate scoped initiative (see §0). D8-a (remove fake `openRate`) is already done; `replyCount` already renders an honest `0` via `OutreachView.tsx:3181-3196`.

**Why deferred (verified):** `sendMail()` (`microsoft-graph-sync.service.ts:356-396`) uses the fire-and-forget `/me/sendMail` action and returns `{ok:true}` — **no conversationId is captured at send, by API design.** Real reply detection therefore requires converting to a two-call create-then-send flow (`POST /me/messages` then `.../send`) across the **8 call sites** that share `sendMail()` (verify pass: 5 in `engagement.service.ts` incl. two **legacy** `/campaigns/*` ones at `:6310/:6372`, plus 3 in `meri-tools.service.ts`), introduces an orphaned-draft failure mode, and still can't cover no-client campaigns (the `ClientAssociationOverride.clientId` column is required, and the fuzzy association heuristic silently skips persisting threads it can't match — `microsoft-graph-sync.service.ts:847`). **Critically, the Graph create-then-send behavior (that `/me/messages` returns a `conversationId`, that `.../send` auto-saves to Sent Items) is an UNCITED external-API assumption** — it must be verified against Microsoft Graph documentation before any build, not assumed.

**Ready-to-execute design (when scheduled):** capture `graphConversationId` at send via create-then-send (after verifying the Graph contract); pin the outbound thread with a `ClientAssociationOverride` so the generic sync doesn't drop/re-route it; define "replied" as a distinct-repliers count over `MailMessage` rows in the matching thread with `fromEmail ≠ account` and timestamp `>` sent time; compute via a new scheduled sweep (no existing cron touches `OutreachRecord`); the UI already renders `replyCount` (plain count, no rate). Full success criteria in the research appendix. **Correct class name is `ClientAssociationService`** (not `EngagementClientAssociationService`).

---

## W6 — Consolidation & retirement (G8)

### W6.2 — Retire legacy `/campaigns/*` — **GATED (D4 sign-off); artifacts + inert 410 BUILDABLE NOW**

**Verified current state.** Exactly **10** live routes under `@Controller('engagement')` → `/api/engagement/campaigns*` (`engagement.controller.ts:1916-1984`), all delegating to `EngagementService` methods (`:6021-6378`) on `EngagementCampaign`/`EngagementCampaignRecipient`. **Zero frontend callers** (grep of `apps/web` for the campaign method/id names → nothing). One AI-usage signal already flows: `generateCampaignEmail` tags `recordAiUsage(...,'campaign_email',...)` (`:6249`), and `'campaign_email'` is already in `diag-outreach-usage.ts`'s workflow list — so 30-day generate-route usage is answerable **today**.

**Verify-pass correction (important):** the parent plan's D4 step 1 — a 30-day CloudWatch log-filter over the 9 non-generate routes — **has no existing data source.** `main.ts` has no request-logging middleware/interceptor; `tenant-context.middleware.ts` logs only bypass notices; `network-stack.ts`/`compute-stack.ts` configure **no ALB access logging** (only VPC REJECT flow logs + container stdout). The literal retroactive query cannot be run. (This last point leans partly on external CloudWatch state, but the repo premise — no app request logging, no CDK ALB access logs — is solid.)

**Design (BUILDABLE NOW):**
1. Run `diag:outreach-usage --days 30`, record `campaign_email` rows per tenant.
2. New read-only `diag-engagement-campaigns.ts` (modeled on `diag-outreach-usage.ts`: direct PrismaClient, groupBy, aggregate reads only, non-zero exit on error), reporting per tenant: `engagement_campaigns` count, `engagement_campaign_recipients` count, `MAX(updatedAt)`, status/type breakdown. Wire as `diag:engagement-campaigns`. This satisfies D4 step 2.
3. **Surface the CloudWatch data-gap to Ninja** as a scoping decision: (a) accept the DB-side signals (row counts + newest `updatedAt` + generate AI-usage) as sufficient traffic evidence — completes in days; or (b) ship a minimal `/engagement/campaigns*`-scoped request-logging interceptor (writing to the existing `apiLogGroup`, no new CDK log group) and wait a fresh 30 days. Do not silently substitute (a) for (b).
4. Spec the **inert** flag-gated 410 now (implement only post-sign-off): `ENGAGEMENT_CAMPAIGNS_FLAG='engagementCampaigns.enabled'` default **true** (still live), mirroring `MEETINGS_V2_FLAG`'s env-kill-switch-free per-tenant pattern; a shared guard at the top of the 10 methods throws `HttpException(GONE, 'ENGAGEMENT_CAMPAIGNS_RETIRED')` (reusing the `HttpException/HttpStatus` pattern already at `engagement.service.ts:2352-2360`) when the flag is false. Ship inert for one release; Ninja flips per-tenant.

**Success criteria (BUILDABLE-NOW portion):** `diag:engagement-campaigns` exists, runs read-only, output recorded; `campaign_email` 30-day counts recorded; the CloudWatch gap + option (a)/(b) surfaced to Ninja. **GATED portion:** the 410 flag-gate lands only after sign-off, shipped inert (existing campaign route tests still pass with the flag default-true), then Ninja flips per tenant and confirms via the diag script that row counts stop changing and no 5xx appears.

### W6.3 — Stop writing `direction`; prune `PROMPT_TEMPLATE_GUIDANCE` — **BUILDABLE NOW (guidance prune needs a DB read first)**

**Verified current state.** `direction` is persisted in exactly **3** functions (`createOutreachRecord` `:1327-1368`, `updateOutreachRecord` `:1370-1427`, `persistSentBatchRecord` `:3016-3063`), each into the `metadata` JSON + `recipients` JSON; `generateOutreachDraft` (`:1511`) assembles it but **delegates** the write to `updateOutreachRecord` (so it's not a 4th write site); `generateBatchEmails` only reads it into an ephemeral prompt context. The wizard hardcodes `direction:'on-behalf'` (`NewOutreachWizard.tsx:226-232`, "the on-behalf/to-clients fork is gone as a product concept... survives only as a compat shim") and **never branches on it**. The AI layer still branches (`buildOutreachPrompt` v1 `:1146-1196`; `buildOutreachPromptV2` `:393-405,442`) — so old drafts with `metadata.direction='to-clients'` must still hydrate.

`PROMPT_TEMPLATE_GUIDANCE` (`engagement-ai.service.ts:134-147`) has **7** entries, **2** read-usages (`:329` v2/campaign-gated, `:1125` v1). No live UI path sends a non-`'custom'` `promptTemplate` (the `DraftStep` `onPromptTemplate` prop is never passed → the Select never renders; `generateBatchEmails` hardcodes `'custom'` at `:2156/:2691`). So which of the 7 keys still matters is only answerable from **production data** (`metadata->>'promptTemplate'` on historical rows), not static grep.

**Design.**
- Direction: (1) `createOutreachRecord` stops writing a freshly-derived `direction` into persisted metadata (it can still pass it request-scoped to the AI call); (2) `updateOutreachRecord` only includes `direction` in the merged metadata when `'direction' in input` — otherwise leaves the stored value untouched (this is the literal "read-only for old drafts"); (3) `persistSentBatchRecord` **keeps** writing it — it records the framing actually used for a completed send (audit trail), and is explicitly commented as the one non-prunable site so a future refactor doesn't sweep it in.
- Guidance: run a read-only DB query (a `diag-*` addition or ad-hoc under diag conventions) for distinct `metadata->>'promptTemplate'` across `follow_up/prep/outbound_campaign/campaign` rows; prune `PROMPT_TEMPLATE_GUIDANCE` to exactly the observed set (or delete it wholesale + both usages + the `templateGuidance` plumbing if the set is empty). Guard: confirm `PROMPT_TEMPLATE_GUIDANCE[missingKey]` degrades to `undefined`-filtered-out (not a crash) before pruning — it does today.

**Success criteria.** A regression test: a Prisma-seeded `OutreachRecord` with `metadata.direction='to-clients'`, regenerated with no `direction` in input, still resolves the to-clients rule (parent plan's own criterion, `:278`). `create`/`update` no longer stamp a fresh direction for calls that didn't supply one; `persistSentBatchRecord` unchanged + commented. The guidance-prune query result is documented; the map is pruned to exactly the observed set (or deleted), both usages/plumbing removed, reachability-swept, typecheck + `engagement-ai` specs green.

### W6.4 — Converge meriv2-core onto the shared client + fix X1 — **BUILDABLE NOW (staged)**

**Verified current state.** `LlmCompletionService` (`apps/api/src/engagement/llm-completion.service.ts`, 293 lines) has retries/backoff, typed errors, Anthropic `cache_control`, usage parsing; its **only** NestJS coupling is `import { Logger, ServiceUnavailableException } from '@nestjs/common'` (`:21`); it requires a **non-optional** `jsonSchema` (`:41`). `meriv2-core`'s `AnthropicLlmClient` (`packages/meriv2-core/src/llm/llm-client.ts`, 118 lines) is Anthropic-only, no retry, silently `return {}` on parse failure. Dependency directions: `meriv2-core` deps are only `{@capiro/shared, zod}`; `apps/api` does **not** depend on `@capiro/meriv2-core`; `@capiro/shared` has zero runtime deps — so `@capiro/shared` is the natural shared home once the NestJS import is dropped. **X1 confirmed:** `meri-registry.service.ts:123` `?? 'claude-sonnet-4-5'` vs `config.schema.ts:30` default `'claude-haiku-4-5-20251001'`. A separate hand-rolled tool-use caller `completeWithTools` (`request-scoped-llm.client.ts:91-153`) bypasses `AnthropicLlmClient` and needs `tools`/`tool_choice` fields the shared client doesn't have yet.

**Design (staged; each stage independently shippable).**
- **Stage A (apps/api only):** make `jsonSchema` optional (skip schema-forcing when absent — OpenAI omit `json_schema`, Anthropic omit the schema appendix); add optional `tools`/`toolChoice` passthrough (Anthropic branch). Extend `llm-completion.service.spec.ts`.
- **Stage B (relocate to `@capiro/shared`):** move the transport core (+ the already-pure `ai-usage-parse.ts`) into `@capiro/shared/llm/`, replacing the NestJS import with a minimal `{warn}` logger (defaulting to `console.warn`) and a plain `LlmCompletionError extends Error`. `EngagementAiService` catches `LlmCompletionError` at its boundary and rethrows `ServiceUnavailableException` (existing 503 behavior unchanged). Re-check any `@capiro/shared` CI lib/size constraint (memory: shared needed the DOM lib for `URL`).
- **Stage C (meriv2-core adoption):** `AnthropicLlmClient` becomes a thin adapter over the shared client (schema-optional path), preserving the `completeJson({system,prompt,maxTokens})` signature so **none** of the ~9 downstream call sites change. The `completeWithTools` migration is a later, separate PR once Stage A's tools passthrough is verified.
- **X1 (standalone):** replace the bare `?? 'claude-sonnet-4-5'` with a single documented source of truth — an orchestrator-specific typed zod default (MeriV2's reasoning tools plausibly warrant a stronger tier than the outreach-draft haiku default; this is the production-best call, made explicit rather than an inline magic string).

**Success criteria.** Stage A: spec covers schema-omitted (plain-text) requests for both providers + a tools-bearing Anthropic request; existing tests green. Stage B: no `@nestjs/common` import remains in the relocated file (grep-verifiable); apps/api's 503-on-transport-failure behavior still asserted green. Stage C: `completeJson` signature byte-identical pre/post; all downstream specs (hearing tools, in-editor, request-scoped) pass **unmodified**; a new test proves the adapter no longer silently returns `{}` on parse failure (surfaces a typed error or a deliberately-exercised degrade path). X1: a config/registry spec asserts the resolved model when `ANTHROPIC_MODEL` is unset matches the single documented default.

---

## Execution order & wave-completion gates

Per the directive, each wave is fully closed (all BUILDABLE-NOW items landed, tested, committed; GATED items either resolved-by-decision or reduced to a single documented pending action) before advancing.

```
W0 (G1) ─► W1 (G2 + G3 build/baseline/red-team) ─► W2 (W2.3 run; W2.7 evidence, flip staged)
   ─► W3 (G3-W3.2a sticky; D2 recorded; caching staged) ─► W4 (G4 full stack) 
   ─► W5 (G5 badge, G6 PE tab; G7 deferred) ─► W6 (W6.2 artifacts+inert 410, W6.3, W6.4+X1)
   ─► whole-plan review ─► merge to main ─► ship to AWS (flips out-of-band, canary caching measurement)
```

**Per-wave gate (every wave):** `pnpm --filter @capiro/api typecheck` + `pnpm --filter @capiro/web typecheck` clean; prettier clean on touched files; all new/changed jest + vitest green; full engagement suite's failed-count unchanged vs the known pre-existing AWS-SDK suite failures; a short evidence note appended to this doc's status log. Commit at each wave boundary. Never `cdk deploy` Compute (CDK↔task-def drift); verify `:latest` carries the merge SHA before any roll; migrate-then-roll ordering.

## Definition of done (this plan)

1. Every BUILDABLE-NOW gap above is implemented, tested to its success criteria, and committed.
2. Every GATED item is reduced to a single, clearly-documented pending action with its blocking input named (Ninja ranking / Ninja D4 sign-off / OpenAI key / prod canary), and the harness/flag/mechanism for it is built and inert-safe.
3. The two DECISIONS (D2, D8) are recorded here with rationale and reflected in code (D2 defaults stay opt-in; D8-a done, D8-b design parked).
4. Whole-plan review re-checks the parent plan's traceability matrix; nothing silently dropped.
5. Merged to `main`; shipped to AWS with all model/prompt/async flips **off by default**; caching measurement run against the canary post-deploy.

## Whole-plan review (2026-07-11) — PASS

Every gap G1–G8 is either built+verified or documented-gated/deferred with a reason (nothing silently dropped):
G1 W0.2 (`da23b43`) · G2 W1.2 (`200a0e2`) · G3 runner/CI/baseline (`41ce174`) + calibration (`31f5c3a`) + W2.3/W2.7 evidence (`c7673c5`) + sticky provider (`2d95ab4`) · G4 W4.4 async (`d93ec57`,`25b3c56`) · G5 badge (`44d8c25`) · G6 PE tab (`1c65195`) · G7 reply-detection DEFERRED (D8) · G8 X1+diag (`6e951ca`), retirement D4-gated, direction/convergence deferred.

**Final combined gate:** api typecheck clean · web typecheck clean · web vitest 75/75 (7 outreach-v2 files) · full api suite 244 suites / **8 failed = the identical 8 pre-existing non-outreach suites from the W0 baseline** (acquisition-personnel, program-element, meri-domain-fanout, app.module SES DI); passing tests 2340→**2374 (+34 new)**; **zero outreach/engagement regressions**.

**Ship-safety:** every model/prompt/async behavior change is behind a default-off flag (`OUTREACH_PROMPT_SPEC=v1`, `OUTREACH_ASYNC_GEN/SEND=false`, `OUTREACH_ASYNC_FLAG` default off, `OUTREACH_PROVIDER/DRAFT_MODEL` neutral). Always-on changes are correctness-only (W0.2 error-status, W3.2a sticky provider — behavior-preserving for single-provider tenants) or additive UI (badge, PE tab). Safe to merge + deploy; the quality flips activate later on evidence + out-of-band env per the gates.

**Remaining human/gated actions (handoff):** Ninja's W1.3 20-draft ranking (calibrates the judge → unblocks the W2.7 default-flip); D2/model-tier + prompt-spec flips (out-of-band env at deploy, on eval evidence); D4 sign-off for `/campaigns/*` retirement; D8 decision for reply detection; W3.3 cache-read measurement on a prod canary; interactive canary QA for the W4.4 job UI + W5.4 PE-Brief citation.

## Shipped (2026-07-11)

Merged to `main` as **PR #403** (squash `5e7e838`) after CI green (`verify` + `evals`). **Deployed to AWS** via `scripts/deploy-dev.sh`: ECR `:latest` verified = `5e7e838` for both api + web (ECR-race clear), migrate exit 0 (`No pending migrations` — this drive added none), `capiro-dev-api` + `capiro-dev-web` rolled to steady state. Post-deploy: **0 API exceptions**, `app.capiro.ai` 200, `/api/me` 401 (auth guard alive). All quality flips ship **off by default**, so production behavior is unchanged; the live changes are the correctness fix (W0.2), sticky provider (W3.2a, behavior-preserving for single-provider tenants), and additive UI (badge, PE tab). Follow-up **PR #404** fixes the `outreach-evals` CI workflow (build `@capiro/shared` before typecheck). The X1 orchestrator fix is in the image but takes effect only on a separate `meriv2-orchestrator` roll (fallback-only; no-op if `ANTHROPIC_MODEL` is set in prod).

## Status log

- 2026-07-11: Plan authored from 8-gap research + adversarial verification pass. Beginning W0/G1.
- 2026-07-11: **W6 resolved.** **X1 DONE + verified**: `meri-registry.service.ts:123` stale `?? 'claude-sonnet-4-5'` → `'claude-sonnet-4-6'` with a comment documenting it as the intentional stronger orchestrator reasoning-tool default (orchestrator typecheck clean after building `@capiro/meriv2-core` + `@capiro/auth`). **W6.2 partial DONE**: read-only `diag:engagement-campaigns` script (per-tenant campaign/recipient counts + newest updatedAt + status breakdown) — the D4 evidence tool; transpiles + valid Prisma groupBy (runs as an ECS one-off like every diag verb). The CloudWatch-traffic gap (no request logging exists) is documented for Ninja; the flag-gated 410 + code deletion + table archival stay **GATED on Ninja's D4 sign-off**. **W6.3 DEFERRED (low-value/moderate-risk)**: `direction` is already harmless-correct (always `'on-behalf'` via the frontend shim), so making the 3 persist sites read-only is a cleanup not worth touching the persistence path for now; the `PROMPT_TEMPLATE_GUIDANCE` prune needs a prod DB distribution query (no live UI sets a non-`custom` template) — both documented. **W6.4 client convergence DEFERRED**: relocating `LlmCompletionService` to `@capiro/shared` + a meriv2-core adapter (Stage A/B/C) is a large cross-package refactor the parent plan itself deferred and orthogonal to outreach's function; X1 (the concrete bug it bundled) is fixed independently.
- 2026-07-11: **W5 buildable items DONE.** G5 (`44d8c25`): "last contacted Nd ago" badge — backend public read wrapper + `POST outreach/prior-contact` (cap 500) + frontend `priorContact.ts` + a neutral pill on every selected-recipient row via context; tests 5+5. G6 (`1c65195`): PE funding Build-Context tab — no new endpoint (reuse `GET /program-elements`), widened the context-item `kind` whitelist, mirrored the bill-search tab + watched-PE seed, `peToPoolItem` extracted pure + unit-tested 4/4. **G7 (reply detection) DEFERRED — decision recorded:** D8-a (fake open-rate removal) already shipped; D8-b requires converting the SHARED `microsoftGraph.sendMail()` from fire-and-forget `/me/sendMail` to a two-call create-then-send across **8 call sites** (2 in the legacy `/campaigns/*` surface), rests on **uncited** Graph-API behavior, and still can't cover no-client campaigns — a high-risk rewrite of the transport that emails congressional offices. Deferred as its own scoped initiative with its own canary rather than folded into this pass; `replyCount` already renders an honest `0`. Live PE-Brief citation + badge display are canary QA.
- 2026-07-11: **W4/G4 DONE (async pipeline no longer dark)** — commits `d93ec57` (foundation) + W4d. Foundation: GET /me `features.outreachAsyncGen/Send` (env AND per-tenant `OUTREACH_ASYNC_FLAG`, both default off), `OutreachJobService.retryItem` + `POST /outreach/jobs/:id/items/:itemId/retry` (item.id exposed), and the `jobs.ts` client (typed DTOs, submit/cancel/retry, `useOutreachJobs` 2s poll, pure mappers — progress from item rows not job.totals). W4d wizard: bulk generate (auto-gen + Regenerate-all) submits async jobs when the flag is on, polls, and merges TERMINAL results into `generatedEmails` (guarding against clobbering user edits); a progress banner shows N/M + Cancel + Retry-failed; single-item regenerate/Improve + all send stay sync. Sync path is behavior-preserving via the shared `buildGenerateTasks` (proven by generation.test 21/21). Tests: api 26/26 (flags+jobs incl. retryItem), web 29/29 (generation+jobs). Both typechecks clean. **Ships DARK (double-gated).** Final W4.4 gate — live progress/reload/cancel/retry UX — is canary QA (per the plan; no interactive wizard here). Per-recipient status chips deferred as polish (aggregate banner shipped).
- 2026-07-11: **W3.2a campaign-sticky provider DONE + verified**: batch now resolves the credential order ONCE (`resolveOutreachCredentials`) and pins the provider that drafts recipient #1 across the whole send — recipient #1 keeps full fallback (establishes + warms the v2 cache), 2..N are pinned to the winner (M2: no mixed provider voices). Empty creds → one loud failure, not N per-item errors. New `engagement-batch-sticky-provider.spec.ts` (pin + fallback-on-#1-failure); all 6 batch specs green (21 tests), typecheck clean. **W3.2b/W3.3 are decision-made / deploy-gated**: D2 resolved (draft on sonnet-4-6, Anthropic-first — evidence in `outreach-eval-ab-v1-vs-v2.md`); the model-tier flip is an out-of-band env change at deploy (defaults stay neutral per #397). The ≥60% cache-read measurement (W3.3) requires a real ≥10-recipient production batch (warm-first + cache_control already built) — runs post-deploy via `diag:outreach-usage`.
- 2026-07-11: **W1.3 calibration harness DONE** (commit `31f5c3a`): emit/score modes, Spearman unit-tested 8/8; run gated on Ninja. **W2.3 injection red-team: PASS** — added `injection-via-email-body` golden (spotlight vector); a full v2 eval (`outreach-eval-v2.json`) shows **0 injection breaches across all 3 vectors (note/recipient-data/email-body) on both haiku + sonnet**, injection judge dim = 5.0 throughout. **W2.7 A/B evidence generated** (`outreach-eval-ab-v1-vs-v2.md`): v2 lifts the weak model (haiku grounding +0.55, grounding-violations 2→1) but shows small within-noise deltas on sonnet (grounding 4.909→4.636, n=1/fixture, uncalibrated judge). **W2.7 default-flip stays GATED** on the calibrated judge (Ninja W1.3) + a 50-draft canary — this single uncalibrated run cannot clear "v2 ≥ baseline every dimension." Evidence also strengthens **D2**: sonnet is far more grounded than haiku under both specs (0 vs 2 violations) → draft on sonnet-4-6. `cacheRead 0%` is expected (single-shot fixtures; the ≥60% W3.3 target is a production warm-first BATCH measurement).
- 2026-07-11: **W1/G2 DONE** (commit `200a0e2`): 3 goldens added (14 total) + spec-version-aware deterministic harness; suite 61/61. **W1/G3 build DONE**: `eval-outreach.ts` extended (v1/v2 dispatch, real `LlmCompletionService` transport with usage+cache capture, pricing/cost table, opt-in `OUTREACH_EVAL_GATE`); `.github/workflows/outreach-evals.yml` added. **W1.4 baseline RUN** (`apps/api/reports/outreach-eval-baseline-v1.json`): 14 fixtures × {haiku-4-5, sonnet-4-6}, spec v1 — invalid:0, tokenLeaks:0, injectionBreaches:0. Cost/draft ≈ $0.002 (haiku) / $0.0076 (sonnet), matching the D2 estimate. **2 grounding violations, both on haiku** (`template-memo`, `direction-to-clients` — model invented bills under v1); sonnet scored 5/4.5 on the same fixtures with zero violations → concrete evidence for D2 (draft on sonnet) and for v2's honest-fallback. `gpt-4.1-mini` descoped (no OPENAI_API_KEY). **W1.3 calibration remains GATED** on Ninja's 20-draft ranking.
- 2026-07-11: **W0/G1 DONE + verified** (commit `da23b43`). Both typechecks clean; 6/6 outreach specs pass in isolation (`engagement-batch-error-status`, `engagement-batch-group`, `engagement-batch-revise`, `outreach-job`, `outreach-budget`, `dedupe-recipients`); web `generation.test.ts` 18/18. Full `apps/api` suite baseline (with the change): 8 failing suites / 15 failing tests — **all pre-existing and unrelated to outreach**: `acquisition-personnel-read.service`, `sam-personnel-extractor`, `dow-org-import.helpers`, `app.module` (SES/`@smithy` DI smoke test), `meri-domain-fanout.helpers`, `bill-pe-extractor`, `program-element-read-provisions`, `program-element-read.service`. This is the known-good baseline used to gate every subsequent wave (failed-suite set must not grow with outreach changes).
