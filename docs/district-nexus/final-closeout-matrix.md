# District Nexus — final closeout matrix

Every requirement in `district-nexus-grants-mcp-plan.md` (Revision 2), plus the
review rules added by the closeout brief, reconciled against what is actually in
the repository at the head of `agent/district-nexus-final-closeout`.

> **Revised 2026-07-28, after PR #635 merged (`7adc95f4`).** This file was
> written while #635 was still a draft, and several rows went stale the moment
> it landed. Everything revised below was **re-measured against the live
> `capiro-dev` database, live EventBridge, and a live authenticated browser** —
> not re-read from a prior summary. Four rows that said **Blocked** were already
> **Done** (H2, H3, H6, and E15); one (H4) was Blocked and *understated by two
> orders of magnitude*. New sections **§J** (observed live) and rows **H12–H17**
> record what this pass found, including a defect in a migration that had
> already merged (**H17**). Where a row now contradicts what it said before, the
> old claim is struck through rather than deleted, so the correction is visible.

**Status vocabulary**

| Status | Meaning |
| --- | --- |
| **Complete** | Implemented, tested, and verified by reading the current code — not by trusting a prior PR summary. |
| **Deferred** | Deliberately not built. The missing data contract and the recommended follow-up are stated. |
| **Blocked** | Code exists but the capability is not usable until an operational step outside this PR happens. |
| **Superseded** | The plan's approach was replaced by something else that landed. |

**A note on the two "blocks?" columns.** They are different questions.
*Blocks merge* asks whether the repository is in a self-consistent, safe state.
*Blocks rollout* asks whether the feature is usable in production. Several rows
below are merge-safe and rollout-blocked; nothing here is the reverse.

---

## A. Tenant and authorization safety

| # | Requirement | Status | Implementation | Tests | Evidence | Remaining action | Owner | Blocks merge | Blocks rollout |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Every District Nexus endpoint requires authenticated tenant context | Complete | `district-nexus-flag.guard.ts:52-58`; `district-nexus-relationships.controller.ts:153-155` | `district-nexus-relationships.controller.spec.ts` | Guard throws `NotFoundException` when `req.tenantContext` is absent — the same 404 as a disabled flag, so the unauthenticated path leaks nothing either | — | — | No | No |
| A2 | `district_nexus_v2` fails closed | Complete | `district-nexus-flag.guard.ts:99-107` | `district-nexus-flag.guard.spec.ts` | A flag read that throws is caught and re-thrown as 404. The spec's "connection reset" error in the log is a passing fail-closed test, not a failure | — | — | No | No |
| A3 | Disabled tenants receive 404, not 403 | Complete | `district-nexus-flag.guard.ts:109` | `district-nexus-flag.guard.spec.ts` | Matches intel-api semantics deliberately: a 403 would advertise that the capability exists | — | — | No | No |
| A4 | Internal-canary behaviour creates no cross-tenant access | Complete | `district-nexus-flag.guard.ts:79-97` | `district-nexus-flag.guard.spec.ts` (internal tenant slug fallback) | The fallback resolves the canonical `capiro-internal` **slug** inside the same system-scoped query. It grants the internal tenant its own access only; it never widens another tenant's scope | — | — | No | No |
| A5 | Award-bearing mutations require `user_admin` or `capiro_admin` | Complete | `district-nexus-relationships.controller.ts:172-217` | `district-nexus-relationships.controller.spec.ts` (14 tests) | The spec drives the **real** `RolesGuard` against the **real** decorator metadata, so it would catch an inversion of `getAllAndOverride`'s handler-over-class precedence — which is the only thing making the method-level `@Roles` win | — | — | No | No |
| A6 | Standard users read but cannot create/edit/verify/approve/reject/delete | Complete | Same | Same | Explicitly asserted per handler, plus `client_portal_user` refused even on reads and an unrecognised role refused everywhere | — | — | No | No |
| A7 | Every tenant-scoped read/write uses `withTenant` or an approved helper | Complete | `district-nexus-relationships.service.ts` throughout | `tenant-scope-guard.spec.ts` | That spec is a build gate that parses `schema.prisma` for `tenantId` and greps every non-spec `.ts` in `apps/*/src`, so it auto-covers new models without being edited | — | — | No | No |
| A8 | No bare Prisma access for tenant-scoped models | Complete | — | `tenant-scope-guard.spec.ts` | Passing | — | — | No | No |
| A9 | Facility IDs verified to belong to the selected client and tenant | Complete | `district-nexus-relationships.service.ts` `requireFacility` | service spec: "a facility that does not belong to this active client is refused" | Filters on `id` + `clientId` + `VISIBLE_CLIENT_FILTER` inside the tenant transaction. Fixing the spec harness (`?? facility()` swallowed an explicit null) was required to test this at all | See A9-note | — | No | No |
| A10 | Client/relationship IDs cannot reach another tenant's data | Complete | Every query runs inside `withTenant`, which injects `where.tenantId` | controller spec (tenant comes from `TenantContext`, never a param or body) | The audited actor likewise comes only from `TenantContext` | Live cross-tenant curl in runbook §14 | Neo | No | No |

**A9-note.** `aggregateRelationshipNexus` (`district-nexus.service.ts:1119-1124`)
batch-loads facilities by id inside `withTenant` **without** a `clientId` filter.
It is tenant-safe, and unreachable in practice because the only writer
(`requireFacility`) validates client ownership and the producer never sets
`facilityId`. Recorded as defence-in-depth, not a live defect.

---

## B. Grant relationship review

All seven award-bearing types are supported:
`direct_recipient`, `subrecipient`, `project_site`, `research_partner`,
`coalition_partner`, `beneficiary`, `matching_contributor`
(`district-nexus-relationships.service.ts:11-19`).

| # | Requirement | Status | Implementation | Tests | Evidence | Blocks merge | Blocks rollout |
|---|---|---|---|---|---|---|---|
| B1 | Create, read, update, verify, approve-for-external-use, reject | Complete | service `list`/`create`/`update`/`reject`; controller GET/POST/PATCH/DELETE | service + controller specs | — | No | No |
| B2 | Rejection is soft state, not deletion | Complete | `reject()` sets `verificationStatus: 'rejected'`, `confidence: 0`, `externalUseApproved: false` | "a rejected relationship is persisted with zero confidence, not deleted"; web "rejection is soft state" | The row and its audit history survive | No | No |
| B3 | Rejected evidence contributes no score or funding | Complete | `district-nexus.service.ts:1098` `verificationStatus: { not: 'rejected' }`; `district-nexus.verification.ts:87` docblock | `district-nexus.aggregate.spec.ts` | A rejected relationship is filtered before it reaches the tier function — "not weak evidence, not evidence" | No | No |
| B4 | Unverified evidence receives reduced credit | Complete | `relationshipTier()` → `userProvided` (×0.5) | verification + aggregate specs; "an unverified relationship is stored at half confidence" | — | No | No |
| B5 | External-use approval impossible unless verified | Complete | `normalizeValues()` throws, **and** the return value re-clamps `externalUseApproved` | 3 tests incl. the downgrade path | Belt and braces: rejecting the input and clamping the output | No | No |
| B6 | Project-site evidence requires a facility | Complete | `normalizeValues()` | service spec + web form rule | Refused **before** any tenant write begins | No | No |
| B7 | Attributable amount cannot be negative or exceed the obligation | Complete | `normalizeValues()`; DTO `@Min(0)` | 4 tests incl. exact-equal boundary and the null-obligation case | A null obligation skips only the ceiling, never the floor | No | No |
| B8 | Beneficiary count is a non-negative integer | Complete | `normalizeValues()`; DTO `@IsInt() @Min(0)` | fractional + negative tests | — | No | No |
| B9 | Effective start cannot be after effective end | Complete | `normalizeValues()` | inverted, same-day, and non-calendar-date tests | `2026-02-30` is refused rather than rolled over | No | No |
| B10 | **Duplicate active evidence rejected deterministically** | Complete *(newly fixed)* | Partial unique index `20260808010000_client_grant_nexus_manual_award_unique` + P2002 → `ConflictException` | duplicate, rejected-rows-ignored, P2002-race, and non-duplicate-error tests | Was check-then-act (`findFirst` then `create`), which is not deterministic under concurrency. See §F1 | No | **Yes — the migration must be applied** |
| B11 | Every mutation writes a before/after `AuditLog` in the same transaction | Complete | `create`/`update`/`reject` each write inside their `withTenant` callback | create (no `before`), update (both), reject (both) | Create deliberately has no `before` — there was no prior state | No | No |
| B12 | A direct recipient may use the full award when no narrower amount is stated | Complete | `claimsFullAwardAmount()`; `district-nexus.service.ts:1190-1195` | `district-nexus.verification.spec.ts`; aggregate spec | — | No | No |
| B13 | Partial roles must not claim the full award automatically | Complete | Same — only `direct_recipient` returns true | verification spec | Every other role contributes presence, not dollars | No | No |
| B14 | If only an attributable obligation is known, do not invent outlays | Complete | `district-nexus.service.ts:1196-1201` | aggregate spec | `outlayedAmount` is explicitly `null` when an attributable amount was stated — there is no attributable-outlay column, so no split is fabricated | No | No |

---

## C. Evidence and scoring

| # | Requirement | Status | Implementation | Evidence | Blocks merge | Blocks rollout |
|---|---|---|---|---|---|---|
| C1 | Score and evidence display use the **same** trust decision | Complete | `district-nexus.verification.ts` is the single source for both axes | Its docblock records the exact bug this fixed: evidence said "name match only" while scoring gave full `sourceAuthoritative` credit. Honest explanation, dishonest number | No | No |
| C2 | UEI-backed assistance match → source verified | Complete | `assistanceTier('uei')` | `verification.spec.ts` | No | No |
| C3 | Recipient-name-only assistance match → inferred and discounted | Complete | `assistanceTier('recipient_name')` → ×0.5 | Same | No | No |
| C4 | Contractor-name contract match → inferred unless a verified identifier exists | Complete | `CONTRACT_TIER` frozen at `inferred` | The contract rail joins on `contractor_name` and nothing else; `federal_award.recipientUei` is hardcoded null. One function to change if a UEI rail is added | No | No |
| C5 | Geocoded facility → verified | Complete | `facilityTier()` | `districtSource === 'geocoded'` or `geocodeStatus === 'matched'` | No | No |
| C6 | User-entered / imported but ungeocoded facility → user-provided, discounted | Complete | `facilityTier()` fallback | `web_import` is treated the same as `user` — machine-parsed is still unconfirmed | No | No |
| C7 | Verified reviewed relationship → verified | Complete | `relationshipTier('verified')` | — | No | No |
| C8 | Unverified reviewed relationship → user-provided, discounted | Complete | `relationshipTier()` default | — | No | No |
| C9 | Rejected relationship → excluded | Complete | Caller filters before the tier function | See B3 | No | No |
| C10 | Multiple weaknesses on one assistance row compound per the approved rule | Complete | `compoundStrength()` → `compounded` (0.5 × 0.5 = 0.25) | Neo's 2026-07-27 calibration decision. A synthetic tier rather than reusing `statewide`, so a compounded row does not wrongly trigger the statewide-attribution warning for money that is not statewide | No | No |
| C11 | Tests pin the exact expected score | Complete | `district-nexus-scoring.spec.ts`, `district-nexus.aggregate.spec.ts` | Component credit is exact; only the final score rounds, so the breakdown always sums to the number it explains | No | No |
| C12 | Obligations, outlays, potential funding, and opportunity estimates never blended | Complete | Separate columns and separate response fields throughout | `totalObligatedAmount` / `totalOutlayedAmount` / `nonFederalFundingAmount` are distinct DB columns; the API exposes `contractObligations` / `grantObligations` / `grantOutlays` / `opportunityEstimatedFunding` separately and never one `totalAmount` | No | No |

---

## D. Geographic integrity

| # | Requirement | Status | Evidence | Blocks merge | Blocks rollout |
|---|---|---|---|---|---|
| D1 | Current district data uses current district metadata only | Complete | Current and future artifacts are separate; `boundaryVintage` is carried per evidence row | No | No |
| D2 | Unsupported future attribution is not exposed under a misleading label | Complete | Future boundaries are selectable only when future artifacts exist; current members are never described as future-district officeholders | No | No |
| D3 | `90`/`98`/`ZZ`/statewide/multi-district/unresolved never assigned to a House district | Complete | `districtCodeForHouseMatch` returns null for `98`/`90`/`ZZ`; `districtKeyFor` refuses to key them | No | No |
| D4 | At-large states resolve correctly | Complete | `'00'` ↔ member `district = NULL`; pinned by `district-nexus.district-names.spec.ts` and the `/WY/00` web test | No | No |
| D5 | Boundary vintage and source shown honestly | Complete | `popCdVintage` stored and surfaced; `federal_award` has no vintage column so contract evidence reports `unknown` rather than assuming `original` | No | No |
| D6 | Recipient location labelled as fallback, reduced strength | Complete | `geographyBasis: 'recipient_location'`, strength ×0.5, and a `recipient_location_fallback` warning | No | No |
| D7 | Place of performance preferred | Complete | `aggregateRelationshipNexus` precedence: facility → POP → recipient location | No | No |
| D8 | Real facility coordinates used when available | Complete | `ClientFacility.latitude/longitude` drive markers | No | No |
| D9 | District centroids never labelled as exact facility locations | Complete | Centroids are artifact metadata for camera fitting; facility markers come only from real coordinates | No | No |
| D10 | Missing boundaries or WebGL failure fall back to a table without losing numbers | Complete | `DistrictNexusTable` is a first-class synchronized alternative; `DistrictNexusPage.test.tsx` mocks the map wholesale (the repo's jsdom precedent) | No | No |
| D11 | Fixtures for at-large, numbered, sentinels, unresolved, stale future-view URLs | Complete | `district-nexus.district-names.spec.ts`, `district-nexus.detail-keys.spec.ts`, `DistrictNexusFilters.test.tsx` | No | No |

---

## E. Grant opportunities

| # | Requirement | Status | Evidence | Blocks merge | Blocks rollout |
|---|---|---|---|---|---|
| E1 | Client-level forecast rail, not awarded money | Complete | Separate `FederalGrant` table, separate response fields, separate copy | No | No |
| E2 | Contribute nothing to awarded totals | Complete | Scoring rule 3: `opportunityOnly` forces zero credit on both awarded-funding components and emits an `opportunity_only` warning | No | No |
| E3 | Do not contribute to a district unless linked to a project-site facility | Complete | `componentForRelationship('opportunity_candidate')` returns null, so the producer's rows earn no district credit | No | No |
| E4 | Distinguish active / closed / archived / expired | Complete | Status lifecycle plus the weekly `--all-statuses` reconcile | No | No |
| E5 | Preserve null when an amount is unavailable — never `$0` | Complete | `Money` type is nullable end-to-end; `formatMoney(null)` returns an em dash. Pinned by a new web test | No | No |
| E6 | Expose relevance score, matched signals, deadline, agency, eligibility state + explanation | Complete | `grant-opportunity-relevance.ts` output shape | No | No |
| E7 | Use only client facts when scoring relevance | Complete | The `fundingCategory` self-match (a client-independent signal worth 10 points, 120 of 183 hits) was removed in the B4 remediation already on `main` | No | No |
| E8 | No points for a grant matching its own category/description | Complete | Same | No | No |
| E9 | Do not claim eligibility confidently when applicant-type data is absent | **Blocked** | `applicantTypes` is hardcoded `[]` in `shapeClientRelevanceProfile`, so `computeEligibility` can only return `needs_review` or `unknown` — **never** `eligible`. The behaviour is honest (it never over-claims) but the column is inert. Needs an applicant-type field on `Client` | No | No — honest, just uninformative |
| E10 | Producer evaluates every eligible grant for every eligible client | Complete | The early-`return` that exited the client loop on the first non-match is fixed to `continue`; 6,888 pairs evaluated, previously 12 | No | No |
| E11 | Producer does not exit a client loop after the first non-match | Complete | Same | No | No |
| E12 | Producer avoids per-pair database queries | Complete | Per-(client, grant) `findFirst` batched to one `findMany` per client — measured 780–960 ms → 4–6 ms | No | No |
| E13 | Producer is idempotent | Complete | Find-then-create-or-update, keyed on the 5-column unique index | No | No — `20260806010000` **is applied**; index verified live 2026-07-28 |
| E14 | Producer preserves human-authored rows | Complete | Only `evidenceSourceType: 'deterministic_relevance_v1'` rows are read or touched; `evidenceSourceType` is in the unique key precisely so a producer row and an analyst row can coexist | No | No |
| E15 | Producer cannot create duplicate rows under concurrent execution | **Complete** | ~~The index exists in the migration but is not applied to `capiro-dev`~~ — **that was wrong, and its only source was the stale code comment at `ingestion-schedule.ts:451-459`.** Queried directly 2026-07-28: `client_grant_nexus_producer_unique_idx` **is present in `pg_indexes`**, and `20260806010000` is `finished_at IS NOT NULL, rolled_back_at IS NULL` in `_prisma_migrations`. `runWithSyncRun`'s skip-if-running is now the second line of defence, not the only one | No | No |

---

## F. Newly fixed in this closeout pass

| # | Item | Status | What changed | Tests | Blocks merge | Blocks rollout |
|---|---|---|---|---|---|---|
| F1 | Duplicate relationship rejection was not deterministic | Complete | Partial unique index + P2002 → `ConflictException`. Partial and `COALESCE`-keyed because `facility_id` is nullable (Postgres treats NULLs as distinct) and rejected rows must remain re-enterable | 4 | No | Yes — migration |
| F2 | CI `verify` was red | Complete | 6 TS errors in the branch's own spec: zero-arg `jest.fn()` infers `never[]` call tuples, so every `mock.calls[0]![0]` indexed an empty tuple | typecheck | **It was blocking** — now green | No |
| F3 | Relationship authorization untested | Complete | New controller spec drives the real `RolesGuard` against real metadata | 14 | No | No |
| F4 | Relationships panel untested | Complete | New web spec: permissions, failed-vs-empty, review states, null money, cache invalidation | 7 | No | No |
| F5 | Stale `assistance_recipient` queue | Complete (tooling) | New dry-run-by-default prune script. 173 of 183 live rows are wrong; >$15B misattributable if bulk-confirmed | 20 | No | **Yes — runbook §4 not yet run** |
| F6 | profile-v1 could hang indefinitely | Complete | 20 s per-source budget + >3 s slow-source logging on the 24-way fan-out. A never-settling source used to make `allSettled` never settle: no error, no rejected section, and no `api.endpoint_latency_ms` (that metric fires on response finish) | 7 | No | No |

---

## G. Deferred, with the missing contract stated

| # | Item | Why deferred | Missing data contract | Recommended follow-up |
|---|---|---|---|---|
| G1 | Findings panel on the District Nexus subtab | The backend produces no findings feed. Building the panel against no data would satisfy a checkbox and mislead a user | A `findings[]` array per district with `{code, severity, message, sourceRecordId}`, derived from `DataQualityWarning` plus redistricting alerts | Wire `emit-redistricting-alerts` (it has an entrypoint verb and a dark schedule entry but has never run in prod), then surface its `intelligence_change` rows |
| G2 | `ClientDistrictNexusEvidence` (plan §6.3) | Explicitly staged to a second migration wave by the plan; the map and widget MVP do not depend on it | The full table from plan §6.3 plus a management UI | Ship with its UI, dark, as its own PR |
| G3 | Assistance subawards (`spending_level: "subawards"`) | Plan marks it post-MVP. Without it a `subrecipient` claim rests on reviewer attestation only | Sub-Award ID, Sub-Recipient UEI, prime award id, sub-POP `congressional_code` — all verified present on the endpoint | Add a weekly sync; upgrade `subrecipient` from `userProvided` to `sourceAuthoritative` when a reported subaward corroborates it |
| G4 | Data Explorer detail drawer for assistance awards | Neither existing federal source has one; row click opens an external URL. Matching that is deliberate for v1 | — | Follow the 12-source drawer pattern later |
| G5 | Eligibility can never say "eligible" (E9) | Needs a new `Client` field | `Client.applicantTypes: string[]` mapped to Grants.gov applicant-type codes | Add the column, populate during onboarding, then `computeEligibility` becomes meaningful |
| G6 | PMTiles | The measured artifact (441 features, 4.90 MB gzipped) does not justify it | — | Documented upgrade path only |

---

## H. Operational — code exists, action outstanding

**None of these are marked Complete merely because the code exists.**

| # | Item | Status | Gate | Owner |
|---|---|---|---|---|
| H1 | ~~Apply `20260806010000_client_grant_nexus_producer_unique`~~ | **Done** — it was already applied; the "unapplied" claim came from a stale CDK comment | Verified 2026-07-28 | — |
| H2 | ~~Apply `20260808010000_client_grant_nexus_manual_award_unique`~~ | **Done 2026-07-28** — applied and verified by querying `_prisma_migrations` (`finished`, not rolled back) **and** `pg_indexes` (`client_grant_nexus_manual_award_unique_idx` present). Runbook §2 already recorded this; this row had not been updated to match | — | — |
| H3 | ~~Run the stale-candidate cleanup (dry run, then `--commit`)~~ | **Done 2026-07-28** — committed. The `assistance_recipient` queue is now **4 unconfirmed + 2 confirmed = 6 rows**, down from 183; the 177 junk generic-token candidates are gone | — | — |
| H4 | Assistance enrichment backfill | **Blocked — and larger than this row previously stated** | Measured 2026-07-28: **239,118** assistance awards, of which only **1,749 (0.73 %)** have `detail_enriched_at` set. Real backlog is **237,369**, not "~238,619 rows, ~5 runs". The per-award rail **cannot** close it — USAspending's edge WAF blocks our NAT IP under sustained load (`enrich-assistance-awards` dies mid-run). The bulk-download rail in **PR #649** is the actual fix and must merge first. Runbook §5 | Neo (merge #649) |
| H5 | Grants.gov reconcile to completion | **Was impossible** — the walk sent `offset`, which search2 ignores, so it re-read page 0 forever (10,000 upserts -> +12 rows). Fixed via `startRecordNum` + `--from-page`; now ~1 run | Runbook §6 | Neo |
| H6 | ~~Create the `GenerateGrantOpportunityCandidates` EventBridge rule~~ | **Done** — `aws events list-rules` 2026-07-28 shows **`capiro-dev-generate-grant-opportunity-candidates`, `ENABLED`, `cron(35 11 * * ? *)`**. Its output is live: `client_grant_nexus` holds 4 `deterministic_relevance_v1` rows. Criterion 3 for widening the flag is therefore satisfiable by observation, not by a future action | — | — |
| H7 | Boundary artifact `--commit` | **Done 2026-07-28** — the IAM gap was already closed (`district-boundary-artifacts-s3-write`), proven by committing: 441 features, 4.90 MB gz, 0 warnings, artifact + manifest live in S3, 437 district rows updated. Current rail only; the future rail has 0 features until `sync-legistorm-districts --with-kml` runs | — |
| H8 | Deploy api + web | **Done 2026-07-28** — `capiro-dev-api` rolled via `--force-new-deployment`. Verified by digest, not by the deploy exiting 0: both running tasks pulled `sha256:d09d8e29…`, which byte-matches ECR `capiro/dev/api:latest`, tagged `6122a0a5` = `main` at the time. Both `RUNNING`/`HEALTHY`, old deployment drained to 0, `app.capiro.ai` 200. The API had been **three merges behind** (`sha256:5723a6a6`, tag `1bbad4934`). `capiro-dev-web` already matched its own ECR `latest`; #648 was API-only so no web build was needed | Runbook §12 | — |
| H9 | Browser canary walk | **Steps 1–6 and 8 MET 2026-07-28; only step 7 remains** | Walked live against `capiro-internal`/RTX as `capiro_admin`. **2** create unverified → `201`, renders `unverified` with no external-use tag, amount `—`, and `Geography: CA-36 (recipient location)` labelled as a fallback. **3** verified + evidence source → `PATCH 200`; the external-use switch is `disabled` at unverified and `enabled` at verified, and saving verified with no source is refused with *"Verified evidence requires a source reference."* — **no PATCH issued**. **4** project site with no facility → *"Project-site evidence requires a client facility."*, **no POST issued**. **5** duplicate → **`409`** *"This client already has an active relationship of that type for the selected award and facility."* **6** reject → `DELETE 200` returning `{verificationStatus:'rejected'}` (a soft reject, not a delete); the row leaves the active list, the footer reads *"1 rejected relationship retained in the audit history."*, and districts drop **3 → 2** as CA-36 disappears. **8** map, filters, table fallback and drawer all render with matching counts. DB after: the row survives at `verification_status='rejected'`, `confidence=0`, `external_use_approved=false`, source retained; exactly **one** `analyst_manual_entry` row exists, so neither refusal wrote anything. Audit: 3 rows, `before` populated on update and reject, actor `capiro_admin`/`neo@capiro.ai`. **Step 7 needs a second `standard_user` account.** | Runbook §13 | Neo (step 7) |
| H10 | Widen `district_nexus_v2` beyond `capiro-internal` | **Blocked** | Runbook §11 criteria — all four must hold | Neo |
| H11 | `connection_limit=10` sizing validation | Open question | Set explicitly in `entrypoint.sh:40`, replacing Prisma's CPU-derived ~3–5 default on a 0.5 vCPU task. Not load-validated. Measured cause is upstream of the number: `computePortfolioAlerts` re-runs the whole 24-source profile-v1 aggregate once per client just to read `sections.snapshot.topAlerts`, so a single user request competes with a 12×24 fan-out and will starve at any plausible pool size. The fix the code already names is precomputing portfolio alerts on a cron | Neo |
| H12 | ~~Merge **#649**~~ | **Merged 2026-07-28** (`60bcdeb6`) — the bulk-download rail is now on `main`; the backfill itself (H4) still has to be run | Prerequisite for H4; nothing else can close a 237,369-row backlog through a WAF-blocked per-award endpoint | Neo |
| H13 | ~~Merge **#650**~~ + apply the KML `s3:PutObject` grant out-of-band | **Merged 2026-07-28** (`e2de4b1e`); the live IAM grant is still outstanding | `kml_s3_key` is NULL on **all 741** `legislative_district` rows (537 `C` + 204 `F`) because `apiTaskRole` has never held `s3:PutObject` on `UPDATED DISTRICTS/kml/` — in CDK or live. #650 codifies the grant; `cdk deploy Capiro-dev-Compute` stays forbidden, so the live grant is a separate `aws iam put-role-policy` (runbook §10.1). **Privilege change — Neo's call** | Neo |
| H14 | ~~Merge **#651** — `Client.applicantTypes`~~ | **Merged 2026-07-28** (`2c4a0414`) — closes **E9**, which was confirmed inert live (§J4). **Its migration was broken on arrival; see H17.** | — |
| H17 | ~~Merge **#655**~~, then apply `20260809010000_client_applicant_types` | **#655 merged 2026-07-28 (`0721c7c5`); applying the migration is still outstanding, and must happen before any api rollout past `6122a0a5`.** This was not a latent hazard — it was **actively breaking CI on every PR**: the `engagement` workflow runs `prisma migrate deploy` against a fresh database and died with `P3018 / 42P01 relation "client" does not exist`, which also blocks every migration queued behind it. #655's `engagement` check going green is the proof it clears | #651's migration shipped as `ALTER TABLE "client"`. The table is `clients` (`@@map("clients")`). `IF NOT EXISTS` guards the **column**, not the table, so `migrate deploy` fails outright with `relation "client" does not exist` and blocks everything queued behind it. Worse: #651 already updated `schema.prisma`, so the generated client selects `applicant_types` on **every** read of `clients` — rolling the API to `:latest` before a working migration 500s every client query for every tenant, not just District Nexus. Verified against `capiro-dev` (diag task `92726b3c`): `pg_tables` holds only `clients`, `applicant_types` exists nowhere, and the migration is absent from `_prisma_migrations`. **#655** fixes the SQL and adds a static guard (131 ALTER targets across the full history, 0 orphans after the fix) | Neo |
| H18 | ~~Merge **#657**~~ — the *second* defect #651 shipped | **Merged 2026-07-28 (`2ec465dc`)** | `CandidatesPrisma.client.findMany` hand-declares its return shape (its `args` is `unknown`, so the shape is **not** derived from the `select`). #651 added `applicantTypes` to the runtime select **and** to `buildRelevanceProfileForClient`'s parameter, but not to that interface, so the producer script stopped compiling. **CI could not see it**: `apps/api/tsconfig.json` excludes `scripts`, so `pnpm typecheck` never reads `apps/api/scripts`. `ts-jest` does, so the effect was that `generate-grant-opportunity-candidates.spec.ts` **could not run at all** — `grant-opportunity` went from 31 passing with one suite failing to load, to **44 passing across 3 suites**. 13 tests were silently not executing, on the script behind the live producer cron. **Recommend merging PR #584** (`build(api): typecheck apps/api/scripts in CI`, still open) — it closes the hole that let both this and H17 through | Neo (merge #584) |
| H15 | ~~Close **#591** as superseded~~ | **Closed 2026-07-28** with the byte-identity evidence in the comment | Verified by content hash 2026-07-28: all **6** files in #591 are **byte-for-byte identical** to `origin/main` (commit `bd31c071`, same file set, same +281/−151). Merging it is a no-op at best. See I1 | Neo |
| H16 | Merge **#592** — codify `CAPIRO_INTERNAL_TENANT_ID` in the Compute stack | **Open — real IaC drift, not superseded** | The env var **is live** on `capiro-dev-api:59` (applied out-of-band) but is **absent from `main`'s `compute-stack.ts`**, so it is drift that a future `cdk deploy` would silently drop. Merging changes no running behaviour — the Compute stack is frozen by the DNS-revert incident — it only makes IaC honest | Neo |

---

## I. Superseded

| # | Plan item | Superseded by |
|---|---|---|
| I1 | PR #591 — stop failed requests rendering as confident empty/zero answers | Commit `bd31c071` on this branch implements the same intent across the same surfaces. Do not re-apply |
| I2 | Plan §4.5's `::uuid` cast on the `intel_feature_flag` read | Removed. `tenant_id` is TEXT there; the cast threw `42883`, the guard failed closed, and the feature 404'd for tenants whose flag was genuinely on. The plan was wrong |
| I3 | Plan §3.5's "`getDistrictNexusSpend` is the profile-v1 suspect" | Exonerated by measurement: 17 ms, Bitmap Index Scan, `EXPLAIN` execution 0.201 ms, 126 matching rows. Replaced by the pool-starvation hypothesis and F6's budget |
| I4 | Non-compounding weakness rule (the plan's tested default) | Neo's 2026-07-27 calibration: two independent weaknesses on one row now multiply (`compoundStrength`) |

---

## J. Observed live, 2026-07-28 — not inferred from code

Everything in this section was seen in a real authenticated browser session
against `capiro-internal` (client: RTX Corporation,
`492ab348-6600-4fca-9d1b-5f072b4e745e`) **after** `capiro-dev-api` was rolled to
`main`. Where a number appears, it was read off the wire, not off a summary.

### J1. The profile-v1 500 is fixed — and the section still costs 21.7 s

`GET /api/intelligence/clients/:id/profile-v1` returned **`200`, 21,101 bytes,
21,688 ms**. Before #648 it returned `500` for every client, which blanked the
whole Intelligence tab and hid District Nexus, Snapshot, Financial and
Legislative at once. All four sections now render.

**The latency is not fixed and should not be read as fixed.** #648 stops a
degraded source turning into a 500; it does not make the aggregate fast. Two
calls on the same tab load are far outside any reasonable budget:

| Endpoint | Status | Time |
| --- | --- | --- |
| `…/profile-v1` | 200 | **21,688 ms** |
| `…/pe-relevance?minScore=0.5&limit=8` | 200 | **12,384 ms** |
| `…/client-profile/:id` | 200 | 6,298 ms |
| `…/district-nexus-v2` | 200 | 1,222 ms |
| `…/district-nexus-relationships` | 200 | 1,394 ms |

This is the live evidence for **H11**. The pool size is downstream of the real
cause; see that row.

### J2. The published boundary artifact is consumed end-to-end

`/api/intelligence/district-nexus/boundaries/C/geojson` returned **`200`,
16,569,264 bytes** to the browser, and MapLibre drew real district polygons from
it. Together with `boundaries?status=C` (200) and `map?view=current&clientId=…`
(200), this is the first proof the H7 artifact is *served and rendered*, not
merely present in S3.

### J3. Surfaces confirmed rendering correctly

Client widget (Intelligence → Districts): district count 2, per-facility
representation (federal House + Senate, state upper + lower), `$68.97B` contract
obligations, `$45.8M` grant obligations with **outlays stated separately**
(`obligations $45.8M · outlays $34.4M`), top districts CT-01/VA-08 ordered by
nexus score, evidence-driver chips, coverage badges, warnings, a **separate**
"Opportunity pipeline — forecast, not awarded" rail, reviewed-relationships
panel with **Add relationship** present for a `user_admin`, "View full map →",
and the setup-gaps list.

Map page: `Current · 119th Congress` label, client/state/colour-by/amount
filters, district table fallback, freshness and data-quality badges, facility
markers at real coordinates, nexus-strength legend, and
`Boundaries · © OpenStreetMap contributors · U.S. Census Bureau, 119th Congress`.

Drawer (CT-01): the full 8-component breakdown summing to 28/100, `Coverage 45%`,
`Boundary: current, 119th`, and the honest-gap sentence — *"55 points of the
model have no data submitted for this district — that is a gap, not a verified
zero"* — plus both trust warnings (`client-provided claim that has not been
independently confirmed`, `inferred entity match rather than a verified
identifier`).

Null is preserved rather than zeroed everywhere it was checked: `EMPLOYEES —`,
`Grants —` on VA-08, `not reported` in the drawer's client table.

District counts agree across all three surfaces (stat tile `2`, table
`DISTRICTS 2`, map badge `2 districts`).

### J4. E9 confirmed inert, live — and #651 is confirmed as its fix

The opportunity rail rendered three candidates, each reading:

> *relevance 40 · eligibility needs review · closes 9/7/2026*
> *"The opportunity states applicant types but we hold none for this client —
> confirm the client's applicant type to resolve."*

That is exactly the behaviour E9 describes: honest, never over-claiming, and
uninformative. It is the live justification for **H14**/#651.

### J5. New defect — a raw USAspending record renders as an award title

In the CT-01 drawer's **Federal contract awards** list, one row's title is the
unparsed fixed-width source record:

```
200204!008533!1700!AF600 !NAVAL AIR SYSTEMS COMMAND !N0001902C3003 !A!N! !N! !20011026!20120430!001447952!…
```

It renders as a wall of text where an award name belongs, on a surface intended
to be shown to clients. The underlying value is genuinely what USAspending
returns for that legacy record, so this is a **presentation** fix, not an
ingestion one: the award-title renderer should detect an unparsed
delimiter-dense record and fall back to the award id plus recipient. Not a
correctness or tenancy issue; does not block merge. **Newly found, unowned.**

---

## K. Definition-of-done evidence, measured 2026-07-28

The closeout brief's own **Definition of done** list, each clause answered with a
number rather than an assertion. Suites run at `main` = `2ec465dc` in a clean
worktree, after `pnpm install --frozen-lockfile`,
`pnpm --filter "./packages/**" build` and `prisma:generate` — all three are
mandatory or the counts are wrong.

| Suite | Result |
| --- | --- |
| `apps/api/src/district-nexus/` | **12 suites, 271 tests, all pass** |
| `grant-opportunity` (incl. the producer script) | **3 suites, 44 tests, all pass** |
| `apps/api/src/prisma/` (tenant-scope + migration guards) | **4 suites, 17 tests, all pass** |
| `apps/web` `DistrictNexus` | **5 files, 58 tests, all pass** |

The `DistrictNexusFlagGuard` "connection reset" line in the API log is a
**passing** fail-closed test (row A2), not a failure.

### "Reviewed grant relationships are fully usable and audited" — MET

Usable: create / list / update / verify / approve-for-external-use / reject are
each exercised. Audited, specifically:

- *creates verified project-site evidence and its audit record in one tenant transaction*
- *an update writes BOTH a before and an after snapshot in the same transaction*
- *soft-rejects a relationship and keeps the before/after audit trail*
- *the audited actor is the CALLER, not anything client-supplied*

Plus the invariants: rejection is soft state at zero confidence and never
deleted; unverified is stored at half confidence; external-use approval is
impossible unless verified and cannot be smuggled in by an update; project-site
requires a facility *before any tenant write begins*; a null obligation cannot
be used to pass an unbounded attributable amount; duplicates are a conflict from
the index, and losing the insert race surfaces as the **same** conflict rather
than a 500 — while a non-duplicate database error is **not** laundered into one.

### "Tenant isolation is tested" — MET at the test level, UNMET live

Tested: *every handler passes the caller tenant from context, never a body or
param value*; a facility belonging to another client is refused; the full role
matrix (`standard_user` may read but not create/update/reject;
`client_portal_user` refused even on reads; an unrecognised role refused
everywhere); the flag gate is mounted alongside the role gate and fails closed;
and `tenant-scope-guard.spec.ts` is a build gate that re-derives tenant-scoped
models from `schema.prisma`, so it covers new models without being edited.

**Still unmet live:** runbook §14's three curls. Not a code gap — it needs a
`standard_user` account and a second tenant's client id, and the same-origin
browser trick does **not** work because the app authenticates with a bearer
token, so a cookie-credentialed `fetch` returns 401. Rollout gate (H9), not a
merge gate.
