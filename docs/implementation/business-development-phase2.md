# Business Development Phase 2 — evidence dossier

Date: 2026-09-24

Status: implemented, merged in [PR #1785](https://github.com/neo-capiro/capirov2/pull/1785), deployed to the development ECS services, and enabled for `capiro-internal`. The Phase 2 implementation commit is `99c59f25bd02699d52248e082bcbbee1681f253e`; GitHub merged it as `9c98505884770a3fc781ab2cbbb4d59bc2d02d95`.

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

The Phase 1 `businessDevelopment.enabled` gate remains required. The internal development rollout uses the following exact state for `capiro-internal`:

- `businessDevelopment.enabled=true`
- `businessDevelopment.dossier.enabled=true`
- `businessDevelopment.provider.sam.enabled=true`
- `businessDevelopment.provider.lda.enabled=false` (the already-governed LDA projection remains readable; no live LDA fetch is performed)
- `businessDevelopment.provider.pdlCompany.enabled=false`
- `businessDevelopment.provider.pdlPeople.enabled=false`

The committed flag task was `b2823a030a1240b19474cef474da631e` (exit 0). SAM was then turned off and restored with successful one-off tasks during the fail-soft smoke; the final state is true.

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
- Browser desktop/narrow/keyboard proof: passed against `https://app.capiro.ai/clients?view=business-development` on the deployed images. The authenticated journey covered desktop and a 390×844 viewport, Tab/Enter search submission, URL-backed back/forward navigation, reload persistence, progressive sections, source inspectors, save/open-existing, and partial-data rendering.
- Live permitted source checks:
  - USAspending, retrieved `2026-09-24T17:59:55.0465815Z`: bounded `spending_by_award` search (`limit=1`, contracts, Lockheed Martin, FY2026 interval) returned generated award id `CONT_AWD_Z61H_9700_FA822408G0001_9700`, recipient `LOCKHEED MARTIN CORPORATION`, amount `16416.33`, Department of Defense, start `2012-11-08`, end `2026-07-20`. This validates endpoint/field semantics only; it is not an exhaustive coverage claim.
  - Senate LDA, retrieved `2026-09-24T18:00:03.6420432Z`: bounded 2026 filing search (`page_size=1`) returned filing `dedc9bd7-5168-4cad-8973-aece07645b9f`, client id `196195`, Q1 2026, posted `2026-04-02`, including BUD/DEF/TAX issue records. The Senate Office of Public Records cannot vouch for data or analysis after retrieval; the product preserves filing id, period, retrieval date, and the source locator.
  - SAM exact-identifier check, retrieved `2026-09-24T23:42Z`: UEI `FM1QY7CA5VD5` returned `SATCOM DIRECT GOVERNMENT, LLC`, active registration, CAGE `68G21`, expiration `2026-10-30`, and exact-UEI match basis. The source inspector preserved the SAM record id, scope, source update time, Capiro fetch time, relationship strength, and source link.
- Candidate/dossier latency and call budget, from `Capiro/ApiLatency` events captured `2026-09-24T23:35Z`–`23:46Z`:
  - Candidate search: `n=7`, p50 `219 ms`, p95/max `450 ms`; zero external provider calls.
  - Company dossier progressive section requests: `n=12`, p50 `343 ms`, p95/max `2,506 ms`; the maximum was the exact-UEI live SAM identity request. A progressive open makes at most one SAM call and zero PDL calls.
  - Saved-prospect dossier progressive section requests: `n=6`, p50 `205 ms`, p95/max `283 ms`.
- Development release identifiers:
  - API task definition `capiro-dev-api:450`, image `capiro/dev/api@sha256:c9a6287725c5b36262833c45d7629bf9ad27dd855ae423e0f59826c370fe2993`, release SHA `d31604f6e489fdd76b5175241c6eeb547d2fcf0c`. That later main commit contains the Phase 2 merge and preserves the subsequent Package 6 API release. The SAM key is injected from Secrets Manager only in the API runtime.
  - Web task definition `capiro-dev-web:135`, image `capiro/dev/web@sha256:5a39de54764dc626c3101c20df1aa9211e6ec3d8bd21b6c1e543fb5c9348ee3a`, build SHA `1182543bbe95f55d6640ea6b1b478ca5a9c609ed`.
  - Migration task definition `capiro-dev-api-admin-migrate:68`, task `922739b064314c269a8e6fc735861216`, exit 0: 427 migrations found and no pending migrations.
  - Both services reached ECS steady state with zero failed tasks. The two production API streams emitted 2,608 events during the QA window with zero `error`, `exception`, `fatal`, or Prisma-failure matches.
- Smoke result: passed `search → open dossier → inspect SAM and USAspending source records → disable SAM and verify internal sections stay available → restore SAM → save prospect → reopen existing prospect → attempt ambiguous identity correction and verify duplicate conflict opens the existing prospect without merging histories`.
  - The development account initially had zero canonical organizations, so an idempotent, tenant-private release-evidence organization was created only for `capiro-internal`: entity `d6cc5c1f-949e-418e-bfc5-707b5606d994`, UEI `FM1QY7CA5VD5`, marked `business-development-phase2-20260924` in metadata. It joins 292 existing governed award records by exact UEI.
  - Saved prospect: `88b1875d-e047-44ff-a7ab-1870dbe47407`.
  - Ambiguous/duplicate-review prospect: `b009f2bd-c260-4d3e-81b6-39a4b7015912`; the attempted correction was refused because the saved prospect already held the canonical organization, and the UI opened the existing prospect instead.

## Rollback

1. Disable a failing provider flag; the existing/internal-source dossier and Phase 1 pipeline remain available.
2. Disable `businessDevelopment.dossier.enabled` for the tenant to remove Phase 2 UI/API behavior without changing Phase 1 prospect records.
3. If necessary, restore the previous schema-compatible API and web image digests/task definitions.
4. Do not delete or rewrite Phase 1 prospects, history, audit records, or reviewed identity state.

PDL remains disabled through every rollback and re-enable path until rights are documented.

The immediate service rollback references for this release are API `capiro-dev-api:449` and web `capiro-dev-web:134`. The fastest functional rollback is to set `businessDevelopment.provider.sam.enabled=false`; for a dossier regression, set `businessDevelopment.dossier.enabled=false`. Neither action deletes Phase 1/2 prospect, identity-review, or audit history.

## Later phases

- Phase 3: Jev semantic/entity/signal judgment and evaluated rank effects.
- Phase 4: Meri prospect briefs and follow-ups.
- Phase 5: watch delivery and alerts.
