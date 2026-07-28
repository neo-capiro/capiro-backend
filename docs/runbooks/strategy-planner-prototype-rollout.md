# Strategy Planner prototype rollout — staged release, rollback, and Phase 7 handoff

Owner: Strategy Planner. Written for Phase 6 (integration QA, migration safety, rollout) of the
prototype rollout whose UI contract is `Capiro - Strategy Planner (PPBE) - standalone (2).html`.

**This runbook does not enable anything.** Every step below is an instruction for a human with
production access; nothing in Phase 6 flipped a flag, pushed, merged, or deployed.

---

## 1. What is being released

Phases 1–5 of the prototype rollout, released together:

| Phase | Surface | Backing change |
| --- | --- | --- |
| 1 | Compact editor header, Watch chip, scroll/frozen-column behaviour | none (web only) |
| 2 | Persistent contextual Meri chat (strategy + per-step threads) | migration `20260727000000_sp_strategy_chat_message` |
| 3 | Version-aware Watch review backend (revalidate, dismissal, accept/accept-all) | migration `20260727010000_sp_watch_consistency` |
| 4 | In-editor Watch panel replacing the strategy-scoped review page; library nudge | none |
| 5 | Deterministic dependency repair, context-gap message + inline marker, warning-card removal | none |
| 6 | Integration QA, migration safety, this runbook | none |

Both migrations are additive; §4 below depends on that.

## 2. Feature gates

There is **no new flag**. The rollout rides the four gates that already exist, each read from
`tenants.settings_jsonb.clioFeatureFlags` and ANDed with an environment kill-switch:

| Gate | Flag key | Env kill-switch | What it turns on |
| --- | --- | --- | --- |
| `strategyPlanner` | `strategyPlanner.enabled` | — | The `/strategies` surface at all |
| `strategyPlannerMeri` | `strategyPlannerMeri.enabled` | `STRATEGY_MERI_ENABLED` | Draft + assistant + the chat panel |
| `agenticMeri` | `agenticMeri.enabled` | `STRATEGY_AGENTS_ENABLED` | The agent surfaces (UI belt for Watch) |
| `strategyWatcher` | `strategyWatcher.enabled` | `STRATEGY_AGENTS_ENABLED` | Watch checks + the in-editor Watch panel |

Execution flags (`executionAgentWorkspace`, `executionAgentOutreach`) are independent and are **not**
part of this rollout. `agentAutoApplyLowRisk` stays **off**: Watch is suggest-only, and nothing in
Phases 1–6 changes that.

**Operational note:** `StrategyFlagsService` caches each flag per tenant for **60 seconds**. A flip —
in either direction, including an emergency disable — takes up to a minute to take effect on an
already-warm task. Plan any verification step around that, and do not conclude a rollback failed
inside the first minute.

## 3. Recommended rollout order

Each step is a separate decision with its own soak. Stop and investigate on any error-rate or
latency regression rather than continuing.

1. **Internal tenant, Watch paused.** `strategyPlanner` + `strategyPlannerMeri` + `agenticMeri` on,
   `strategyWatcher` off. Exercises the header, chat, context-gap and draft-readiness work with no
   scheduled agent activity at all.
2. **Internal tenant, manual `Check now`.** Add `strategyWatcher`, but leave every strategy's Watch
   mission `paused`. Watch is then reachable only by a human pressing **Check now** in the panel.
3. **Internal weekly scheduling.** Resume Watch on a small number of internal strategies. The panel's
   enable/resume path always writes `cadence: 'weekly'` (Phase 4 §7), including for legacy daily
   missions, so no separate cadence migration is needed.
4. **One design-partner tenant**, same order as steps 1–3.
5. **Wider canary** after seven days of metric and error review (§5).

## 4. Rollback

The controlling property is that both migrations are **additive** — no dropped column, no dropped
table, no narrowed type, no back-fill. `apps/api-strategy/src/prisma/migration-safety.spec.ts`
asserts this on every build, for the whole migration history, so it cannot silently stop being true.

Because of that:

* **Application rollback does not need a schema rollback.** Deploy the previous image and leave the
  schema alone. The new columns and tables simply stop being read.
* **UI rollback** may restore the previous panel/list components without dropping new data. Chat
  messages, dismissals and change-set lineage columns stay in place and are picked up again when the
  new build returns.
* **Do not drop `sp_strategy_chat_message` or `sp_watch_dismissal` in an emergency.** Losing the
  dismissal table un-suppresses every permanently dismissed Watch finding on the next check; losing
  the chat table destroys user-authored content. Both migrations carry their exact manual rollback
  DDL in a `-- ROLLBACK` comment block, for the planned case only.
* **The old generic change-set APIs still work.** Phase 3 deliberately did not replace
  `ChangeSetsService.approve()/apply()`, and `POST /agents/change-sets` and the firm-level review
  queue are untouched, so any non-Watch producer keeps functioning after a UI rollback.
* **Disabling Watch v2 applies nothing automatically.** With `strategyWatcher` off, no check runs and
  no proposal can be accepted; existing proposals stay `proposed` and become visible again when the
  flag returns.
* **Per-strategy pause** is the finest-grained lever: pause the strategy's Watch mission in the panel
  rather than pulling the tenant flag.
* **Context messages are harmless historical records.** A `context_gap` message left behind by a
  rollback reads as an ordinary (resolved or active) line in the thread; nothing keys off it.

The one thing a schema rollback would need care with: `20260727010000` adds the value `superseded`
to the `sp_change_set_status` enum, and Postgres cannot drop a single enum value. Reversing that
requires recreating the type. Leave it.

## 5. What to watch after each step

All of these are server logs on `api-strategy` (no new metric pipeline was introduced):

| Signal | Log line |
| --- | --- |
| Conversation send succeeded | `assistant complete (<scope> scope, N edits, … ) in Xms` |
| Conversation send failed | `assistant failed for strategy <id>: …` |
| Idempotent replay of a send | `conversation send replayed idempotently (message <id>)` |
| Context load retried / recovered | `ContextLoad … transient load failure (attempt n/3)` / `… recovered after n retries` |
| Draft repair attempts + residual hard violations | `strategy draft: deterministic repair retimed N node(s), M error(s) remain` |
| Watch recheck duration + result counts | `Watch revalidate complete (reason:…): a unchanged, b updated, c dropped (d deleted-target) in Xms` |
| Accept / accept-all, with version id and size | `[strategy:… version:…] Watch change applied (change-set …, N ops)` / `Watch batch applied (N proposals, M ops)` |
| Permanent dismissals | `Watch proposal permanently dismissed (change-set …)` |
| Stale-head actions prevented | `Watch accept prevented on a stale head …` / `Watch accept-all prevented on a stale head …` |

None of these lines contain a message body, generated content, source document text or fact text —
`watch-review.service.spec.ts`'s cross-stage test asserts that for the accept path specifically.

Correlation: `sp_activity_log` rows carry `request_id` (`VersioningService.logActivity`), which is
the join key between a user action and its audit trail. The Watch panel surfaces server errors
through the shared `errorMessage()` path; there is no separate client-side correlation id.

## 6. Phase 7 handoff — states to capture

Phase 7 performs the visual-parity gate. It needs a tenant with **all four flags on** and the
fixtures below. URLs are relative to the web origin.

| # | URL | State to arrange | What Phase 7 captures |
| --- | --- | --- | --- |
| 1 | `/strategies` | ≥3 strategies, one with pending Watch proposals | Library + weekly nudge; no global Meri control |
| 2 | `/strategies/:id` | Meri-drafted plan, ≥8 steps spanning 3 FYs | Editor at vertical top, today centred, compact header |
| 3 | `/strategies/:id` | Panel open at strategy scope, ≥4 thread messages | Persistent drafted note, thread, pinned composer |
| 4 | `/strategies/:id?node=<id>` | Panel open at step scope | Step header, field editor, node actions, separate thread |
| 5 | `/strategies/:id` | ≥3 open Watch proposals incl. one dependency finding | Watch panel: Out of order card first, badges, Why expanded |
| 6 | `/strategies/:id` | Accept one, capture during the recheck | `Re-checking…` state with every action inert |
| 7 | `/strategies/:id` | A proposal whose target step was deleted mid-recheck | The calm dropped-proposal notice (never a red error) |
| 8 | `/strategies/:id` | A step carrying `provenance.contextNeeds` | Inline `needs context` marker |
| 9 | `/strategies/:id` | Strategy with an active `context_gap` message | The context-gap chat bubble |
| 10 | Goal flow on `/strategies` | Draft that 422s (dependency cycle / missing required input) | The inline typed-422 card, form state preserved |
| 11 | `/strategies/:id` | Flags `strategyPlannerMeri` off | Manual fallback: `Add step` + `Edit panel`, no chip |
| 12 | `/strategies/:id` | 1280 / 1440 / 1920 px at 100 / 125 / 150 % zoom | No document horizontal scrollbar; frozen column opaque |

States 7, 9 and 10 do **not** occur in the prototype's own demo data and have to be manufactured
(delete a proposal's target step mid-review; draft against a client with a missing required
document; submit a goal that cannot be satisfied). Phases 4 and 5 could not capture 7, 9 or 10
either — see the Known limitations in the Phase 6 report.

## 7. Known limitations carried into Phase 7

* No browser/E2E framework exists in this repo (no Playwright, no Cypress), so Scenarios A, E, F and
  H are automated at the jsdom level (`StrategyEditorPage.integration.test.tsx`) rather than in a
  real browser. Adding a framework is a **`LIA DECISION REQUIRED`** item, not a Phase 6 call.
* The migrate-from-clean and migrate-from-production-head runs could not be executed: there is no
  local Postgres in this environment and the only reachable database is production. The static
  additive/ordering guarantee (§4) is what stands in for them, and the DB-backed isolation probes in
  `test/watch-chat-isolation.int-spec.ts` self-skip until a `DATABASE_URL` is present.
* Browser-only performance budgets (center-today without a visible jump, panel-open immediacy,
  ResizeObserver thrash) are unmeasured for the same reason.
