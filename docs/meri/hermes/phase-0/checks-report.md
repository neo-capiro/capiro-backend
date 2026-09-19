# Checks report — Phase 0 meaningful checks

Prepared September 19, 2026. Status vocabulary: **passed** (assertion held), **failed** (assertion did not hold), **blocked** (could not be exercised; never counted as passed), **observed** (recorded behaviour without a pass/fail assertion). Evidence folders: `evidence/2026-09-19T13-48-15-436Z` (phase-1 run with two per-scope workers), later phase folders named in each section. Unit tests: 33 tests across 5 suites pass in the final state (`harness.md`).

## A. Pilot gate, spoofing, isolation, flag-off (run `2026-09-19T13-48-15-436Z`)

| Id | Check | Status | Evidence |
|---|---|---|---|
| unit | Three-key gate: env switch, canonical tenant-id allowlist (default empty, slugs ignored), explicit per-tenant true; spoofed tenant claims never open it | passed | `meri-hermes-flags.spec.ts` (6 tests) |
| unit | Proxy routes a pilot tenant to Hermes before V3, leaves others untouched, surfaces Hermes failure without fallback, works without an adapter | passed | `meriv3-runtime.proxy.spec.ts` (4 new tests) |
| ISO1 | Cross-user: Bob requests Alice's run by id → 404 | passed | `ISO1.json` |
| ISO2 | Cross-tenant: outside-tenant identity → gate `false`, stream refused (409 `NOT_ROUTED_TO_HERMES`) | passed | `ISO2.json` |
| ISO3 | Spoof: asserting the pilot tenant with a non-member identity → 403; tenant fields in the body are ignored | passed | `ISO3.json` |
| ISO4 | Broker boundary: tampered token 401, Bob's token on Alice's run 403 (`scope_mismatch`), unknown run 404, missing token 401, finished run 409 | passed | `ISO4.json` |
| ISO5 | Feature flag off at runtime: pilot gate `false`, stream not routed, `/api/clio/hermes/capabilities` 404; back on afterwards | passed | `ISO5.json` |
| D2c | Bob's run on **Bob's** worker recalls nothing about the walled client (granted to Alice only) or Alice's private fact; coverage reported complete/healthy with 0 items | passed | `D2c.json` — recall events show `path: direct_memory_items_prototype`, `returned: 0`; assistant text: "Nothing about a walled client was returned." |
| (prior run) | Bob's run routed to **Alice's** worker was refused by the broker with 403 `scope_mismatch` and the model reported the refusal honestly | observed | `evidence/2026-09-19T13-41-59-818Z/D2c.json` — the reason per-scope workers exist |

## B. Real execution, streaming, broker read/write (run `2026-09-19T13-48-15-436Z`)

| Id | Check | Status | Evidence |
|---|---|---|---|
| CAPS | Pinned build inspection: `/v1/capabilities` (run/stop/steer/approval/idempotency flags), `/v1/toolsets` lists the `meri` toolset with `meri_fetch_attachment`, `meri_publish_artifact`, `meri_request_clarification`; `/v1/skills` returns 500 on this build (recorded) | passed | `CAPS.json`, `hermes-capabilities.json`, `hermes-toolsets.json` |
| D1 | Real turn: `turn_accepted` at 36 ms, `start` 47 ms, native `terminal` tool call at 5.5 s, first text 6.2 s, `done{finishReason:'stop'}` 6.5 s; output quotes the shell result `MERI-D1-1789825765`; usage 23 k in / 104 out persisted | passed | `D1.json` |
| D2a | Broker read through Meri governed memory: firm fact `PHASE0-FIRM-FACT` returned with `source_id a0000000-…f001`; Bob's private fact absent; `memory.recalled` events logged with coverage | passed | `D2a.json` |
| D2b | Governed write: `meri_memory_propose` creates a real `memory_candidate` (`source_kind: model_extraction`, `governed_status: suggested`, `status: pending`); the model reported "pending … requires authorized review", not "saved" | passed | `D2b.json` — personal scope landed **pending** because the `model_extraction` review rule precedes the personal auto-commit rule (policy applied to runtime facts) |

## C. Personality, skills, worker replacement, automatic learning (D3; runs `2026-09-19T13-50-39-611Z` and `2026-09-19T13-53-10-659Z`)

| Id | Check | Status | Evidence |
|---|---|---|---|
| D3a (first run) | SOUL.md persona applied | **failed → fixed** | First run showed the worker's `SOUL.md` was Hermes' default ("You are Hermes Agent, built by Nous Research…"): the upstream first-boot hook seeds it before the Meri entrypoint, which only wrote the template when the file was absent. Fix: the persona is Meri-owned and is now rendered on every start (`entrypoint.sh`). |
| D3a (re-run) | SOUL.md persona applied natively (worker answers as Meri, chief of staff) | passed | `…13-53-10-659Z/D3a.json` |
| D3b | Explicit native skill creation: `skill_manage create` wrote `skills/…/meri-phase0-briefing/SKILL.md` with frontmatter (name, description, version 0.1.0, tags) and the `PHASE0-SKILL-MARKER` token | passed | `D3b.json` (`skillFilePreview`); `/v1/skills` 500 recorded as `skillsApi.error` |
| D3c | Worker replacement (container destroyed, scope volume kept): warm start 13.6 s; SKILL.md still present; SOUL.md identical; the next task loaded the skill (`skill_view`) and produced the skill-formatted briefing ending with the marker | passed | `D3c.json` (`reuseTextPreview` "Loaded skill: meri-phase0-briefing …") |
| D3d | Automatic learning probe: a 3-tool unrequested task (`terminal`, `write_file`, `terminal`) followed by a 45 s wait produced no background-review log lines and no new skill | observed | `D3d.json`. Upstream spawns the review only after ~10 tool iterations since the last skill activity (`agent/turn_finalizer.py`, `hermes-source-evidence-a.md` §5), so this is expected; the mechanism is source-verified for the `api_server` platform, not observed live. The re-run adds a `state.db` `session_model_usage` query by task to make any future review visible. |

Distinction recorded per the handoff: **explicit** skill creation was exercised and passed; **automatic/background** learning was probed but not triggered within Phase 0's short tasks.

## D. File ingestion, artifact publication and retrieval (D4; runs `2026-09-19T13-53-10-659Z` then `2026-09-19T13-57-09-201Z`)

| Id | Check | Status | Evidence |
|---|---|---|---|
| D4 (first run) | Ingestion via `meri_fetch_attachment` | **failed → fixed** | Hermes invokes plugin tool handlers with extra keyword arguments (`task_id`); the handlers only accepted `args` and returned "unexpected keyword argument 'task_id'". Handlers now accept `**kwargs`. The model reported the failure honestly and produced no artifact. |
| D4 (re-run) | Alice's DOCX attachment (Meri `ClioAttachment`, original bytes) materialised into the worker workspace by the broker; Hermes **native** `read_file` extracted the document and the answer quoted the unique sentence verbatim ("PHASE0-DOCX-SENTENCE: … October 7 per Chair Delgado … 12 million dollars"); the application-side extraction marker was **not** used; a 3-bullet summary was written and published with `meri_publish_artifact` → `ClioArtifact` `09116e60-…` with sha256; `GET /api/clio/hermes/artifacts/:id` → **200 for Alice, 404 for Bob** | passed | `D4.json` (`artifactBodyPreview`, `aliceDownloadStatus`, `bobDownloadStatus`) |

Native vs application-side: the file was handed to Hermes as bytes on its filesystem (the API has no upload path), and Hermes' own extraction (firecrawl-anydoc) read the DOCX. Meri's `textContent` extraction was available alongside but the check confirms the native path was used.

## E. Clarification and native approval (D5; runs `2026-09-19T13-58-39-857Z` and re-run `2026-09-19T14-00-17-963Z`, all four passed)

| Id | Check | Status | Evidence |
|---|---|---|---|
| D5a | Clarification through the broker adapter: `meri_request_clarification` produced a `clarify` frame with a `clar_…` request id; the run completed with an unresolved pending interaction (`durable_continuation`, no retained process); `GET …/events?after=0` **replayed the clarify frame after reconnect**; the next user message ("Fixture Client Open…") resolved the interaction and the answer confirmed the client | passed | `D5a.json` (`replayHasClarify: true`, `resolvedAfterAnswer: true`) |
| D5b | Native approval over `/v1/runs` with `HERMES_EXEC_ASK=1`: `chmod -R 777 …` raised `approval.request` ("world/other-writable permissions", choices once/session/always/deny); Meri run status `waiting_for_approval` with a `live_process` pending interaction; `POST /api/clio/hermes/runs/:id/approval {decision: deny}` → Hermes `approval.responded`, terminal tool **BLOCKED** ("Command denied by user"), model answered "DENIED" | passed (first run failed only on an HTTP 200-vs-201 assertion; functional evidence complete) | `D5b.json` (events seq 7–11), worker log |
| D5c | `approve_once` → Hermes resumed the blocked process, the command ran, model answered "RAN" | passed (same assertion fix) | `D5c.json` |
| D5d | Stop while waiting for approval → run `cancelled`, `finishReason: aborted`, no success text | passed (same assertion fix) | `D5d.json` |

Findings recorded for the ledger: native approvals are a **live retained-process** interaction bounded by `approvals.timeout` (300 s default; the pending interaction carries `expiresAt`), they exist only when the worker runs with `HERMES_EXEC_ASK=1` (otherwise the `api_server` platform auto-denies), and Hermes offers `session`/`always` choices that Meri deliberately does not expose. Clarification has no native path and the durable-continuation adapter is what makes "pending interaction after reconnect" work.

## F. Stop, disconnect/reconnect, fresh worker start (D6; run `2026-09-19T14-00-58-074Z` and the re-run named below)

| Id | Check | Status | Evidence |
|---|---|---|---|
| D6a | Explicit Stop during a 60-second terminal loop: `POST …/stop` → Hermes hard interrupt → Meri run `cancelled`, `done{finishReason:'aborted'}`; stop-to-terminal **225 ms**; a failure receipt was persisted, never a success | passed | `D6a.json` |
| D6b | Browser disconnect after the first text frame (9.5 s in): the adapter kept consuming on its own controller, the run **completed** with `detached: true`, the assistant message was persisted (eight-fact list ending "END"), and `GET …/events?after=0` replayed **127 frames / 584 text chars** including `done` | passed | `D6b.json` |
| D6c (first run) | Fresh worker start (container replaced, volume kept): restart **13.0 s**; the next turn correctly answered "I listed 8 facts, and the last word was END" — conversation continuity from Hermes' own `state.db` on the scope volume | **failed → fixed** | Functionally passed; the assertion failed because Meri had not captured the Hermes `session_id` (the `/v1/runs` acceptance body does not carry it). Two fixes followed: capture `session_id` from the run status after admission, and make the Hermes session key **per Meri conversation** — the per-user key used until then made Hermes treat all of a user's Meri conversations as one transcript (a real defect the harness surfaced). |
| D6a (re-run `2026-09-19T14-07-11-015Z`) | Stop during the terminal loop → `cancelled`, `done{finishReason:'aborted', partial:true}`; stop-to-terminal **840 ms** on a busy host (tsc + jest running concurrently) | passed | `…14-07-11-015Z/D6a.json` |
| D6b (re-run) | Disconnect at **2.1 s** after 3 frames → run completed `detached: true`; **97 frames / 474 text chars** replayed from `after=0` incl. `done`; assistant message persisted | passed | `…14-07-11-015Z/D6b.json` |
| D6c (re-run) | Fresh worker start (container replaced, scope volume kept) **26.5 s** on the busy host; Meri run record now carries Hermes `session_id` `run_180fae92…`; `GET /api/sessions/{id}/messages` → **200**; the continuation turn answered "I listed eight facts, and the last word was END." | **passed** | `…14-07-11-015Z/D6c.json` |
| PROBE | Transcript isolation between two conversations of the **same** user on the same worker after the session-key fix (manual probe, labelled, not a runner check): Alice's second conversation asked about "your previous answer in this conversation" answered exactly "NO PREVIOUS ANSWER." and is bound to Hermes session `run_1bca1e9a…`, distinct from conversation one's `run_180fae92…` | passed | `…14-07-11-015Z/PROBE-session-isolation.json` |

## G. Blocked / not exercised in Phase 0

| Item | Why | Where tracked |
|---|---|---|
| Steer during a run | not exercised live (endpoint implemented) | ledger A |
| Delegation / subagents live | not exercised (translator unit-tested) | ledger E |
| Bot Mode specialists, goals/heartbeat, cron wake, kanban | source-evidenced only | ledger E, `hermes-source-evidence-b.md` |
| Browser automation, media | not exercised | ledger F/D |
| arm64 image | not built | ledger F, backlog #3 |
| Governed recall through the real Context Plane rail | harness used the labelled direct port; production port wired in `MeriModule` but not run end-to-end | backlog #6 |
| Automatic (background) skill learning observed live | needs a ≥10-tool-iteration task; source-verified only (D3d observed) | ledger C, backlog |
| Durable run store / events across API restart | in-memory prototype (`MeriHermesRunStore`); replay verified within one API process only | contracts §tables, backlog #1 |
| Pilot tenant traffic (capiro-internal) | Phase 0 ran only against fixture tenants on a local DB; the canonical id `17b63099-…` is documented in `pilot-configuration.md` and is **not** set in any deployed environment | pilot-configuration.md |

## Recommendation

**Ready for Phase 1** — under the conditions below. Nothing in the evidence contradicts the plan's core bet: a pinned, unmodified Hermes build runs real agent turns for Meri with Meri's identity, memory governance, isolation and UI semantics enforced *outside* the worker, and the parts Hermes cannot do natively over its API (clarification, file ingestion, artifact retrieval, detach-not-stop, governed memory) are covered by thin adapters that were exercised end to end.

Evidence summary (final state of every check, all evidence under `evidence/`):

| Outcome | Count | Checks |
|---|---|---|
| passed | 21 runner checks + 1 labelled probe | CAPS, D1, D2a–c, D3a–c, D4, D5a–d, D6a–c, ISO1–5, PROBE-session-isolation |
| observed | 1 | D3d (background learning not triggered within a 3-tool task; mechanism source-verified) |
| failed (final) | 0 | five first-run failures (D3a persona, D4 handler kwargs, D2c cross-scope routing, D5 status-code assertion, D6c session binding) were each a real defect or a harness defect, fixed and re-run; the fixes are part of this branch |
| blocked / not exercised | see §G | none of them is required to *start* Phase 1; all are Phase 1 tickets |

Unit coverage: 33 tests in 5 suites pass; the API typecheck is clean apart from one pre-existing, unrelated TS1479 in `program-element/models/conference-probability.service.ts`.

Conditions that must hold before any tenant — including capiro-internal in staging — is routed to Hermes:

1. **Durable state**: replace the in-memory run store with the Prisma tables in `contracts.md` (runs, events, pending interactions) so replay, pending approvals and idempotency survive API restarts and replicas (backlog #1).
2. **Worker lifecycle**: replace the `MERI_HERMES_SCOPE_RUNTIMES` map with the lifecycle service (start/stop/replace per execution scope, per-worker API key and worker-token issuance, teardown grace for background review) (backlog #2, #4).
3. **arm64 image and task definition**: build with `PLATFORM=linux/arm64`, size from `measurements.md`, private networking from the API to workers only (backlog #3).
4. **Real Context Plane recall path** run end to end in the harness (the direct port used in Phase 0 is a labelled prototype) (backlog #6).
5. **Frontend**: approval / clarify / artifact / stop cards mapped in `contracts.md` (backlog #7–#9).
6. **Session-key rule** from D6c enforced in code review: one Hermes session per Meri conversation; never a per-user key.

Decisions that belong to the product owner, surfaced rather than made here: warm-capacity policy per scope (idle cost dominates, see `measurements.md`); default model (`gpt-5.6-terra` for turns and `luna` for auxiliary is the recommendation in `pilot-configuration.md`); whether native command approvals (`HERMES_EXEC_ASK=1`) are exposed to pilot users or only Meri business approvals in Phase 1; tenant persona ownership and versioning.

What "ready" does **not** mean: no deployed configuration was changed, the pilot flag is off everywhere, and no production tenant has been routed to Hermes.

---

# Corrections appendix (Phase 0/1 closeout, 2026-09-19)

Everything above is preserved exactly as written on 2026-09-19 during Phase 0. This appendix corrects claims that were wrong, stale, or over-stated, each with its reason. Where a correction is backed by a *new* test run, that is said explicitly; where it is a re-reading of the original evidence, that is said too. Corrections are authoritative where they conflict with the text above.

## C1. ISO2's `409 NOT_ROUTED_TO_HERMES` was a harness artifact

**Original claim (§A, ISO2):** "outside-tenant identity → gate `false`, stream refused (409 `NOT_ROUTED_TO_HERMES`)".

**Correction:** that status code exists nowhere in shipped code. It was synthesized by the Phase 0 harness's own bespoke server (`apps/api/scripts/meri-hermes-phase0-harness-api.ts`), which has no legacy/V3 route to fall through to and therefore had to invent a refusal. Real closed-gate behavior in production code is one of two things:

1. **Routing seam** (`apps/api/src/meri/meriv3-runtime.proxy.ts`): when `hermes.shouldHandle(ctx)` is false the request simply falls through to MeriV3/legacy. There is no Hermes-specific error at all — this is the intended "non-pilot tenants are unaffected" behavior, covered by `meriv3-runtime.proxy.spec.ts`.
2. **Direct Hermes control routes** (`apps/api/src/meri/hermes/meri-hermes.controller.ts`): `assertEnabled()` returns **404** for a tenant outside the gate, so the pilot surface is not merely forbidden but invisible.

**Evidence (new, production code, not the harness):** `apps/api/src/meri/hermes/meri-hermes-isolation.spec.ts` asserts the real 404 and the real fall-through. The gate-off case is additionally covered by `meri-hermes-flags.spec.ts`. ISO2's *finding* (an outside tenant cannot reach Hermes) stands; only the recorded status code was wrong.

## C2. D6c session-key rule is retained and now has both isolation directions

The D6c fix stands and is still in the code: the Hermes session key is `tenant:<t>:user:<u>:conversation:<conversationId>` (`meri-hermes-runtime.adapter.ts`), never per-user. Both isolation directions are evidenced:

- **Two conversations, same user:** `evidence/2026-09-19T14-07-11-015Z/PROBE-session-isolation.json` (second conversation answered "NO PREVIOUS ANSWER.", bound to a distinct Hermes session).
- **Two users:** ISO1 plus D2c, now also asserted in production-code tests (`meri-hermes-isolation.spec.ts`).

## C3. Explicit skill creation passed; automatic learning did **not**

The original report already separated these in prose (§C), but `capability-ledger.md` row C "Automatic learning (background review)" is labelled **"verified mechanism / observed"**, which reads as a pass. It is not one.

- **Explicit** `skill_manage` creation (D3b) and reuse after worker replacement (D3c): genuinely **verified**.
- **Automatic/background** learning (D3d): **not verified live.** The probe ran a 3-tool task; upstream only spawns background review after ~10 tool iterations since the last skill activity, so nothing was triggered. The mechanism is source-verified only.

**Phase assignment:** automatic learning, the skill registry, curator, staged skill approval and persona controls are **Phase 2B**, not Phase 1. Nothing in Phase 1 depends on them. Phase 1 must only ensure that if background review is enabled, its work is not silently discarded by idle teardown — and if it is disabled, that this is explicit and verified (see the Phase 1 closeout report).

## C4. Stale statements superseded by Phase 1 implementation

| Stale statement | Where | Correct as of commit `493d3079c` |
|---|---|---|
| "Durable run store / events across API restart — in-memory prototype (`MeriHermesRunStore`); replay verified within one API process only" | §G, contracts.md §4.2, `meri-hermes-run-store.ts` header | **Superseded.** Runs, events and pending interactions are Prisma-backed (`MeriHermesPrismaRunRepository`, tables `meri_agent_runs` / `meri_agent_run_events` / `meri_agent_interactions` / `meri_execution_scopes`, migrations `20280920010000_meri_hermes_durable_runs` and `20280920020000_meri_hermes_admission_fencing`). `MeriHermesRunStore` survives only as the in-memory test double. Cross-replica *live push* is still in-process — tracked as a Phase 1 closeout requirement, not as "no durable store". |
| "Decisions that belong to the product owner, surfaced rather than made here: warm-capacity policy, default model, whether native command approvals are exposed, tenant persona ownership" | Recommendation section | **All settled.** See `docs/meri/hermes/phase-1/decisions.md` for each value and its provenance. They must not be re-asked. |
| "none of them is required to *start* Phase 1; all are Phase 1 tickets" | §G | **Wrong on the second clause.** Several §G items are not Phase 1 work at all (see C5). |

## C5. §G items reassigned to their actual milestones

| §G item | Actual milestone |
|---|---|
| Durable run store / events across API restart | **Phase 1 — done** (ticket #1) |
| Governed recall through the real Context Plane rail | **Phase 1** (ticket #6) |
| arm64 image | **Phase 1** (ticket #3) |
| Pilot tenant traffic (`capiro-internal`) | **Phase 1 deployment validation**, gated on an authorized environment |
| Steer during a run | **Phase 1** for the endpoint + an explicit UI capability statement; full steering UX is P1/5A — assignment resolved explicitly rather than dropped |
| Automatic (background) skill learning observed live | **Phase 2B** |
| Delegation / subagents live | **Phase 5A** |
| Bot Mode specialists, goals/heartbeat, cron wake, kanban | **Phase 5 / 5A** |
| Browser automation, media | **Phase 5A** |

## C6. A proposed memory is not a saved memory

D2b is correct as recorded but easy to misread, and `capability-ledger.md` row B "Memory write = governed candidate … **verified**" compounds it. To be unambiguous: Phase 0 verified that the runtime can **propose** a memory candidate which lands `governed_status: suggested` / `status: pending`, and that the model reported it as pending rather than saved. Phase 0 **never observed a commit** of a proposed memory into authoritative institutional memory, and the runtime is never an admin. "Proposed" must be reported as proposed until the authoritative service actually commits it.

## C7. The data inventory counts schema declarations, not distinct business tables

### C7.1 The count

`data-inventory.md` reports **549 models across 12 schemas**, and `capability-ledger.md` row B says "Comprehensive authorized data access (549 models)" with a "340-model gap". These are **Prisma model declarations**, not 549 distinct business tables. Six of the twelve schemas are explicitly projections of the main API schema (`api/non-rdte-projection` 12, `api/outreach-v3-phase2` 4, `api/outreach-v3-phase3` 2, `api/outreach-v3-templates` 5, `api/phase6-projection` 3, `api/rdte-projection` 3 = 29 declarations), and cross-service schemas may model the same underlying entity more than once. The inventory's own header already labels itself heuristic and owner-review-required; that caveat is load-bearing and must accompany any coverage claim. Establishing the real count of distinct, policy-classified business entities is **Phase 2A** work and is a precondition for any "comprehensive coverage" statement.

### C7.2 The classifier **fails open**, and `--check` is much weaker than "coverage validation" implies

"Heuristic, owner review required" reads far milder than the actual behaviour. Raised by the Phase 2 orchestration session from a read-only pass and **independently verified here** against `scripts/meri-hermes/generate-data-inventory.mjs` and the generated `data-inventory.json`:

**Absence of evidence yields the most permissive scope.** The pass-3 rule is `if (targets.every((t) => t.scope === 'global_reference'))`. `[].every(...)` is `true`, so a model with no tenant/user/client field **and no outgoing FK relations** is classified `global_reference` rather than `unknown` — the code even writes the evidence string `"no tenant/user/client field and no outgoing FK relations"` for that case. Measured: of **266** `global_reference` models, **167 reached it by this fail-open path.**

**`client` scope is structurally almost unreachable.** The pass-1 chain tests `tenantId` before it ever reaches the `clientId` branch, so any model carrying both is `tenant` and can never be `client`. Measured: **97** models carry a real `clientId` field; **96** are recorded `tenant` and exactly **one** model in all 549 is `scope: client` (the already-known `LdaFiling` mis-scope). **Restricted-client policy is therefore not expressible in this inventory at all** — a materially bigger problem than the three individually-named mis-classifications, because restricted-client denial is one of the isolation properties the pilot depends on.

**The `--check` gate does not gate what its name suggests.** It fails on only three things: a model with `scope === 'unknown'` (there are **2**), a missing baseline, and a **new** business model with no read path *where `sensitivity === 'business'`*. Consequences, all verified in the source: `pii_contact` models with no read path never trip it (the filter requires `business`); none of the 167 fail-open models ever trip it; and although the baseline stores `{scope, sensitivity, kind, existingReadPath}` per model, the check only tests key **membership** (`!(modelKey(x) in base.models)`) — so **widening an existing model's scope, or removing its read path, passes silently.** Unparsed schema constructs are `console.warn` only and never fail the run.

**What this changes.** Nothing in Phase 1 depends on this classifier, so it is not a Phase 1 blocker. But it must not be cited as coverage validation. Phase 2A's acceptance criterion — "unclassified migration fails CI" — is **not** met by `--check` in its current form, and `phase-2-handoff.md`'s reference to a coverage CI gate should be read against this section. Fixing the fail-open default (absence of evidence must yield `unknown`, not `global_reference`), making `client` reachable, and making the baseline comparison value-sensitive rather than membership-only are **Phase 2A/2 prerequisites**, owned by the Phase 2 workstream, which has them in its backlog.
