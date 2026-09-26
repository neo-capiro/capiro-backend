# Business Development Phase 5 — Existing Source Matrix

Status: implementation-accurate inventory. Phase 5 adds no ingestion and inherits both freshness and data rights from each existing owner.

| Family | Existing projection | Existing owning path | Watch linkage and material comparison | Cadence / rights evidence |
|---|---|---|---|---|
| Federal contracts | `FederalAward` / `federal_award` | `apps/api/scripts/sync-federal-award.ts` and its existing enrichment/backfill helpers | Exact recipient UEI; direct comparison of allowlisted award identity, amount, agency, stage/program, event dates, place, and description fields | Existing EventBridge rule `capiro-dev-sync-federal-award`, enabled daily at 09:50 UTC (`cron(50 9 * * ? *)`), observed 2026-09-25; watch inherits the existing public-record use and cadence |
| Federal assistance | `FederalAssistanceAward` / `federal_assistance_award` | `sync-federal-assistance-awards.ts`, `backfill-assistance-awards-bulk.ts`, `enrich-assistance-award-details.ts` | Exact recipient UEI; direct comparison of allowlisted obligated amount, agency, dates, and description | Existing rule `capiro-dev-sync-federal-assistance-awards`, enabled daily at 11:20 UTC (`cron(20 11 * * ? *)`), observed 2026-09-25; rights/cadence remain owned by that ingestion path |
| SAM opportunities | `SamOpportunity` / `sam_opportunity` | `sync-sam-opportunities.ts`, `backfill-sam-opportunity-fields.ts` | Bounded notices for agencies exposed by exact-UEI award history; relationship is thematic/conditional, not company intent; compares notice/stage, dates, agency/office, NAICS/PSC, set-aside, and source URL | Existing all-federal rule `capiro-dev-sync-sam-opportunities-all-federal`, enabled daily at 00:15 UTC (`cron(15 0 * * ? *)`), observed 2026-09-25; the older narrow rule is disabled |
| Tango entity snapshots | `TangoResourceSnapshot` / `tango_resource_snapshot` | `apps/api/src/external/tango/` and existing `sync-tango-*` / event-processing scripts | Active `entity` snapshot whose `externalId` is the exact UEI; normalized allowlisted entity facts and existing `contentSha256` revision | Existing commercial agreement and event/sync ownership are inherited. No enabled entity-specific EventBridge rule was present in the 2026-09-25 inventory (the separate subaward rule was disabled); Phase 5 reads stored snapshots only and exposes no raw provider payload |
| LDA filings | `LdaFiling` / `lda_filing` | `apps/api/scripts/sync-lda.ts` | Bounded candidate read followed by exact `normalizeCompanyName` comparison to the confirmed canonical name/aliases; name-only linkage remains conditional | Existing rule `capiro-dev-sync-lda`, enabled weekly Sunday at 06:00 UTC (`cron(0 6 ? * SUN *)`), observed 2026-09-25; a missing bounded match never claims absence of lobbying |
| Acquisition revision ledger | Existing acquisition-continuity revision models | Existing acquisition-continuity store | **Deferred.** Existing identity keys do not yet prove an exact prospect/company link; excluded from the default allowlist and never fuzzy-linked | No Phase 5 evaluation or alerting until the exact-link gate is separately satisfied |

## Binding freshness rule

The evaluator sees only what the existing projection has already stored. Its `lastCompletedCheckAt` reports completion of the DB-only comparison, not a promise that a provider is current. Alert event/effective/publication/first-observed dates remain separate. When a source read is incomplete or ambiguous, that source becomes partial/error and its last complete baseline/check marker does not advance.

Phase 5 never triggers an ingestion refresh. Requests for a different source cadence belong to the existing ingestion owner and are outside this release.

## Binding rights rule

The watch reads the same normalized projection fields already used by the product and stores only the small allowlisted comparison state, source identity, dates, locator, and alert decision. It introduces no provider account, no new licensed corpus, and no raw-payload mirror. A rights pause on an owning ingestion path automatically limits the watch to the last stored projection; the watch does not bypass it.

## No additive ingestion fields required

The MVP observes changes by comparing allowlisted material fields directly. Tango already supplies a content hash/version. Federal award, assistance, SAM, and LDA ingestion schemas and writers were not changed. If a future source requires a new revision field, it must be a minimal additive field on that source's existing owning path after owner review—not a watch-owned mirror or fetcher.

## Rollout gates

Before expanding beyond the internal tenant, operations must record:

- current production cadence (inventory above) and last successful owning-ingestion run for each enabled family at pilot time;
- confirmation that current rights cover derived in-app alerts from the already-stored fields;
- a sample of alerts and quiet decisions confirming identity, amount/stage, date, backfill, and conditional-language accuracy.

Unknown source-family names fail configuration validation. The safe default list is exactly the five active families above and excludes acquisition revisions.
