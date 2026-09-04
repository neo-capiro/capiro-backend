# Proposed changes to `completion-matrix.md`

**This is a proposal, not an edit.** Nothing in the real
`docs/plans/funding-opportunities-makegov-v1/completion-matrix.md` was modified. Every
"BEFORE" block below is quoted verbatim from
`git show d800dcfde5:docs/plans/funding-opportunities-makegov-v1/completion-matrix.md`, and
line numbers are as of that commit. Apply, amend or discard as you see fit.

**Two sources feed these edits:**

1. The **verdicts** of the 15 independent reviews in `independent-review/`, which replace
   `*pending*` / `*self-verified only*` in the Review column for **43 of 52 phases**.
2. The **14 documentation findings** in `independent-review/band-a-p51-ga-closeout.md`
   (F-01 … F-14), every one of which that review confirmed as a pure-documentation,
   no-risk correction — no code, no deploy, no key, no human judgement, with the single
   exception of F-08 (design-partner acceptance), which is flagged below as a decision.

**Headline numbers after these edits:**

| Review column value | Count |
|---|---:|
| `FAIL` | **14** — P08, P11, P19, P26, P27, P28, P40, P41, P42, P43, P46, P49, P50, P51 |
| `PASS WITH NON-BLOCKING NOTES` | **27** |
| `PASS` | **2** — P00, P09 (Band C attestation) |
| unchanged (`*pending*` / `*self-verified only*`) | **9** — P05, P20, P21, P31, P37, P38, P39, P44, P45 |

Before these edits the matrix carried **zero** §6.2 verdicts across all 52 rows.

**One judgement call flagged up front.** Six of the reviews are *band* reviews covering a
cluster of phases with a single verdict string, and their findings are explicitly
cross-phase — `band-b-ingestion-adapters.md` says four of its ten findings "become obvious
only when two phases are read against each other." The per-row split below applies a
consistent rule: **a row reads `FAIL` when a P0 or P1 finding lands on it, and
`PASS WITH NON-BLOCKING NOTES` when only P2/P3 findings do, with the band verdict string
recorded either way.** Rows where the band verdict is a rejection but nothing lands say so
explicitly. If you prefer to propagate the band verdict to every row in the band, the rows
that would flip are named in §1.4.

---

## §1 — Review column: 43 replacements

### 1.1 The format

Each replacement records four things: the matrix-vocabulary verdict (per the legend at
`:12`), the review's own two-string verdict, the review file, and the finding IDs that land
on that row. Reviews are all dated 2026-08-13 and pinned to `d800dcfde5`; that is stated
once here rather than repeated in 43 cells.

### 1.2 Rows currently reading `*pending*` (P00–P25)

| Line | Phase | BEFORE | AFTER (proposed) |
|---:|---|---|---|
| 35 | P00 | `*pending*` | `PASS` — `P00_BAND_C_ATTESTATION_CONFIRMED_INERT`, `independent-review/band-c-attestation.md`. Band C attestation, not §6.2: the one question asked was whether the diff changes runtime behaviour. Six files, **zero production code**; the only non-doc/test/fixture change is the CI floor bump. Verified against P00's own isolated commit `0e4a73726`, not the combined PR #769 diff. |
| 36 | P01 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `FO_GA_BAND_B_MATCHING_SCORING_REJECTED`, `independent-review/band-b-matching-scoring.md`; **no finding lands on P01, which was verified sound**: one shared `CLIENT_PROFILE_SELECT`, grant shaping delegated rather than reimplemented, fingerprint canonicalized excluding `completeness` and any local clock, `identityBasis` folded in, transaction-ownership split correct. Note B-3/B-4 (P2): the read-time/producer drift P01 exists to prevent has reappeared **one layer above** the profile — three copies of the capability-text comparison, and a third private `normAgency`. |
| 37 | P02 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `FO_GA_BAND_B_MATCHING_SCORING_REJECTED`. **P02 verified sound, live**: rail-level exclusivity implemented as specified, `nameIsUsable` rejects unrecorded/fuzzy/tier ≥ 4, `contractorIdsToResolve` filters non-UUIDs before the `::uuid[]` cast for the stated (correct) reason, exactly one query per rail and never an OR; all three seeded clients resolved `exact_uei` on both rails with the rails staying separate. Undocumented consequence recorded by the review: `profile.identityBasis` does **not** describe how DIBBS award evidence was obtained, so a surface rendering "matched on your UEI" would make a false claim about a `prior_cage_award_history` row. |
| 38 | P03 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED`, `independent-review/band-b-lifecycle-events.md` (the review maps its own verdict into this column's vocabulary explicitly). Every raw SQL callsite executed verbatim against a real 263 + 26-migration Postgres **as `capiro_app`, a non-superuser, under FORCE RLS**. Non-blocking: **F-1 (Medium) names P03 and P04 specifically** — `statusFromCounts` reads only `complete` and `errors`, so a run that evaluates 2,004,501 pairs and writes zero rows is byte-identical in the dashboard to a correct one; F-3 (the headline 4,001×501 tests run `commit: false`); F-4. |
| 39 | P04 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED`, `independent-review/band-b-lifecycle-events.md`. As P03. Non-blocking F-1, F-3. |
| 40 | P05 | `*pending*` | **UNCHANGED** — no review in this effort covered P05. |
| 41 | P06 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `FO_GA_BAND_B_MATCHING_SCORING_REJECTED`; **no finding lands on P06, verified sound**: first-match-wins over an eight-rule ordered list with both hard invariants sitting first so nothing later can override them; the P23 override correctly restricted to intercepting only the Rule 7 `pursue`; `asOf` is the caller's clock throughout, no `new Date()` in the module. |
| 42 | P07 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_A_P07_P08_REJECTED`, `independent-review/band-a-p07-p08.md`; **the rejection is P08's — "P07 is not the reason for this verdict."** Every claim in this row was re-derived independently: clean 263-migration replay from a verified-empty `pgvector:pg16`, and all six bad-data shapes **re-proved rejected by execution** against real Postgres with two positive controls and exactly three surviving rows. Non-blocking F-4 (the CHECK-rejection proof is prose only — CI asserts the constraints *exist*, never that they reject, and never asserts their definitions), F-5, F-6. |
| 43 | P08 | `*pending*` | `FAIL` — `BAND_A_P07_P08_REJECTED`, `independent-review/band-a-p07-p08.md`. **Two of this row's own Live-acceptance claims are disproven by execution.** §3: *"Retry returns the SAME task (`reused: true`) and creates none"* is **false under concurrency** — the guard is `findFirst`-then-`create` at READ COMMITTED with no unique index; two concurrent invocations produced two rows, and eight genuinely parallel invocations **with no injected delay** produced duplicates. Postgres then refused to build a unique index on `(tenant_id, source_type, source_id)` because of them (`23505`). §4: *"Task due date and opportunity next-action date are the same value"* breaks on the reuse path. **What holds:** atomicity — the phase's actual purpose — is real and proven against real Postgres, with no hidden fallback to `this.prisma`. Non-blocking F-3 (the suite is entirely fake-backed and the two tests named as proof of the core property assert the fake's own hand-written rollback). |
| 44 | P09 | `*pending*` | `PASS` — `P09_BAND_C_ATTESTATION_CONFIRMED_PRESENTATION_ONLY`, `independent-review/band-c-attestation.md`. Ten files, four production; all four confirmed to operate only on values the scorer already assigned (`strength`, `matchedOn`, `relevanceScore`, `decision`), with no scorer/recommendation/eligibility file in the diff and **zero callers** of the new API module (verified by grep at the commit, not inferred). Verified against P09's own isolated commit `8c432a54b`. |
| 45 | P10 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_UI_TRIAGE_REJECTED`, `independent-review/band-b-ui-triage.md`; no blocking finding lands on P10. Non-blocking B-6 (P3): the web's `INBOX_SOURCES` mirror is a hand-copied flat literal while the API's spread is pinned by regex *specifically because a hand-kept copy could drift* — and no web test references it at all. B-7 (P3): no inbox test ever renders a `grants_gov` row. |
| 46 | P11 | `*pending*` | `FAIL` — `BAND_B_UI_TRIAGE_REJECTED`, `independent-review/band-b-ui-triage.md`. **B-1 (P1) disproves this row's own acceptance claim** that the empty state distinguishes four causes: it does so for two of five rails only. `OpportunitySourceFreshness.source` is typed `OpportunitySource` = `'grants_gov' \| 'sam_gov'`, so `neverSynced` / `lastRunStatus` / `lastFailureAt` are **structurally inexpressible** for `agency_forecast`, `dibbs` and `sbir_sttr`; composed with an unchanged two-rail empty-state sentence that never names the rail and fires before the `totalHere === 0` branch, a never-ingested rail renders as *"there is nothing on the DLA bid board for you."* B-2 (P2): a fully-withheld page suppresses `fo-pager`, stranding every later page of that queue. "Profile data is thin" has no inbox branch at all — `InboxResponse` carries none of the three fields the catalog response does. |
| 47 | P12 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_UI_TRIAGE_REJECTED`. **Question 1 passes cleanly for this row**: the D-67 dispatch fix held and generalised — every rail is explicitly named in both detail frames, and `asCatalogRef` delegates to a positive two-string whitelist rather than a negative test. Non-blocking B-3 (P2): the drawer's forecast branch renders `ForecastOpportunityDetail` unconditionally, skipping the flag check the full page requires and justifies, so a shared `?detail=agency_forecast:…` link gives a tenant without the flag a three-way hedge — the exact presentation the full page's comment rejects. |
| 48 | P13 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `FO_GA_BAND_B_INFRA_REJECTED`, `independent-review/band-b-infra-deploy.md`; **no finding lands on P13.** `20260820010000_funding_opportunity_generic_source` was read in full context and passes scope item 1(a): `..._source_chk` is strictly widening so no existing row can fail, and `..._one_source_chk`'s genuine rewrite is ordered **after** the backfill that makes existing rows conformant. Its comment block — documenting that `NULL = 'x'` is NULL and a CHECK passes on NULL, rehearsed against `pgvector:pg16` before the comment was written — is singled out as *"the standard this review would want everywhere."* |
| 49 | P14 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`, `independent-review/band-b-ingestion-adapters.md`. Non-blocking B-6 (P2): `tango.client.ts:591`'s shared `page()` helper does `for (const raw of response.results ?? [])` behind **all six** SDK-backed list endpoints — every network read P19/P22/P24/P27/P28 make — so a response without `results` and without `next` reports `completeness: 'complete'` with zero rows, the precise "0 records, complete" outcome the DIBBS/SBIR client headers name as the failure mode to prevent. The SDK's type is a compile-time claim about a server this program has caught the SDK being wrong about four times (D-35, D-41, D-42, D-45). |
| 50 | P15 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`; **no finding lands on P15, and its central seam was verified clean in both directions.** The `tango_sync_checkpoint.resource_type` boundary: the CHECK admits exactly six values and has never been widened by any migration; the TypeScript vocabulary matches value-for-value; every write is guarded by `assertKnownResourceType`; every call site passes a literal from the allowed set; DIBBS and SBIR never write a checkpoint row at all. **No write path exists that could hit the CHECK and no coercion path exists that could produce a wrong-but-successful write** — "the one seam in the cluster that is exactly as clean as its documentation claims." |
| 51 | P16 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `FO_GA_BAND_B_INFRA_REJECTED`, `independent-review/band-b-infra-deploy.md`. **Scope item 2 passes live and exhaustively**: all **227** active task-definition families in the account were enumerated and exactly one — `capiro-dev-api-sync-jobs` — references `TANGO`. The IAM layer holds independently of the task definitions: `TangoApiKeyRead` is scoped to a single secret ARN with no wildcard, attached to one role used by one task definition, and the serving API / `api-migrate` / `meriv2-orchestrator` share a different execution role with **zero** references to `tango`. So the serving task **cannot read** the key, which is stronger than the code comment claims. Non-blocking F-3 (MEDIUM): the code enforcing this is undeployed — `capiro-dev-api-sync-jobs` is not a CloudFormation resource at all — so the boundary holds by manual convention and nothing re-asserts it. |
| 52 | P17 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`; also reviewed by `independent-review/band-b-alerting-observability.md`, which rates `diag-tango-capabilities` / `tango-capability-probe.service.ts` **the strongest of the six diagnostics** — seven distinct outcomes each carrying an explicit reason, an auth failure on the version preflight short-circuiting the rest *and labelling itself as such*, and no coercion toward healthy anywhere in the file. Non-blocking B-8 (P2): the `rate_limited` fix — one of this program's two known "broken reads as healthy" incidents, carrying a twelve-line comment about the 2026-08-08 misdiagnosis — has **zero test coverage**; the 549-line spec contains no occurrence of the string. |
| 53 | P18 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`; **no finding lands on P18, and its mechanism was verified sound** — `TangoResilienceService`'s breaker semantics match `config.schema.ts`'s pre-existing description exactly, including the half-open-failure-reopens rule (D-32). The band's P0 (B-1) is that **P19 does not use it**: P18's own class doc names P19 as "the first real consumer", and P19 is the one consumer of five that never adopted the ceiling-handling idiom. A seam defect, not a phase defect. |
| 54 | P19 | `*pending*` | `FAIL` — `BAND_B_INGESTION_ADAPTERS_REJECTED`, `independent-review/band-b-ingestion-adapters.md`. **B-1 (P0), the band's sole rejection ground.** `runEntitySync`'s catch-all (`sync-tango-entities.ts:205`) swallows the three errors P18 exists to raise — `TangoRequestCeilingExceededError`, `TangoCircuitOpenError`, `TangoAuthRejectedError` — then advances the cursor unconditionally (`:217`) and writes `completeness: 'complete'` from a purely structural batch test that never consults `errored`. A rejected key, an exhausted ceiling and an open breaker each produce a run byte-for-byte indistinguishable from a healthy one, exit 0. **Four sibling scripts already carry the correct shape** (`sync-tango-vehicles.ts:230`, `-forecasts.ts:195`, `-opportunity-notices.ts:262`, `-opportunity-shadow.ts:247`); P19, the earliest consumer, was left behind. P0 rather than P1 because `ingestion-schedule.ts` puts five Tango jobs on the same rate-limited account within 85 minutes, so P50's enablement is followed immediately by the condition that makes this fire, unattended. |
| 55 | P20 | `*pending*` | **UNCHANGED** — no review in this effort covered P20. |
| 56 | P21 | `*pending*` | **UNCHANGED** — no review in this effort covered P21. |
| 57 | P22 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`. P22 is recorded as one of the three **best-evidenced phases in the cluster** — run live with a real key against a real database, and it *found real defects that way* (D-41, D-42, D-43). Non-blocking B-6 (P2): its network reads go through the shared `page()` helper's silent `?? []` coercion. |
| 58 | P23 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `FO_GA_BAND_B_MATCHING_SCORING_REJECTED`; **no finding lands on P23, and the brief's premise that it should carry `recommendationConfidence`/`clearsSuggestionFloor` is recorded as false.** P23 is a client-posture six-state truth table, not a relevance scorer; it does not consume `ClientOpportunityProfileV1` and correctly does not need to. Its exclusion from P01 is right, not drift. |
| 59 | P24 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`. One of the three best-evidenced phases (two live commit runs; D-45's three confirmed field findings). Non-blocking B-5 (P2): `tango_procurement_forecast` carries **no content hash**, one of the three provider-exclusive datasets D-02 names by name; D-46 explains why it is not a versioned snapshot table but does not address D-02's independent provenance requirement, and no decision-log entry, handoff or schema comment records the omission. B-6 (P2). |
| 60 | P25 | `*pending*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `FO_GA_BAND_B_MATCHING_SCORING_REJECTED`; **no finding lands on P25**, and its lack of a `clearsSuggestionFloor` is recorded as correct rather than drift — it is a read path with no producer, so a floor would be dead surface. Non-blocking B-3/B-4 (P2): P25's `containsWholeToken` is the *right* implementation that the two newer producers did not adopt, and its file-private `normAgency` is the one whose docblock describes a parenthetical-stripping rewrite it does not actually perform. |

### 1.3 Rows currently reading `*self-verified only — no independent reviewer*` (P26–P39, P44, P45, P46)

| Line | Phase | BEFORE | AFTER (proposed) |
|---:|---|---|---|
| 61 | P26 | `*self-verified only — no independent reviewer*` | `FAIL` — band verdict `BAND_B_UI_TRIAGE_REJECTED`, `independent-review/band-b-ui-triage.md`, and `FO_GA_BAND_A_FLAG_GUARD_REJECTED`, `independent-review/band-a-flag-guard.md`. B-1 (P1): the forecast rail's staleness is structurally unrepresentable — `readFreshness()` lists two rails and the type excludes the other three. Flag-guard F-5 (MEDIUM): **the forecast rail has had the same ungated-inbox shape since P26** — `funding_opportunities_forecasts` guards the forecast *detail* route (404 when off) but does not filter forecast rows out of the inbox JSON; the browser is the only thing withholding them. The service's own header records that the inbox *"has ALWAYS returned a forecast-sourced row when one existed."* |
| 62 | P27 | `*self-verified only — no independent reviewer*` | `FAIL` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`, and `P50_SCHEDULE_ENABLEMENT_REJECTED` F6 (P1). **This row is marked `deployed`, and the sync has no EventBridge declaration at all** — not even one marked `enabled: false`, unlike every other FO job in `ingestion-schedule.ts`. It is runnable by hand and schedulable by nobody, so not even the forbidden `cdk deploy` would create its rule. B-7 (P2). Additionally, **no live-key run of this sync script is recorded anywhere**: its Live-acceptance cell names a code property, which is real work but is not real-provider-data evidence that the sync produces correct rows. |
| 63 | P28 | `*self-verified only — no independent reviewer*` | `FAIL` — as P27. `sync-tango-opportunity-notices` has a dispatcher verb (`:692`) and no EventBridge declaration, while **`ProcessTangoEvents`'s own comment orders the drain after it** ("ORDER MATTERS: this reads what `sync-tango-opportunity-notices` holds and does not fetch inline"). When P50 enables the declared rules, the event drain will run daily against a table nothing scheduled populates, correctly find no changes, and report success indefinitely. No recorded live-key run. |
| 64 | P29 | `*self-verified only — no independent reviewer*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`. Non-blocking B-7 (P2): runnable verb (`:702`), no EventBridge declaration, row marked `deployed`. B-9 (P3): **`sync-tango-opportunity-attachments.ts:171` contains a literal NUL byte** as a dedupe-key delimiter, so git treats the file as binary and it produces **no textual diff in any PR or review tool** — for the file driving this phase's SSRF-guarded fetch loop. No recorded live-key run; P17 returned `not_found` for `attachment_metadata` and asked for a deliberate follow-up that no decision-log entry records (arguably moot, since P29 reads `sam_opportunity.raw` rather than Tango — but that reasoning is not written down anywhere either). |
| 65 | P30 | `*self-verified only — no independent reviewer*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`. Non-blocking B-7 (P2). P17 returned `not_found` for `extracted_text` and its open question is still open on paper. The review records that **P30 sidesteps this honestly** — it makes no provider call and seeds explicit `not_entitled`/`pending` statuses, so the phase is correct about what it does not know. |
| 66 | P31 | `*self-verified only — no independent reviewer*` | **UNCHANGED** — no review in this effort covered P31. |
| 67 | P32 | `*self-verified only — no independent reviewer*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_UI_TRIAGE_REJECTED`; no finding lands on P32. `OpportunityAssessmentPanel` is mounted only inside `FundingOpportunityDetail`, which takes `CatalogOpportunityRef`, so **the compiler rather than a convention keeps it off the other three rails.** Separately flagged by `independent-review/band-c-attestation.md` as a **plausible additional Band C candidate** — its diff touches zero files under `apps/api` and its API-side change is constant maps keyed on the pre-existing `MachineRecommendation` type. That is a lead, not an attestation: `OpportunityAssessmentPanel.tsx` was not read in full. |
| 68 | P33 | `*self-verified only — no independent reviewer*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_UI_TRIAGE_REJECTED`; no finding lands on P33, and it is recorded as **catalog-scoped by construction, honestly**: `GovernmentLandscapePanel` narrows further to `sam_gov` with a stated sentence for the grant case, separates `not_wired` from `empty` ("Nothing here says none exist" vs "Capiro looked and found nothing"), and separates a request failure from an absence of context. |
| 69 | P34 | `*self-verified only — no independent reviewer*` | `PASS WITH NON-BLOCKING NOTES` — band verdict `BAND_B_UI_TRIAGE_REJECTED`; no finding lands on P34. Catalog-scoped by construction, same mechanism as P33. |
| 70 | P35 | `*self-verified only — no independent reviewer*` | `PASS WITH NON-BLOCKING NOTES` — `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED`, `independent-review/band-b-lifecycle-events.md`. **Optimistic concurrency verified against the current schema by execution, not by reading**: the stale-version replay affects zero rows, and the database itself — not just the service — refuses a terminal transition with a null reason (`funding_opportunity_stage_transition_reason_chk`). P35 is additionally recorded as **structurally immune** to the never-executed-SQL class: it writes exclusively through Prisma model calls checked against `schema.prisma` at generate time. |
| 71 | P36 | `*self-verified only — no independent reviewer*` | `PASS WITH NON-BLOCKING NOTES` — `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED`. **Append-only reopen proven against the current schema by insert**: a second row for the same `source_id` is accepted, the widened `pursuit_won` kind is live, and the prior row's distinct `notes` and `evidence_jsonb` are provably untouched. Also confirmed: there is **no** unique constraint or unique index on `(tenant_id, client_id, source_type, source_id)` in the current schema, so nothing prevents the second row structurally. A silent zero-write is caught loudly here — a plain INSERT either writes or throws. |
| 72 | P37 | `*self-verified only — no independent reviewer*` | **UNCHANGED** — no review in this effort covered P37. |
| 73 | P38 | `*self-verified only — no independent reviewer*` | **UNCHANGED** — no review in this effort covered P38. |
| 74 | P39 | `*self-verified only — no independent reviewer*` | **UNCHANGED** — no review in this effort covered P39. (Note: `funding_opportunities_tango_mcp` **is** genuinely enforced server-side — `independent-review/band-a-flag-guard.md` §2 row 12 confirms the catalog entry is hidden and a connect attempt refused — but P39's own live-handshake gap is untouched by that review.) |
| 79 | P44 | `*self-verified only — no independent reviewer*` | **UNCHANGED** — no review in this effort covered P44. |
| 80 | P45 | `*self-verified only — no independent reviewer*` | **UNCHANGED** — no review in this effort covered P45. (Note: `band-a-flag-guard.md` reviews the guard file P45 last touched and finds it **well built and fail-closed on all three paths**, but that is not a review of P45's protest/exclusion risk-context deliverable.) |
| 81 | P46 | `*self-verified only — no independent reviewer*` | `FAIL` — `P46_REJECTED`, `independent-review/band-a-p46-webhooks.md`. Failing on review questions 2, 3, 4 and 5. **F1 (P0):** every delivery body the provider's own pinned SDK documents is rejected `missing_delivery_id` → 400 → *"stop retrying"* → permanently lost. Executed against P46's own exported `readEnvelope` with the SDK's own documented payloads. **F2 (P0):** the only surviving id path is `x-tango-delivery-id`, which appears nowhere outside Capiro's source — so the migration's "whole replay defence" is keyed on an unsigned, attacker-controllable header; one captured signed body replayed under three forged headers produced three distinct admissible rows. **F3 (P1):** the SDK's own verifier accepts a bare-hex signature that P46 401s. **What passes cleanly:** review question 1 — the raw-bytes-before-JSON ordering invariant holds end to end across the whole chain, the HMAC is correct with real (not mocked) crypto tests, the retry contract is right, and PR #834's fix survived two later fix rounds. |

### 1.4 Rows currently reading `*self-verified only*` and the two special cells (P40–P43, P47–P51)

| Line | Phase | BEFORE | AFTER (proposed) |
|---:|---|---|---|
| 75 | P40 | `**read by Neo 2026-08-08** — the first human review any phase in this program has had; §6.2's independent tester still has not run` | `FAIL` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`, `independent-review/band-b-ingestion-adapters.md`. **§6.2's independent tester has now run.** B-2 (P1): the DIBBS sync retries **429 only** — `isRateLimited` is `status === 429` and nothing else, while the shared mechanism's `RETRYABLE` set covers all 5xx, 408 and a null status; a timeout raises status `0`, is not retried, propagates uncaught through the endpoint loop and **aborts the whole run**, discarding the RFP and award walks. D-65 was fixed exactly as wide as the live run's evidence and the shared mechanism's broader policy was never consulted. B-3 (P0, with `band-b-alerting-observability.md`): this call path writes no `tango_api_usage` row, so `diag-tango-health` and the canary's 429 count are structurally blind to it. B-5 (P2): no content hash, no source URL and no raw payload on `tango_dibbs_award`. **Retained from the prior cell:** Neo's 2026-08-08 read of #857/#860/#861 was the first human review of any phase; the matrix's own rule at `:272` still applies — do not upgrade it into "the gate ran." |
| 76 | P41 | `*self-verified only. Neo read #867 and #870 as owner reviews; **§6.2's independent tester has still never run for any phase in this program***` | `FAIL` — `FO_GA_BAND_B_MATCHING_SCORING_REJECTED` (`independent-review/band-b-matching-scoring.md`) and `FO_GA_BAND_A_FLAG_GUARD_REJECTED` (`independent-review/band-a-flag-guard.md`); the producer wiring itself is `D79_PRODUCER_WIRING_INDEPENDENTLY_APPROVED` (`independent-review/band-a-d79-producer-wiring.md`). **B-1 (P1), proven by running the real producer against real Postgres seeded from this repo's own real capture fixtures:** `hasPriorCageAward` has **no item predicate at all** and is cached per client, so the one signal that can clear the suggestion floor fires on **10 of 10** open items — fibrous rope, machine bolts and multi-leg slings recommended to an actuation-systems manufacturer, with the stated reason "a prior DLA award … on this kind of item." The scorer is correct given an item-scoped input; the producer's field comment and the branch's user-facing prose describe two different signals. **Flag-guard F-1/F-2 (HIGH):** the DIBBS inbox rail introduced by part 2 has **no capability flag at any layer** — `funding_opportunities_dibbs` is zero matches repo-wide — a literal violation of D-07. **What passes:** the D-79 producer wiring is correct as merged, and the specific bug feared for it (a `sourceRecordKey` mismatch making every row invisible) was verified **absent by execution**, not by reading the code that claims to avoid it. |
| 77 | P42 | `*self-verified only; §6.2's independent tester has still never run*` | `FAIL` — band verdict `BAND_B_INGESTION_ADAPTERS_REJECTED`. B-2 (P1): retries 429 only, same defect as P40 — `walkEndpoint`'s catch special-cases `isRateLimited` and re-throws everything else. B-3 (P0): no `tango_api_usage` accounting, no request ceiling, no circuit breaker, no auth fast-path. B-5 (P2): no content hash and **no `snapshot` column** on either SBIR table, so the hash cannot be recomputed retroactively — only the mapped projection survives, and the row is unverifiable against its source by any means. Also recorded: **the SBIR sync has never been run at all**, so D-71's record-level contract validation is the entirety of this rail's real-provider evidence. **What passes:** the deliberate absence of a `tango_sync_checkpoint` row is confirmed correct — the CHECK admits no SBIR type and the endpoints publish no `modified_after` filter. |
| 78 | P43 | `*self-verified only; §6.2's independent tester has still never run*` | `FAIL` — `FO_GA_BAND_B_MATCHING_SCORING_REJECTED` and `FO_GA_BAND_A_FLAG_GUARD_REJECTED`; producer wiring `D79_PRODUCER_WIRING_INDEPENDENTLY_APPROVED`. **B-2 (P1), measured:** the real SBIR source publishes agency as the acronym `DOD`; `federal_award` stores USAspending-shaped names; `normAgency` does not expand acronyms by explicit design, so `priorAgencyHistory` — **the only live path to `clearsSuggestionFloor: true`** — is permanently `false`. A realistic UEI-backed client with genuine prior DoD contract history produced **0** rows; an otherwise identical client whose award row literally reads `'DOD'` produced **5**. The producer spec's fixtures all give the topic a full agency *name*, so the test built to guard this comparison uses the one input shape that cannot expose the problem. **This is a sufficient, mechanical explanation for zero `sbir_sttr` rows that holds independently of the rate-limit blockage and of the schedules shipping disabled — treat it as confirmed, not as a hypothesis awaiting live data.** Flag-guard F-4: `funding_opportunities_sbir` exists in `apps/web` only and is the sole tenant-visible capability flag in the entire repository enforced only by JavaScript in the reader's browser. |
| 82 | P47 | `*self-verified only*` | `PASS WITH NON-BLOCKING NOTES` — `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED`, `independent-review/band-b-lifecycle-events.md`. **"Dry-run by default" is enforced in code, in three independent places, and every misparse of `--commit` fails toward dry run** — parsing is exact-match `argv.includes('--commit')`, the dry-run branch returns before the commit path with only reads above it, and `--commit` is rejected without both `--endpoint-id` and a provider-matching `--confirm-callback`. Two adversarial parse cases checked and safe. P47 is also **structurally immune** to the never-executed-SQL class — it touches no database at all. Non-blocking: production detection of a provider that accepted a write and did nothing rests on a human or CI re-running the dry run; there is no automated post-state verification. |
| 83 | P48 | `*self-verified only*` | `PASS WITH NON-BLOCKING NOTES` — `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED`. **All 11 raw SQL statements executed verbatim** against a real fully-migrated Postgres as a non-superuser under FORCE RLS — including statement 7, `insertAlertIfNew`, the one that previously threw on every real call. The `ON CONFLICT` column list matches `tango_event_alert_dedupe_uniq` exactly and, because it names the column list rather than `ON CONFLICT ON CONSTRAINT`, correctly infers against a unique **index**. An identical insert carrying a **different `delivery_id`** was re-proved a no-op, demonstrating the fingerprint genuinely excludes the delivery id. Note the review's structural warning: **P48's SQL is not in P48's service file** — it lives in `buildPort()` in `process-tango-events.ts`, and that service/adapter split is the mechanism that let the original defect reach main. Non-blocking F-2 (P3): duplicated `eventIndex` alias in `claimBatch`'s RETURNING. Not covered: P48's fan-out, materiality and quiet-alert *policy* were not re-derived; this review covered its persistence layer. |
| 84 | P49 | `*self-verified only*` | `FAIL` — `P49_CANARY_RUNBOOK_REJECTED`, `independent-review/band-a-p49-canary.md`. Failing §4, §5, §6, §13, §14, §16, §17 **and the acceptance checklist**. Four P0s: the first capability the walk enables is gated by a flag no code reads (F1); `--client=<id>` does not exist and is silently dropped while **both syncs walk ALL tenants**, contradicting the runbook's own first line "Scope: the internal tenant only" (F2); §16's two quiet passes are dry-run-only and its stated pass criterion is one the code cannot produce (F3); §14's exit-3 claim describes a **read**-tier denial, not the write-tier question §4 says step 14 answers (F4). Five P1s (F5–F9) including a rollback that targets the canary's own digests and an instruction pointing at the forbidden `cdk deploy` unwarned, on the cluster serving `app.capiro.ai`. **Answer to the mandatory question: no** — the acceptance checklist would not catch a step that silently did nothing, in four independent ways. **What passes:** all 19 container verbs the runbook names resolve, `migration-status` is the correct verb, §2's `startedBy` warning is accurate and load-bearing, and §14 step 4's `verified webhook deliveries` delta is the one checklist item that would catch a no-op — the pattern the rest needs. |
| 85 | P50 | `*self-verified only*` | `FAIL` — `P50_SCHEDULE_ENABLEMENT_REJECTED`, `independent-review/band-a-p50-schedule-enablement.md`. Failing §30a, §30b, §31, §32, §33, §34, with live read-only verification against `capiro-dev` (account `967807252336`) on 2026-08-13. **F1 (P0):** §34's three-line prohibition understates its blast radius — 58 of 94 CDK job names collide exactly with live rules, the stack owns **zero** `Events::Rule` resources so CFN would CREATE and fail, the 2026-07-25 rollback deleted 76 rules and attempted to delete-and-recreate the **production** Route53 records for `capiro.ai` / `app.capiro.ai`, and a "clean" deploy would **enable 2 crons a human deliberately disabled** and create 21 more. **F2 (P0):** all seven Tango/DIBBS/SBIR jobs have no live rule, §32's record and its disable command return `ResourceNotFoundException`, and Part J contains no `put-rule`/`put-targets` procedure anywhere — a dead end. **F4 (P1), new and live:** `capiro-dev-api-admin-migrate:13` and `:14` export a `DATABASE_URL` whose password is the literal string `***`, so the canonical migration path for `capiro-dev` is **broken right now**. **F5 (P1):** 0 of §33's 8 required alarms exist (50 live alarms swept). **What passes, and should not be touched:** §30 and §30c — this row's own "27 / 23 / 16" measurement **reproduced exactly, five days later**, and the reasoning built on it is the strongest safety argument in the runbook. |
| 86 | P51 | `*self-verified only*` | `FAIL` — `P51_GA_CLOSEOUT_REJECTED`, `independent-review/band-a-p51-ga-closeout.md`. Five of eight internal-consistency checks fail. 14 findings, **all pure documentation** except F-08 which is a decision: F-01 (this row repeats a claim D-62 formally retracted, inside the GA phase's own acceptance evidence), F-02/F-03 (stale P41/P42 status), F-04/F-05 (two closeout tables and the "should not have to rediscover" list are behind D-70), F-06/F-09 (no D-79 handoff; the brief it was built from still says "nothing calls it"), F-07, F-08 (**"design-partner acceptance" has no definition anywhere in this program — one occurrence in the entire corpus**), F-10 (**no GA ingestion bar was ever recorded**), F-11 (the plan document is absent from the repository in all history), F-12, F-13, F-14. **What passes:** P51's GA criteria genuinely agree with P49's and P50's own rows — it claims readiness for nothing they say is blocked — and the Closeout section's opening line is "the document at its best." |

---

## §2 — P51's 14 documentation findings, as before/after edits

Every edit in this section was confirmed by `band-a-p51-ga-closeout.md` as correctable by
editing files in this directory: **no MakeGov key, no console, no deploy, no human
judgement** — with the single exception of **F-08**, which is explicitly a decision.

### F-01 · line 86, P51's **Live acceptance** column — pure doc

**BEFORE**
> Every deferred capability is named and flag-off, never implied complete: **P40-P43 blocked on the provider**, webhook write tier unresolved, P39 MCP merged without a live handshake

**AFTER (proposed)**
> Every deferred capability is named and flag-off, never implied complete: **P40–P43 are code-complete and merged, and were never blocked on the provider (D-62); both rails' contracts are validated against a real capture (D-71). What remains open is ingestion completeness (D-75–D-78) and schedule enablement, not buildability.** Webhook write tier unresolved; P39 MCP merged without a live handshake.

**Why:** D-62's own opening names *"the project closeout"* as one of the five places to
correct. P51's row **is** the project closeout, and it was not corrected. It is now also
contradicted by outcomes — P40 merged with `dibbs: supported`, D-71 validating both rails,
~14,769 real DIBBS rows in `capiro-dev` as of 2026-08-12.

### F-02 · line 76, P41's **Status**, **Live acceptance** and **Deploy** columns — pure doc

**BEFORE (Status)**
> **parts 1–2 merged; part 3 in PR [#873](…)** (status as written — flip this row when #873 merges)

**AFTER (proposed, Status)**
> **parts 1–3 merged — the phase is code-complete.**

**BEFORE (Live acceptance, final clause)**
> **Still no live DIBBS response has ever been observed** — every field mapping inherits P40's open contract gate

**AFTER (proposed)**
> **Contract validated against a real 15-record capture 2026-08-09 (D-71)**, and ~14,769 real rows ingested as of 2026-08-12 (D-75–D-78). The 5-record-per-endpoint sample is not exhaustive and no detail endpoint was called.

**BEFORE (Deploy)**
> No migration and no feature flag, so there is nothing to apply. Deployment of these commits to `capiro-dev` was **not verified in the part-3 session**

**AFTER (proposed)** — add the note P43's row already carries:
> No migration and no feature flag, so there is nothing to apply. Deployment of these commits to `capiro-dev` was **not verified in the part-3 session**. **UPDATED 2026-08-13 (D-79): the scorer is now WIRED via `generate-dibbs-opportunity-candidates.ts`; the schedule ships `enabled: false`.**

**Why, and the tell:** the D-79 commit (`aebec3b32`) changed **exactly one line** of this
file — P43's row. P41's row, describing the other half of the same change, was left
untouched. Verified: `git show --stat aebec3b32 -- docs/` → `completion-matrix.md | 2 +-`.

### F-03 · line 221, the closeout phase-range table — pure doc

**BEFORE (trailing sentences of the P40–P43 row)**
> **P41 is unblocked but unbuilt; P42 is buildable but unbuilt, its entitlement `not_attempted` rather than refused; P43 depends on P42.** Full DIBBS contract validation, recording record contents, still needs a key.

**AFTER (proposed)**
> **Updated 2026-08-13: P40–P43 are all code-complete and merged.** P41 parts 1–3, P42 parts 1–3 and P43 parts 1–3 are merged; both rails' contracts are validated against a real capture (D-71) and the matching producers are wired (D-79). What remains is ingestion completeness (D-75–D-78) and schedule enablement, both operator steps.

**Why:** contradicted by the phase rows in the same file, and P42's entitlement is no longer
`not_attempted` since D-71's live capture. **This is the second consecutive time this table
has been wrong about P40–P43** — it said "blocked", was corrected by D-62 on 2026-08-08, and
its replacement text was stale within 24 hours. This table is what a reader consults to
answer "is the program done."

### F-04 · lines 222 and 235, two closeout tables — pure doc

**BEFORE (`:222`)**
> The P46 and P48 migrations are **applied to `capiro-dev`**; P47 has none. **One later migration remains unapplied — see below.**

**AFTER (proposed)**
> The P46 and P48 migrations are **applied to `capiro-dev`**; P47 has none. **All migrations in this program are applied as of 2026-08-09 (D-70): 256 found, 0 pending.**

**BEFORE (`:235`, a row in the "What is blocked, and on whom" table)**
> | Applying `20260907010000_tango_event_outbox_per_event` to `capiro-dev` | **No longer blocked on #846** (merged), so this is now an actionable apply step rather than a dependency. It shares the hazard in P40's Deploy cell… |

**AFTER (proposed)** — delete the row, or strike it with:
> ~~Applying `20260907010000_tango_event_outbox_per_event` to `capiro-dev`~~ **Not outstanding: D-70's clean `capiro-dev-api-migrate:55` run reported 256 found / 0 pending, so this migration is among the applied ones by construction.**

**Why:** D-70's corrections were applied to the **phase rows** for P36, P40 and P42 — all
three now read *"APPLIED — verified 2026-08-09"* — and were **not** applied to these two
closeout tables.

### F-05 · lines 245–247, "Two things a reader should not have to rediscover" item 1 — pure doc

**BEFORE**
> 1. **23 of the 27 EventBridge rules targeting `capiro-dev-api-migrate` are revision-unpinned, and 16 are enabled.** Registering a migrate revision is therefore a de facto deploy of 16 scheduled jobs. See rollout runbook §30.

**AFTER (proposed)**
> 1. **23 of the 27 EventBridge rules targeting `capiro-dev-api-migrate` are revision-unpinned, and 16 are enabled — but read D-70 before acting on that.** As of 2026-08-09 the family's pinned image had been pruned from ECR and those 16 rules were already failing every fire (`CannotPullContainerError`); registering rev 55 against a valid image **RESTORED** them rather than deploying them. Re-verify the live rule state before treating this as a hazard *or* as a safety. The 27 / 23 / 16 counts themselves were independently reproduced on 2026-08-13 (`independent-review/band-a-p50-schedule-enablement.md`) and still hold. See rollout runbook §30, and §30d for a sweep that actually reproduces these numbers.

**Why:** the section's stated purpose is to stop the next reader rediscovering things, and a
reader who trusts it steers around a hazard D-70 showed had become an outage *in the
opposite direction*. D-70 named the mechanism itself: *"a documented hazard describes the
system on the day it was written."* The same pre-D-70 framing also appears at `:75` (P40's
Deploy cell, which cross-references this section), `:77` (P42's, marked superseded) and
`:235`.

### F-06 · adjacent file, not the matrix — pure doc

**File:** `docs/plans/funding-opportunities-makegov-v1/HANDOFF-2026-08-11-dibbs-sbir-matching-producer.md`

**BEFORE (lines 1–20)**
> # DIBBS/SBIR matching — wire the producer that's shipped dark
> ## STATUS — the scoring logic is built and tested; **nothing calls it**

**AFTER (proposed)** — prepend a status block, mirroring `HANDOFF-P40-part3.md`'s established form:
> **DONE 2026-08-13 (D-79, PR #943).** Both producers are built and merged; read the sections below as the specification they were, not as outstanding work. What remains outstanding is ingestion completeness and schedule enablement, not this.

**Why:** the program has an established convention for exactly this — `HANDOFF-P40-part3.md`
was written as a forward-looking brief and then updated in place once the work landed. This
brief did not get the same treatment, so the specification the producers were built from
still reads as outstanding work.

### F-07 · lines 61–67, the Tests column for P26–P32 — pure doc

**BEFORE**

| Line | Row | Tests cell |
|---:|---|---|
| 61 | P26 | `api 61/1889 (see P27+ for the running floor)` |
| 62 | P27 | `api 53→ suites, +tests` |
| 63–67 | P28–P32 | `api/web floors moved, see PR bodies` |

**AFTER (proposed)** — either backfill the seven cells from the named PR bodies, or replace
each with an explicit `not recorded per-phase; see PR #<n>` so the gap is legible rather
than looking like satisfied evidence.

**Why:** the legend at `:11` requires *"Suite/test counts after the phase."* P26's figure
equals P33's and jumps from P25's `49/1463` for a web-only phase — a retrospective backfill,
not a per-phase count. **P27's cell is an unfilled template placeholder.** With Actions
`startup_failure` repo-wide since 2026-07-31 and *"Every phase's evidence in this matrix is
a local run"*, the recorded counts are the only test evidence that exists for these phases.

### F-08 · line 86, P51's **Deploy** column — **DECISION REQUIRED, not a doc fix**

**BEFORE**
> **blocked** — GA needs P49's canary and P50's enablement to have actually run, plus design-partner acceptance

**AFTER — option (a), if a design partner is engaged**
> **blocked** — GA needs P49's canary and P50's enablement to have actually run, plus design-partner acceptance: **[named client tenant]** signs off on **[named artifact — e.g. a completed copy of the canary runbook's Acceptance checklist run against their own tenant]**, granted by **[named person]**, recorded as a committed handoff in this directory.

**AFTER — option (b), if none is engaged**
> **blocked** — GA needs P49's canary and P50's enablement to have actually run, plus design-partner acceptance — **UNDEFINED as of 2026-08-13. No design partner is named anywhere in this program, no acceptance artifact is specified, and no authority to grant it is identified. This is not a gate that can currently be passed or failed; P51's closeout must either define it or drop it.**

**Why:** the string "design partner" / "design-partner" appears in this program's **entire
document corpus exactly once** — this cell. No named client, no acceptance artifact, no
named authority, and `docs/product/funding-opportunities.md` (P51's own deliverable) contains
zero occurrences of "GA", "general availability", "acceptance" or "criteri*". As written the
criterion is unfalsifiable in both directions. Other Capiro programs do name theirs — the
state-legislation plan resolves its D4 as "Ballard Partners" with an explicit demo gate.

**Whichever option is chosen, the same text must be reflected at `:240` and `:320` (F-12).**

### F-09 · line 313 table, add a row — pure doc

**AFTER (proposed)** — add to the "What is still genuinely outstanding" table:
> | Handoff for D-79 / PR #943 (DIBBS/SBIR matching producers, V2 gate retirement) | the implementer | Every other merged phase in this program has a committed handoff; this change has only a decision-log entry and a one-line matrix edit. Closeout must not declare the producer work "done" without one. |

**Why:** `git show --stat aebec3b32 -- docs/` returns exactly two modified files — one line
of this matrix and 100 lines of the decision log — for a change spanning 22 files,
+2,680/−4,826, two new producer scripts, 27 lines of new CDK schedule declarations and the
deletion of a 9-file web directory. **Seven handoffs are committed in this directory** and
the convention is stated and defended twice: *"A program whose institutional memory lives on
one laptop has no institutional memory."*

### F-10 · new subsection after line 223 — **DECISION on the bar, then pure doc**

**AFTER (proposed)** — insert immediately after `:223`:

> ### The GA ingestion bar (set 2026-08-13)
>
> **GA's ingestion criterion is correctness on real data, not full-catalog completeness.**
> Full-catalog ingestion (D-75–D-78) remains a goal and is tracked in
> `HANDOFF-2026-08-11-dibbs-sbir-ingestion-resume.md`; it is **not** a GA gate. GA requires
> all three of:
>
> 1. **≥1 dataset per rail ingested to ~100% with `complete: true`.** Met as of 2026-08-12:
>    `tango_dibbs_solicitation` (rfp) ~100%, `tango_sbir_solicitation` ~72% and
>    `complete: true`. Verify by direct DB query, not from this document.
> 2. **The zero-rows defect closed** — `client_funding_opportunity` holds non-zero rows for
>    both `dibbs` and `sbir_sttr`. Producers exist as of D-79; **this is not yet
>    demonstrated**, because the schedules ship `enabled: false` and no manual `--commit` run
>    is recorded. **Note (2026-08-13): `independent-review/band-b-matching-scoring.md` B-2
>    shows the SBIR half cannot be satisfied by enabling anything — its only live
>    floor-clearing signal compares an agency acronym against agency names and can never
>    fire — and B-1 shows the DIBBS half will produce not zero rows but a fan-out across the
>    entire open corpus.**
> 3. **Real candidates verified end-to-end for ≥1 client** — a real client's inbox renders
>    real DIBBS and SBIR rows traceable to a source, per the canary runbook's §15 and
>    Acceptance checklist.
>
> Where any earlier text in this file or in a handoff implies full-catalog completeness is
> required for GA, this section supersedes it.

**Why:** the correctness-not-completeness bar appears **nowhere** at `d800dcfde5`, and the
silence reads as the stricter bar because every artifact around it does. Under the
correctness bar there is one confirmed-complete dataset per rail; under the full-catalog
framing the same facts read "18% / 0% / 0% / 72%" and look like a program nowhere near GA.
**Same data, opposite conclusion, entirely because of which bar the document states.** Note
the canary runbook's Acceptance checklist is already correctness-shaped — it is closer to
the real bar than this matrix is, and the matrix should be brought to it rather than the
reverse.

### F-11 · adjacent file `README.md:6`, plus a row in the `:313` table — pure doc

**BEFORE (`README.md:6`)**
> | Plan | `funding-opportunities-makegov-shippable-microphase-plan.md` v1.0 (P00–P51) |

**AFTER (proposed)**
> | Plan | `funding-opportunities-makegov-shippable-microphase-plan.md` v1.0 (P00–P51) — **NOT CHECKED INTO THIS REPOSITORY, in this commit or any commit on any branch (verified 2026-08-13). Every reference to §4.6 / §6.1 / §6.2 / §6.3 in this program's documents is a quotation from a document no reader here can open. Committing it, or recording where it lives, is a closeout item.** |

**Why:** three independent searches (`git ls-tree -r` at the SHA, `git log --all
--diff-filter=A`, and a full-history name sweep) all return no match. The single reference to
the plan in the entire tree is this README line. The consequence for P51 specifically:
**there is no checked-in authority against which "the program is complete" can be
evaluated** — the Review legend at `:12` quotes §6.2's verdict strings, D-55 paraphrases
§6.3's merge gate, and D-62 quotes §4.6, all second-hand with no primary source.

### F-12 · lines 240 and 320 — pure doc, applied alongside F-08

**BEFORE (`:240`)** — in "What is blocked, and on whom":
> | GA (P51) | P49 and P50 actually running |

**BEFORE (`:320`)** — in "What is still genuinely outstanding":
> | GA (P51) | P49 + P50 having run | acceptance is a judgement, not a test |

**AFTER (proposed):** make both read identically to whatever F-08 resolves `:86` to, so the
GA gate is stated the same way in all three places. As written, `:86` names three conditions
and both summary tables name two, silently dropping the one criterion nobody has
operationalised — and design-partner acceptance therefore has **no owner**, because it is
not in either table that assigns owners.

### F-13 · lines 260–261 and 315 — pure doc

**BEFORE (`:260-261`)**
> - **No HUMAN independent review, with one partial exception as of 2026-08-08.** Every phase in this program is marked *self-verified only*.

**AFTER (proposed)** — see §3.1 below, which supersedes this bullet entirely now that the
reviews have run. If the bullet is kept in any form, its factual claim must be corrected:
**26 of 52 phases were marked *self-verified only*; the other 26 (P00–P25) were marked
*pending* — no review of any kind, per the Deviations entry of 2026-08-06. Zero phases
carried a §6.2 verdict.**

**BEFORE (`:315`)**
> | Independent review (§6.2) | a reviewer | requires a context that did not write the code; every row above is *self-verified only* |

**AFTER (proposed)**
> | Independent review (§6.2) — **9 phases remaining** | a reviewer | **43 of 52 phases now carry a verdict** from the 2026-08-13 review effort pinned to `d800dcfde5` (see `independent-review/`). Still uncovered: **P05, P20, P21, P31, P37, P38, P39, P44, P45.** |

**Why:** the baseline claim was false for exactly half the program. `*pending*` means "no
review, deferred"; `*self-verified only*` means "the executor tested its own work" — the
Deviations table at `:202` defines them as distinct states, and collapsing them overstated
the coverage of the weaker half by one full category. The number to beat was not "52
self-verified" but **"26 self-verified, 26 with nothing recorded, 0 independently
reviewed."**

### F-14 · lines 84–86, the Code and Tests columns for P49/P50/P51 — pure doc

**BEFORE**

| Line | Row | Code (SHA) column contains | Tests column contains |
|---:|---|---|---|
| 84 | P49 | `canary runbook + read-only diag-funding-opportunities-makegov built and tested (17 tests)` | `included in the api scope above` |
| 85 | P50 | `enablement runbook (rollout §30–34) built; ProcessTangoEvents schedule declared enabled: false` | `n/a — documentation and a disabled declaration` |
| 86 | P51 | `product doc docs/product/funding-opportunities.md written; matrix rows P46-P51 filled` | `n/a — documentation` |

**AFTER (proposed):** move the merge SHAs already present in each Status cell — `a87de936`
(P49), `22a0f393` (P50), `9b23dc89` (P51) — into the Code column, and shift each row's
existing Code/Tests text one column right.

**Why:** the legend at `:10` states *"**Code** | Merge SHA of the phase branch. Not 'done' —
a SHA."* All 49 other rows comply; these three do not. The rows are structurally intact (12
pipe-delimited fields each, verified mechanically), so this is content drift rather than a
broken table. Effect: **P51 records no test evidence at all**, and the three phases most in
need of a precise pointer at closeout are the three whose Code column has none.

---

## §3 — Stale prose the other 14 reviews make correctable

### 3.1 Replace the "No HUMAN independent review" bullet (lines 257–272) with a record of the effort

The whole "Not done, and deliberately so" bullet on independent review is now the most
out-of-date paragraph in the file. **Proposed replacement:**

> ### Independent review (§6.2) — status as of 2026-08-13
>
> A banded independent-review effort ran on 2026-08-13 against pinned commit
> `d800dcfde5`. **15 review documents** are committed in `independent-review/`. Every
> reviewer states that they did not implement, deploy or previously review the code in
> scope; every review is read-only against `C:\dev\capirov2`; several executed code against
> disposable Postgres containers or made read-only AWS calls, and each says which.
>
> **Coverage: 43 of 52 phases now carry a verdict** — 14 `FAIL`, 27 `PASS WITH NON-BLOCKING
> NOTES`, 2 `PASS` (Band C attestation). **9 phases still have none: P05, P20, P21, P31,
> P37, P38, P39, P44, P45.** Prior to this effort **zero** rows carried a §6.2 verdict.
>
> **12 of the 15 reviews returned a rejection.** The consolidated, deduplicated queue is
> `independent-review/MASTER-FINDINGS-QUEUE.md` — **118 findings: 13 P0, 27 P1, 39 P2, 27
> P3, 12 P4.**
>
> **The single most-confirmed finding, reached independently by six reviewers from six
> different angles:** this program cannot distinguish a working run from a run that did
> nothing. That is the mechanism behind the zero-rows incident, and it is systemic rather
> than local.
>
> **Prior state, retained for the record:** Neo read #857/#860/#861 on 2026-08-08 — the
> first human review of any phase — covering P40 part 3 and the D-66 operator tooling. The
> rule at `:272` still stands: **do not upgrade "Neo reviewed it" into "the gate ran."** By
> the same token, do not upgrade "an agent reviewed it" into "a human signed it off" —
> every verdict in `independent-review/` is an autonomous agent's, which is what §6.2's
> different-reviewer convention asks for and is not the same as human acceptance.

### 3.2 Line 27, the standing rule — add the measured blast radius

**BEFORE**
> - Do not deploy `Capiro-dev-Compute`. It is drifted. This applies during rollback too.

**AFTER (proposed)**
> - Do not deploy `Capiro-dev-Compute`. It is drifted. This applies during rollback too. **Measured 2026-08-13 (`independent-review/band-a-p50-schedule-enablement.md` F1, `band-b-infra-deploy.md` F-3/F-4): 58 of 94 CDK job names collide exactly with live rule names; the stack owns zero `AWS::Events::Rule` resources so CloudFormation would CREATE and fail; the 2026-07-25 rollback deleted 76 rules and attempted to delete-and-recreate the production Route53 A/AAAA records for `capiro.ai`, `app.capiro.ai` and `*.app.capiro.ai`, which this stack owns; and a "clean" deploy would disable 8 currently-enabled crons, ENABLE 2 that a human deliberately disabled, and create 21 new enabled ones. Note also that the stack is no longer `UPDATE_ROLLBACK_FAILED` — it is `UPDATE_ROLLBACK_COMPLETE` and therefore updatable, so the accidental guardrail is gone while both reasons a deploy would be destructive remain.**

### 3.3 Line 81, P46's **Deploy** column — distinguish the migration from the receiver

**BEFORE**
> **Applied to `capiro-dev` 2026-08-08** via `capiro-dev-api-migrate:54` (image `9b23dc89`); verified 246 -> 248, "Database schema is up to date!"

**AFTER (proposed)**
> **The MIGRATION was applied to `capiro-dev` 2026-08-08** via `capiro-dev-api-migrate:54` (image `9b23dc89`); verified 246 → 248, "Database schema is up to date!" **The RECEIVER has never been live.** `externalSecretArns.tangoWebhookSecret` is declared and assigned by no environment, so `TANGO_WEBHOOK_SIGNING_SECRET` is never wired, the service constructor reads `''`, and `receive()` returns `not_configured` → 503 for every request. No endpoint is registered with the provider and `diag-tango-webhook-contract` has never been run. (`independent-review/band-a-p46-webhooks.md` F10.)

**Why:** the current cell can reasonably be read as evidence the receiver has verified
something. It is evidence that a table exists.

### 3.4 Line 241 and line 321 — the DIBBS/SBIR blocked-on rows are stale

**BEFORE (`:241`)**
> | DIBBS / SBIR (P40–P43) | **NOT blocked on MakeGov (D-62).** Buildable now; only the entitlement probe and live sync need a key. |

**AFTER (proposed)**
> | DIBBS / SBIR (P40–P43) | **NOT blocked on MakeGov (D-62), and no longer merely "buildable" — all four are built and merged, and both entitlement probes are closed (D-65 `dibbs: supported`; D-71 first live SBIR call).** What remains is ingestion completeness (D-75–D-78, blocked on the account-wide rate limit) and schedule enablement. **See `independent-review/band-b-matching-scoring.md` B-1/B-2 before enabling either producer.** |

**BEFORE (`:321`)**
> | DIBBS / SBIR (P40–P43) | nobody — buildable now | the SDK has no method, but a documented REST API does exist (D-62) |

**AFTER (proposed)**
> | DIBBS / SBIR (P40–P43) | nobody — **built, merged and contract-validated** | the SDK has no method, but a documented REST API does exist (D-62) and both rails were validated against real captures on 2026-08-09 (D-71) |

### 3.5 A new Deviations row recording the review effort's own scope

**AFTER (proposed)** — append to the Deviations table (after `:210`):

> | 2026-08-13 | **§6.2's independent review ran as a banded effort against one pinned commit, not per-phase between phases as §6.1/§6.3 require.** | The program was already complete as code when the review ran; a per-phase gate cannot be retrofitted. Banding was chosen so cross-phase seams would be visible. | The banding is why several of the most severe findings exist at all: `band-b-ingestion-adapters.md` records that four of its ten findings "are cross-phase by construction — each is invisible from inside any single phase and becomes obvious only when two phases are read against each other." Against that, **9 phases were not covered by any band** (P05, P20, P21, P31, P37, P38, P39, P44, P45), and no review verified live `capiro-dev` behaviour of the application itself — the live verification performed was of AWS infrastructure state (`band-a-p50-schedule-enablement.md`, `band-b-infra-deploy.md`), not of the running product. |

---

## §4 — What was deliberately NOT proposed

- **No code change is proposed anywhere in this document.** All 71 code/infrastructure
  findings are inventoried in `MASTER-FINDINGS-QUEUE.md` and left for a human to triage.
- **No Deploy, Migration, Live acceptance or Rollback cell is changed except where a review
  found it factually wrong** (P41's three cells, P46's Deploy, and the two closeout tables).
  In particular, the P49/P50/P51 Rollback cells still say "roll API/web to the prior
  immutable digests recorded in canary step 3", which `band-a-p49-canary.md` F5 shows points
  at the canary's *own* digests — but fixing that correctly requires deciding what the
  pre-canary revision recording procedure should be, so it belongs in the runbook change,
  not here.
- **The Review-column legend at `:12` is unchanged.** The three-value vocabulary still
  works; the band reviews' two-string verdicts are recorded *alongside* it rather than
  replacing it.
- **No `*pending*` cell for an uncovered phase is upgraded.** P05, P20, P21, P31, P37, P38,
  P39, P44 and P45 keep exactly what they had. Marking them anything else would repeat the
  precise error F-13 documents.
- **P51's verdict is not softened.** The 14 documentation fixes above, applied in full,
  would address F-01 through F-07 and F-09 through F-14 — but F-08 is a decision, and
  `band-a-p51-ga-closeout.md` §5 lists it as one of the four things required to move to
  `P51_GA_CLOSEOUT_INDEPENDENTLY_APPROVED`. Applying the edits does not by itself change the
  verdict; a re-review does.
