# District Nexus — final closeout matrix

Every requirement in `district-nexus-grants-mcp-plan.md` (Revision 2), plus the
review rules added by the closeout brief, reconciled against what is actually in
the repository at the head of `agent/district-nexus-final-closeout`.

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
| E13 | Producer is idempotent | Complete | Find-then-create-or-update, keyed on the 5-column unique index | No | **Yes — `20260806010000` is unapplied** |
| E14 | Producer preserves human-authored rows | Complete | Only `evidenceSourceType: 'deterministic_relevance_v1'` rows are read or touched; `evidenceSourceType` is in the unique key precisely so a producer row and an analyst row can coexist | No | No |
| E15 | Producer cannot create duplicate rows under concurrent execution | **Blocked** | The index exists in the migration but **is not applied to `capiro-dev`** (stated in `ingestion-schedule.ts:451-459`). `runWithSyncRun`'s skip-if-running remains the primary defence | No | **Yes — apply before scheduling** |

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
| H1 | Apply `20260806010000_client_grant_nexus_producer_unique` | **Blocked** | Runbook §3 | Neo |
| H2 | Apply `20260808010000_client_grant_nexus_manual_award_unique` | **Blocked** | Runbook §3 | Neo |
| H3 | Run the stale-candidate cleanup (dry run, then `--commit`) | **Blocked** | Runbook §4 | Neo |
| H4 | Assistance enrichment backfill (~238,619 rows, ~5 runs) | **Blocked** | Runbook §5 | Neo |
| H5 | Grants.gov reconcile to completion (~8 weekly passes) | **Blocked** | Runbook §6 | Neo |
| H6 | Create the `GenerateGrantOpportunityCandidates` EventBridge rule | **Blocked** | Runbook §9.2, after H1 | Neo |
| H7 | Boundary artifact `--commit` | **Blocked** | Runbook §10.2 — `ApiTaskRole` has no `s3:PutObject` on `district-boundaries/*`; geometry is dry-run verified (441 features, 4.90 MB gz, zero warnings) | Neo |
| H8 | Deploy api + web | **Blocked** | Runbook §12, **after** H1/H2 | Neo |
| H9 | Browser canary walk | **Blocked** | Runbook §13 | Neo |
| H10 | Widen `district_nexus_v2` beyond `capiro-internal` | **Blocked** | Runbook §11 criteria — all four must hold | Neo |
| H11 | `connection_limit=10` sizing validation | Open question | Set explicitly in `entrypoint.sh:40`, replacing Prisma's CPU-derived ~3–5 default on a 0.5 vCPU task. Not load-validated | Neo |

---

## I. Superseded

| # | Plan item | Superseded by |
|---|---|---|
| I1 | PR #591 — stop failed requests rendering as confident empty/zero answers | Commit `bd31c071` on this branch implements the same intent across the same surfaces. Do not re-apply |
| I2 | Plan §4.5's `::uuid` cast on the `intel_feature_flag` read | Removed. `tenant_id` is TEXT there; the cast threw `42883`, the guard failed closed, and the feature 404'd for tenants whose flag was genuinely on. The plan was wrong |
| I3 | Plan §3.5's "`getDistrictNexusSpend` is the profile-v1 suspect" | Exonerated by measurement: 17 ms, Bitmap Index Scan, `EXPLAIN` execution 0.201 ms, 126 matching rows. Replaced by the pool-starvation hypothesis and F6's budget |
| I4 | Non-compounding weakness rule (the plan's tested default) | Neo's 2026-07-27 calibration: two independent weaknesses on one row now multiply (`compoundStrength`) |
