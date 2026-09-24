# Business Development Phase 2 — evidence dossier

Date: 2026-09-24

Status: implemented and locally qualified on `feat/business-development-phase2-20260924`; AWS release evidence is added after the merged-main rollout.

## Scope and user path

Phase 2 adds a bounded company-discovery and evidence-dossier path to the Phase 1 firm-owned prospect pipeline:

`Discover → search governed candidates → open dossier → inspect source → review identity → save/open Phase 1 prospect`

The release is deterministic and source-led. It does not call Jev, generate a Meri brief, send watch notifications, start ingestion jobs, or create a new outreach path. People Data Labs (PDL) is not called or persisted.

Phase 2 adds no database migration: it reads the Phase 1 schema and existing governed projections. The normal release migration task is still run before the API rollout as an idempotent safety gate.

## Source-of-truth map

| Dossier concern | First source | Join/evidence rule | Live provider behavior |
| --- | --- | --- | --- |
| Organization identity | `canonical_entity`, aliases, and identifiers | Reviewed internal link first; exact UEI/CAGE next; name/domain never silently merges parent and subsidiary | SAM entity lookup is an independently gated verification rail |
| Contract exposure | `federal_award` | Exact recipient UEI is direct. Exact legal-name-only matches remain conditional/unverified | Existing USAspending-ingested rows remain available when SAM is off |
| Assistance exposure | `federal_assistance_award` | Exact recipient UEI is direct; assistance and contracts stay separate | Existing USAspending-ingested rows are the primary read projection |
| Opportunities | `sam_opportunity` where used | A notice is opportunity/issuing-office context, not evidence the company will bid and not a PE-owner link | No list-page fan-out; provider errors cannot blank other sections |
| Lobbying | `lda_filing`/`lda_client` | Filing/client identifiers and reporting period are preserved; ambiguous name matches are labeled | Existing Senate LDA projection is primary; no claim of “no lobbyist” from an empty bounded scope |
| Footprint | reviewed client facilities and sourced award geography | HQ, facility, place of performance, recipient address, and district jobs remain distinct | No PDL-derived jobs or automatic facility inference |
| Budget/program context | existing Program Element/budget projections | Requested, enacted/authorized, obligated, awarded, ceiling, and forecast values remain distinct; thematic context is never a funding link | No duplicate budget ingestion or source rerun |
| People | none in this release | Disabled/deferred coverage state | PDL people calls are prohibited pending written rights |

## Provider rights and limits

- USAspending is public and keyless. The product prefers already-governed Capiro award projections; bounded official API checks are release evidence/freshness checks, not a second ingestion path.
- SAM entity/opportunities requires a server-side key. The current development account has a key in Secrets Manager. The non-federal/no-role default quota is low, so candidate-list rendering makes zero SAM calls; exact-ID lookup is limited to an opened dossier and can be disabled independently.
- Senate LDA permits authenticated or stricter anonymous use. Retrieval date and the Senate Office of Public Records data-quality disclaimer must remain visible in release/source documentation.
- PDL is disabled. Its acceptable-use policy contains a defense/intelligence restriction that requires a written contractual determination for Capiro's intended use. No PDL credential is present in the development runtime and this release creates no PDL client.

## Flags

All Phase 2 flags default off and are evaluated server-side:

- `businessDevelopment.dossier.enabled`
- `businessDevelopment.provider.sam.enabled`
- `businessDevelopment.provider.lda.enabled`
- `businessDevelopment.provider.pdlCompany.enabled`
- `businessDevelopment.provider.pdlPeople.enabled`

The Phase 1 `businessDevelopment.enabled` gate remains required. The planned internal rollout enables the dossier/public-source path for `capiro-internal`; PDL flags remain false.

## Security and tenancy

- Candidate public facts may originate in global governed projections, but firm markers are joined only inside the caller's tenant transaction with explicit tenant predicates.
- Notes, conflict reasons, hypotheses, preferences, owner state, and query context are never sent to a provider or placed in a shared cache.
- Saving uses the Phase 1 create/restore transaction. Identity review uses Phase 1 identity/audit semantics and preserves prospect id, stage, owner, notes, watch request, and client link.
- Cross-tenant prospect ids return the same safe not-found response as unknown ids.

## Normalized evidence contract

Every rendered fact carries source family, source record/version id, locator, original source name/id, claim type, relationship strength (`direct`, `conditional`, `thematic`, or `unresolved`), event/effective date, fiscal year/stage, source update time, Capiro fetch/check time, bounded scope, and coverage status (`available`, `empty_in_queried_scope`, `ambiguous`, `stale`, `partial`, or `error`).

Direct evidence is visually distinct. Conditional/thematic evidence is grouped as potential relevance. An unavailable source changes only its own section.

## Provider budgets and retry ownership

- Candidate search: zero external provider calls.
- Dossier open: at most one gated exact-identity SAM request; no PDL requests.
- Section retry: explicit user action; no automatic charged-provider retry or cross-section fan-out.
- API timeouts and pagination caps inherit the existing provider clients and read-projection caps. A disabled, quota-limited, timed-out, or partial provider returns a coverage state rather than a numeric zero or exhaustive-negative claim.

## Verification evidence

- Targeted API tests: 8 suites, 167 tests passed (`src/business-development` and `src/users/users.controller.spec.ts`). The suite covers bounded no-provider candidate search, exact-ID SAM lookup at most once, disabled/missing/quota/error partial states, independent dossier sections, PDL zero-call behavior, authorization, DTO contracts, and Phase 1 identity-preservation behavior.
- Targeted web tests: 2 files, 44 tests passed. They cover fail-closed gating, explicit URL-backed search and paging, progressive/independent dossier requests, source inspection, partial/error retry, direct-versus-potential labels, back/reload routing, correction, save/open-existing, and no people-provider request.
- API/web type checks: passed. API and web production builds: passed before release packaging.
- Two-tenant database/RLS proof: `business-development-phase2-tenant-markers.sql` passed against disposable PostgreSQL as restricted `capiro_app`. Tenant A and tenant B saw only their own prospect/client/activity markers on the same global candidate; a cross-tenant update affected zero rows; an unset tenant saw zero private rows; the rehearsal rolled back. The Phase 1 RLS and real-Postgres transaction acceptance (confirm race, identity preservation, exactly-once conversion, structured duplicate conflict) also passed.
- Provider fixture/error/quota proof: the API suite verifies SAM disabled, no-key/failure/429-style error, no-match, exact UEI/CAGE and non-identity zero-call behavior. LDA reads the governed projection only. PDL has no adapter/client and reports `callsMade: 0`.
- Hermes delegation: reconnaissance, backend implementation/verification, and frontend implementation/verification used `z-ai/glm-5.3` at low reasoning. Peak observed session context was 11.9%, below the 50% stop limit.
- Browser desktop/narrow/keyboard proof: recorded after the merged-main AWS rollout.
- Live permitted source checks:
  - USAspending, retrieved `2026-09-24T17:59:55.0465815Z`: bounded `spending_by_award` search (`limit=1`, contracts, Lockheed Martin, FY2026 interval) returned generated award id `CONT_AWD_Z61H_9700_FA822408G0001_9700`, recipient `LOCKHEED MARTIN CORPORATION`, amount `16416.33`, Department of Defense, start `2012-11-08`, end `2026-07-20`. This validates endpoint/field semantics only; it is not an exhaustive coverage claim.
  - Senate LDA, retrieved `2026-09-24T18:00:03.6420432Z`: bounded 2026 filing search (`page_size=1`) returned filing `dedc9bd7-5168-4cad-8973-aece07645b9f`, client id `196195`, Q1 2026, posted `2026-04-02`, including BUD/DEF/TAX issue records. The Senate Office of Public Records cannot vouch for data or analysis after retrieval; the product preserves filing id, period, retrieval date, and the source locator.
  - SAM exact-identifier check:
- Candidate/dossier p95 and calls per search/open: candidate search makes zero external calls; a progressive open makes at most one exact-ID SAM call and zero PDL calls. Live latency is recorded after rollout.
- Development image digests/task-definition revisions: recorded after rollout.
- Smoke results: recorded after rollout.

## Rollback

1. Disable a failing provider flag; the existing/internal-source dossier and Phase 1 pipeline remain available.
2. Disable `businessDevelopment.dossier.enabled` for the tenant to remove Phase 2 UI/API behavior without changing Phase 1 prospect records.
3. If necessary, restore the previous schema-compatible API and web image digests/task definitions.
4. Do not delete or rewrite Phase 1 prospects, history, audit records, or reviewed identity state.

PDL remains disabled through every rollback and re-enable path until rights are documented.

## Later phases

- Phase 3: Jev semantic/entity/signal judgment and evaluated rank effects.
- Phase 4: Meri prospect briefs and follow-ups.
- Phase 5: watch delivery and alerts.
