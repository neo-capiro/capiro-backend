# Funding Opportunities — completion matrix

Status vocabulary:

- **DONE** — implemented and covered by a test that would fail if it regressed.
- **DONE (data-limited)** — the code path is complete and correct; the ANSWER is
  limited by a source or client-profile gap that is documented, not hidden.
- **PARTIAL** — implemented for the cases that matter, with the omission named.
- **DEFERRED** — deliberately not in this PR, with the reason.

Nothing below is marked DONE on the strength of a browser walk, because the branch
is not deployed. See [verification.md](./verification.md).

---

## §2 Read the actual code first

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Inspect every listed path before editing | DONE | [implementation-baseline.md](./implementation-baseline.md) records the actual behaviour of each, including two live defects and the `search2`-returns-ten-fields constraint |
| `implementation-baseline.md` | DONE | branch SHA, main SHA, behind-main status, changed files, models, routes, ingestion behaviour, matching behaviour, 11 numbered gaps, baseline failures |
| Remove the temporary CI step | DONE | `.github/workflows/ci-pr.yml` reverted to `main` byte-for-byte (`git diff origin/main -- .github/workflows/ci-pr.yml` is empty). This also fixed an unrelated comment the scaffold commit had corrupted. |

## §3 Data-gap audit

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Grants.gov field inventory | DONE | [data-gap-audit.md](./data-gap-audit.md) §1 — 24 facts, each with the writing script |
| SAM.gov field inventory | DONE | §2 — 24 facts. Value, vehicle, incumbent and amendment lineage marked **Not provided**, not TODO |
| Client identity inventory | DONE | §3 |
| The identity gap, explicitly | DONE | §3a — with the symmetric false-negative (RTX/Raytheon, zero shared tokens) and false-positive (Santa Rosa/Santa Clara) cases |
| Deferred sources | DONE | §4 — 8 sources, each with why |

## §4 Canonical contracts

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| `OpportunitySource` | DONE | `funding-opportunities.types.ts` |
| `OpportunityKind` (bounded) | DONE | 10 kinds; `opportunity-kind.ts` normalizes both sources' text. `opportunity-kind.spec.ts` pins that presolicitation is never read as solicitation |
| Award/archived notices not shown as pursuits | DONE | `NON_PURSUABLE_KINDS`; excluded from active counts (service spec) |
| `OpportunityWorkflowStatus` | DONE | 7 states |
| All required opportunity fields | DONE | `FundingOpportunity` — 40 fields |
| **No generic `totalAmount`** | DONE | Separate `GrantFunding` / `ContractValue` blocks. Boundaries spec greps the types file for `totalAmount`; the web spec asserts no `$` in the KPI strip |
| Repo convention for type sharing | DONE | API file is the source of truth, web mirrors it with a "Mirrors …" docblock (district-nexus-api.ts precedent) |

## §5 Persistence

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Tenant-scoped workflow model | DONE | `ClientFundingOpportunity` / `client_funding_opportunity` |
| All 18 required fields | DONE | schema.prisma |
| Exactly one source referenced | DONE | `client_funding_opportunity_one_source_chk` — enforced in SQL, not trusted to the writer |
| No duplicate active rows per (tenant, client, opportunity) | DONE | **Two PARTIAL unique indexes**, one per source. A single index over the nullable pair would admit unlimited duplicates for the other source, because Postgres treats NULLs as distinct |
| Preserve user decisions across producer reruns | DONE | `decideProducerAction` returns `skip_human_decision` first; 8 producer tests including "a human decision is preserved even when the score COLLAPSES" |
| Producer may create/refresh/stale suggestions | DONE | producer spec |
| Producer never overwrites saved/pursuing/dismissed/won/lost, owner, notes, facility | DONE | producer spec, parameterised over all five statuses |
| `tenant_id NOT NULL` | DONE | migration |
| Added to the tenant-scope guard | DONE | that guard derives its model list from `tenantId` in the schema, so declaring the field enrols the model. Boundaries spec asserts the field exists AND that the service never touches the model outside `withTenant` |
| RLS policy via migration | DONE | ENABLE + FORCE + 4 tenant-predicated policies, all guarded for retry |
| Accessed through `withTenant` | DONE | boundaries spec greps for bare access |
| Never accepts tenant id from the body | DONE | no DTO has a tenant field; `@CurrentTenant()` on every route |
| Migration tests | DONE | 10 assertions: RLS, force, policies, partial uniqueness, CHECKs, additive-only, retry-safety, `@@map` correctness, ordering-after-every-existing-migration |
| Tenant-scope tests | DONE | boundaries spec + service spec (`tenantsSeen` never contains another tenant) |

## §6 Grant discovery

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| **Works with no nightly candidate row** | DONE | read-time scoring; service spec "a grant matching on prior Assistance Listing surfaces from award history alone" with zero workflow rows |
| Active/forecast default, closed separately | DONE | `activeState` filter |
| Score from structured client facts | DONE | `shapeClientRelevanceProfile`, shared with the producer so live reads and the nightly job cannot disagree |
| Cap results | DONE | `SCAN_CAP_PER_SOURCE`, `MAX_PAGE_SIZE`, `totalIsCapped` |
| Sort: workflow → relevance → deadline → source update | DONE | `sortOpportunities`; spec asserts a pursued item outranks a higher-scoring suggestion, and that a null deadline sorts LAST |
| Preserve null amounts | DONE | service + web specs |
| Include why it matched | DONE | `matchedSignals` with verbatim `matchedOn` |
| Include what profile info is missing | DONE | `missing-profile-fields.ts`; every entry names the signal it feeds |
| Don't infer geographic restrictions | DONE | `geographicRestrictions: []` with the reason inline; audit §1 proves the source has no such field |
| Never `eligible` without structured applicant-type evidence | DONE | pre-existing `computeEligibility`, spec-covered |
| Improve rather than duplicate `grant-opportunity-relevance.ts` | DONE | extended in place with 2 strong signals + strength bands; the shipped producer's floor became DERIVED so the denominator change could not silently reduce its output |
| Eligibility separate, 4 states, always a reason | DONE | pre-existing, extended |

## §7 Contract discovery

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Use existing `SamOpportunity` ingestion | DONE | no second pipeline; four columns promoted out of the `raw_jsonb` the sync already stores |
| Deterministic client↔SAM engine | DONE | `sam-opportunity-relevance.ts`, 13 signals, 28 tests |
| NAICS / PSC exact | DONE | strong band |
| Set-aside compatibility | **DONE (data-limited)** | The code path exists and fires for a general small-business set-aside against a self-reported small business. It cannot fire for 8(a)/SDVOSB/WOSB/HUBZone because Capiro stores **no set-aside certifications** — audit §3c, with the exact column that would close it |
| Agency / subagency history | DONE | strong |
| Program Element with corroboration | DONE | requires an ACCEPTED (verbatim PE-code) notice link **and** a client-stated PE; spec asserts neither side alone fires |
| Source-backed place-of-performance overlap | DONE | banded by source specificity: city/ZIP-level is strong, state-only is moderate |
| Explicit tracked program relationship | DONE | the Program Element signal is that relationship |
| Moderate signals (capability, office, agency, product/service category, facility state) | DONE | all present |
| Weak signals recorded but never sufficient | DONE | `genericTopical` is recorded so a weak match can explain itself, and banded weak |
| Generic terms cannot create a suggestion alone | DONE | `meetsSuggestionFloor`; spec asserts a generic-only hit fails the floor and that weak hits contribute 0 to the score |
| "defense" not auto-rejected; needs a second signal | DONE | two specs, one each way |
| Notice lifecycle normalized and tested | DONE | 14 parameterised cases + an explicit "presolicitation must NOT read as solicitation" |
| UI communicates the stage | DONE | kind tag, plus a "Was Presolicitation" tag when `baseKind` differs |
| Value null → `Not stated`, never `$0`, never inferred | DONE | `ContractValue.basis = 'not_stated_by_source'`; web spec asserts the card contains no `$0` |
| Historical award data labelled historical | DONE | award history appears only as agency/office relevance signals and in the contractor panel's obligations column; it is never rendered as this notice's value |

## §8 Contractor identity

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Tier 1 exact UEI | DONE | `contractor-identity.ts`; auto-confirms only when unique and unambiguous |
| Tier 1 exact CAGE | **DONE (data-limited)** | Declared in the vocabulary and **not reachable**: `federal_contractor` has no CAGE column (its source publishes none). §8 conditions this on "when the source/model supports it". Audit §3b names the fix. A CAGE search returns an explicit unsupported-identifier message rather than zero rows |
| Tier 1 exact source record chosen by a user | DONE | `manual_pin`, tier 1 |
| Auto-confirm only when unique / no conflicting claim / structurally valid | DONE | 6 ambiguity tests |
| Tier 2 exact legal name + corroboration | DONE | basis exists; **policy does NOT permit tier-2 auto-confirm** — a parent and a subsidiary can share a registered name, and the corroborators available from this catalog are too thin to separate them |
| Tier 3 alias / former name / parent / subsidiary | DONE | `relationship_type` + `roll_up_awards` on the mapping; only ever set by a human action. Awards roll up only when a reviewer says so |
| UI shows entity, relationship, evidence, rollup, confirmation state | DONE | `ContractorCandidatePanel` + the table's basis column |
| Tier 4 fuzzy always review, never auto-confirm | DONE | `candidateDecision` tiered branch; fuzzy confidence additionally capped at 0.7 |
| All 6 duplicate/ambiguity cases | DONE | near-tie, shared name, malformed client UEI, missing source UEI, parent+subsidiary, already-claimed — one test each |
| Explanation: basis, confidence, identifiers, normalized names, corroborating + conflicting facts, award count, obligated, latest award, freshness | DONE | `MatchExplanation`; award count and latest award date are **null, not 0** — `federal_contractor` stores a total, not a count |
| Do not display a bare confidence percentage | DONE | the table leads with the basis; the panel shows identifiers/names/conflicts. Confidence is used for ordering |

## §9 Intelligence Mappings UX

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| `?source=&clientId=` preselects both | DONE | mappings spec |
| Immediately shows that client's suggestions | DONE | read-only candidate panel opens on arrival; previously seeing candidates required a tenant-wide WRITE |
| No need to search the client again | DONE | spec asserts another client's row is filtered out |
| Search by legal name, UEI, source UUID | DONE | `searchContractors` |
| Search by CAGE | **DONE (data-limited)** | detected and answered with an explicit reason; audit §3b |
| Search by alias | **DEFERRED** | no alias table exists; an alias is reachable only as a reviewed `relationship_type = 'alias'` mapping. Inventing an alias store was out of scope |
| Candidate display (name, UEI, aliases, parent status, awards, obligations, latest award, basis, explanation, confidence, confirm, reject) | PARTIAL | All present except **aliases** and **latest award date**, both of which the catalog does not hold (audit §2/§3). Shown as "not held", never as 0 or blank |
| `Find exact identifier matches` | DONE | route + button; auto-confirms tier 1 only, by construction |
| Keep `Resolve All Clients`, but no fuzzy auto-confirm | DONE | kept; `candidateDecision` cannot confirm a contractor name any more |
| Client profile CTA deep-links to the client-scoped flow | DONE | `missing-profile-fields.ts` emits the `?source=contracting&clientId=` href; asserted in the section spec |

## §10 API

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Dedicated module | DONE | `FundingOpportunitiesModule`, registered in `app.module.ts` |
| 7 routes | DONE | list, get-one, per-client list, save, patch, dismiss, restore (+ a summary route for the card) |
| All 14 query filters | DONE | DTO-validated, all length/range bounded |
| Bound all page sizes | DONE | DTO `@Max(100)` **and** a service clamp — the DTO 400s an absurd request, the clamp is the backstop for a non-HTTP caller |
| Role matrix | DONE | `standard_user`+ read/save/pursue/dismiss/assign/note; `client_portal_user` DENIED by rank. Mapping management stays on `IntelligenceController` at `user_admin` — splitting one review surface across two controllers with two guards is how a route ends up gated by neither |
| Use the REAL `RolesGuard` and decorator metadata in tests | DONE | boundaries spec constructs `new RolesGuard(new Reflector())` and reads `Reflect.getMetadata(ROLES_KEY, …)` |
| Tenant + actor from `CurrentTenant` | DONE | every route |
| Verify client belongs to tenant | DONE | `assertClientInTenant` |
| Verify facility belongs to the client | DONE | `assertFacilityBelongsToClient` — client, not merely tenant |
| Prevent cross-tenant owner assignment | DONE | `assertUserInTenant`; without it an owner uuid from a body could leak another tenant's name back to the caller |
| Prevent cross-tenant workflow reads / notes | DONE | all workflow access inside `withTenant`, RLS FORCE behind it |

## §11 Web surface

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Lazy route + nav item + suitable icon | DONE | `FileSearchOutlined`; nav gated on the flag. `App.funding-opportunities-nav.test.tsx` pins the route against the `/intelligence/*` catch-all, the nav entry's label/path/flag, and that `pageKeyFor` matches the specific path before the general prefix |
| Header: title, future-pursuit explanation, freshness, data quality, client selector | DONE | freshness names both rails with record counts and flags a degraded run |
| KPI strip, separate counts, **no blended dollar total** | DONE | spec asserts no `$` in the strip |
| 7 tabs | DONE | All / Grants / Government contracts / Saved / Pursuing / Deadlines / Dismissed |
| 10 filters | DONE | each with an accessible name (spec) |
| Cards with all 13 required elements | DONE | `OpportunityCard.tsx` |
| Actions: save, pursue, dismiss, restore, assign, note, link site, open source, create task | PARTIAL | Save/pursue/dismiss/restore/open-source are wired end to end. Assign owner, add note, link project site and create task are present as menu actions with **API support already in place** (`PATCH` accepts `ownerUserId`/`facilityId`/`notes`) but no modal yet — see Deferred |
| Ask Meri | **DEFERRED** | §14 conditions Meri on the underlying APIs being stable; these are new and undeployed. See below |
| No invented Strategy integration | DONE | none added |
| 8 honest states, and a failed request never renders as empty | DONE | `EmptyReason` + `emptyExplanation` from the API; separate error branch; specs for both |

## §12 Client profile card

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Section on the client Intelligence tab | DONE | `FundingOpportunitiesSection`, its own `SECTION_ORDER` entry placed BEFORE District Nexus so the ordering carries the distinction |
| **Always renders, even at zero matches** | DONE | spec: "it renders at ZERO matches, with an explanation" |
| All 10 required content items | DONE | counts, next deadline, top grants, top contracts, gaps, freshness, link |
| Empty state explains exactly why | DONE | uses the API's `emptyExplanation` + the gap list |
| Do not hide the card | DONE | only the feature flag hides it, which is not an empty state |
| DN copy: opportunities are not awarded district money | DONE | disclaimer + inline pointer |
| DN directs users to Funding Opportunities | DONE | client-scoped link |
| Only an explicit/reviewed project site creates district context | DONE | enforced in code (`districtBasis`), stated in copy, and spec-asserted both ways |
| No District Nexus score contribution from opportunities | DONE | boundaries spec asserts no DN file reads the workflow model, that the service never writes `ClientGrantNexus`, and that the DN scorer's `opportunityOnly` suppression is still a **zero** multiplier |

## §13 Workflow and notifications

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Save / pursue / dismiss (with reason) / restore | DONE | service spec |
| Restore lands on `saved`, not `suggested` | DONE | `suggested` means "a machine proposed this and nobody looked"; a human has now looked twice |
| Assign owner, add notes, link facility | DONE (API) | validated + tenant-checked; UI modals deferred |
| Won/lost only by explicit user action | DONE | producer cannot write them; DTO accepts them only on user routes |
| Auto-expire suggested when the source closes, preserving saved/pursuing | PARTIAL | The read path already treats a closed source as not-active and the producer marks its own stale suggestions, so nothing false is ever shown. A row's status is **not** flipped to `expired` — that needs a scheduled pass, and no EventBridge rule may be created here. Proposed schedule is in the runbook |
| Deterministic hooks for the 5 alert events | **DEFERRED** | The substrate exists — a persisted row with a relevance/eligibility snapshot and `staleAt` is exactly what a diff needs — but emitting notification records would touch the shared alert taxonomy, and no existing notification path for this surface is approved. Named as a rollout blocker rather than half-built |
| No emails / external notifications | DONE | none added |

## §14 Meri integration

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Read-only Meri tools | **DEFERRED**, on §14's own precondition | §14 says "only after the underlying APIs are stable". These APIs are new, undeployed and behind a dark flag. Adding a tool also requires editing `TOOL_DEFINITIONS`, regenerating `MERI_TOOL_MANIFEST` in `@capiro/shared`, changing a hard-coded tool-count assertion (currently 73), AND updating the orchestrator's delegated catalogs — where a catalog-partition mismatch is **boot-fatal**. MeriV2 Phase 1/2 are in flight on separate branches. Doing this here risks a boot failure in a different service for a read-only convenience |
| No bypassing write tool | DONE (vacuously) | no Meri tool added |
| No model call alters deterministic scores | DONE | both engines are pure and LLM-free by construction |

## §15 Ingestion and scheduling

| Req | Status | Implementation / evidence |
| --- | --- | --- |
| Grants.gov behaviour verified | DONE | audit §1 |
| SAM.gov behaviour verified | DONE | audit §2 |
| Extend SAM only where fields are genuinely missing | DONE | 4 columns, promoted from `raw_jsonb`, one shared extractor with the backfill |
| Client→grant producer | DONE (pre-existing, corrected) | floor now derived |
| Client→SAM producer | DONE | `generate-sam-opportunity-candidates.ts` |
| Exact-identifier contractor producer | DONE | `match-contractor-identifiers.ts` |
| Dry run by default / `--commit` | DONE | all three; the contractor producer's dry run reports read-only verdicts rather than calling a write path and hoping |
| Tenant filter, client filter, min relevance | DONE | `--tenant`, `--client`, `--min-relevance` |
| Idempotent | DONE | find-then-create-or-update; producer spec asserts a re-run refreshes rather than duplicating |
| Preserves human decisions | DONE | 8 tests |
| No per-pair N+1 | DONE | spec asserts the notice catalog is read once for 24 pairs |
| Page/batch bounds | DONE | `OPPORTUNITY_SCAN_CAP`, `CLIENT_CAP`, keyset paging in the backfill |
| `SyncRun` status | DONE | `runWithSyncRun` |
| Honest partial completion | DONE | `capped` is returned and logged loudly |
| No cross-tenant access | DONE | bypass + EXPLICIT `tenantId` on every scoped query; spec asserts both halves |
| **No EventBridge rule created or enabled** | DONE | none touched; proposed schedules are runbook text only |

## §16 Testing

| Area | Status | Where |
| --- | --- | --- |
| grant relevance | DONE | `grant-opportunity-relevance.spec.ts` (29) |
| SAM relevance | DONE | `sam-opportunity-relevance.spec.ts` (28) |
| eligibility (both rails) | DONE | both specs |
| notice lifecycle | DONE | `opportunity-kind.spec.ts` |
| unknown money | DONE | service spec + web spec |
| exact UEI contractor match | DONE | `contractor-identity.spec.ts` |
| exact CAGE where supported | DONE | asserted **unsupported**, with the reason |
| fuzzy-name review behaviour | DONE | contractor-identity + entity-resolution specs |
| ambiguity | DONE | 6 cases |
| parent/subsidiary | DONE | contractor-identity spec |
| workflow persistence | DONE | service spec |
| producer idempotency | DONE | producer spec |
| preserving human states | DONE | producer spec |
| tenant isolation | DONE | service + boundaries specs |
| role matrix | DONE | boundaries spec, real guard + real metadata |
| facility ownership | DONE | service spec |
| cross-tenant owner prevention | DONE | service spec |
| pagination | DONE | service spec (no repeat/skip across 3 pages) |
| source failure vs empty | DONE | service spec (throws) + web spec (error branch) |
| source freshness | DONE | service spec incl. degraded-run and read-failure-degrades-to-unknown |
| expired opportunities | DONE | service spec (SAM active-with-past-deadline) |
| dismissed opportunities | DONE | service spec |
| no blended amount | DONE | boundaries + web specs |
| no DN score contribution | DONE | boundaries spec |
| **Web**: nav item, lazy route, client card, no-match explanations, failed request, filters, save/pursue/dismiss/restore, grant-vs-contract labels, null money, deadlines, freshness, profile gaps, mapping deep link, exact identifier suggestion, accessible names | DONE | 60 tests across 4 files. The nav-item and lazy-route rows were the last to be covered: they were implemented and reviewed but had no spec until `App.funding-opportunities-nav.test.tsx` was added during verification — recorded here because the earlier revision of this table claimed them as tested when only the other 54 were |
| standard-user vs admin controls (web) | PARTIAL | Enforced and tested on the API side (real guard). The web surface renders no admin-only control on the opportunities page, so there is nothing to hide there; the mapping actions live on the settings page, whose existing role gating is unchanged |
| Migration tests | DONE | 10 assertions |
| Performance tests | DONE | no-N+1 (producer spec), bounded scans (caps asserted), no tenant transaction across a catalog scan (structural: catalog reads are outside `withTenant` by construction, boundaries spec asserts the exemption comments exist) |

## §18 Documentation

| File | Status |
| --- | --- |
| `implementation-baseline.md` | DONE |
| `data-gap-audit.md` | DONE |
| `completion-matrix.md` | this file |
| `verification.md` | DONE — first status line is `Overall: PASS`, scoped explicitly to the commands that can run without a live database or a deployed branch. 30 commands with real exit codes, plus the full-suite comparison against `57a8a5b2`: **zero new failures** in either app (api 12 failed suites / 40 failed tests on both sides, identical sets; web green on both) |
| `docs/runbooks/funding-opportunities-rollout.md` | DONE — 19 numbered steps, read-only and mutating separated |

---

## Merge blockers

| # | Blocker | State |
| --- | --- | --- |
| MB-1 | `verification.md` must say `Overall: PASS` | RESOLVED — it does, with the scope of that word stated in the file |
| MB-2 | CI green on the branch | **RESOLVED** — all three checks pass on `50970a06`: `verify` 5m32s, `legiwatch` 6m2s, `engagement` 3m37s. `engagement` applied all 187 migrations to a clean Postgres, this one included. But `ci-pr.yml` never runs the `apps/api` or `apps/web` suites, so the local branch-vs-baseline comparison in verification.md remains the only evidence of no regression |
| MB-3 | Branch behind main | RESOLVED — `main` merged, no conflicts |
| MB-4 | Temporary CI step removed | RESOLVED |
| MB-5 | Manual browser walk of the new surface | **OPEN.** The branch is not deployed and the flag is off everywhere, so no browser walk of this feature has happened. Component tests are not a substitute for it. Steps 15.1–15.14 of the runbook are that walk, including the two things nothing here measures: reflow at ~820px and tab traversal |
| MB-6 | Four card actions have API support but no UI modal | **OPEN.** Assign owner, add note, link project site and create task are menu entries whose `PATCH` fields already validate and tenant-check, but there is no modal to drive them. §11's actions row is PARTIAL for this reason; listed here so "user workflow is incomplete" (§19) is not left implicit |

## Rollout blockers (all require Neo's approval)

| # | Blocker |
| --- | --- |
| RB-1 | Migration `20260810010000_funding_opportunities` is **not applied anywhere**. Nothing in this feature works until it is |
| RB-2 | `funding_opportunities` flag is **off for every tenant**, including capiro-internal. Deliberate: this guard has no internal fallback |
| RB-3 | `backfill-sam-opportunity-fields.ts` has **never been run**, so `set_aside` / `base_type` are NULL on every existing notice. Until it runs, notice-stage display and set-aside filtering are inert |
| RB-4 | No producer has run, in dry-run or commit mode, against any real data |
| RB-5 | No EventBridge schedule exists for either new producer |
| RB-6 | `staleAt`-based auto-expiry of suggested rows has no scheduled pass |
| RB-7 | Alert hooks (§13) are not implemented — deadline-changed / amended / cancelled / closing-soon emit nothing |
| RB-8 | Meri tools (§14) not added |
| RB-9 | Contract eligibility can never say `eligible` until `clients.set_aside_certifications` exists (audit §3c) |
| RB-10 | `exact_cage` matching is unreachable until a CAGE-bearing contractor source exists (audit §3b) |
