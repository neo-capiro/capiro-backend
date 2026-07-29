# Funding Opportunities — implementation baseline

Captured from the actual repository state before any code in this PR was written.
Every path, model, field and behaviour below was read out of the tree, not
inferred from a summary.

## Branch facts

| Fact | Value |
| --- | --- |
| Branch | `agent/funding-opportunities-auto-matching` |
| Branch SHA at start of work | `c51e5ea34f5f1249990bf145628a6c4a4a674ad3` |
| Branch SHA after merging `main` | `872df554e683fce68a5988b907916f2d0e3b8b09` |
| `origin/main` SHA | `57a8a5b2c3dee39249ca8f8aebbb2e0fee0965d9` |
| Was the branch behind `main`? | **Yes.** Merge-base was `8e3452b9629292a537fe5fa8a5efeafdc9a3fa9d`, ~100+ commits behind. `origin/main` was merged in (no conflicts) before any implementation work. |
| Worktree used | `C:\dev\capiro-funding-wt` (dedicated; the primary `C:\dev\capirov2` checkout was on an unrelated branch and was not touched) |

### What PR #667 actually contained

**One commit, one file.** `c51e5ea3 chore(ci): temporarily package branch source
for implementation` changed only `.github/workflows/ci-pr.yml`:

1. added a `tar`-and-upload-artifact step (the temporary source-packaging step);
2. **corrupted an unrelated comment** — `// @capiro/api-strategy … (G1 scaffold). The`
   became `(G1 scaffold). G1 scaffold). The`.

There was no feature code, no schema change, no test. Reverting `ci-pr.yml` to
`main`'s version removes both the temporary step and the comment corruption in one
edit, which is what this PR does.

## Existing models (read from `apps/api/prisma/schema.prisma`)

| Model | Table | Tenant-scoped? | Notes |
| --- | --- | --- | --- |
| `FederalGrant` | `federal_grant` | No — global, no RLS | Grants.gov opportunity. `id` is the Grants.gov opportunity id (TEXT). |
| `SamOpportunity` | `sam_opportunity` | No — global, no RLS | SAM.gov notice. `id` is a uuid; `noticeId` is the unique source key. Stores full source payload in `raw_jsonb`. |
| `SamOpportunityMatch` | `sam_opportunity_match` | No — global | Review-gated notice → Program/PE link. Only a verbatim PE-code hit is auto-`accepted`; PSC/NAICS-only is `quarantined`. |
| `FederalContractor` | `federal_contractor` | No — global | `name` (unique), `uei`, `recipientId`, `totalContracts`. **No CAGE column.** Written by `sync-openspending.ts`. |
| `ClientIntelMapping` | `client_intel_mapping` | **Yes**, FORCE RLS | `(clientId, source, externalId)` unique. Sources: lda, contracting, sec, fec_employer, fec_committee, fara, lobby_intel, assistance_recipient. Had `confidence` + `confirmed` and **nothing recording WHY**. |
| `ClientGrantNexus` | `client_grant_nexus` | **Yes**, FORCE RLS | District-Nexus EVIDENCE. `relationshipType` includes `opportunity_candidate`. FK-less pointers to `federal_grant` / `federal_assistance_award` / `client_facilities`. |
| `Client` | `clients` | **Yes**, FORCE RLS | Carries `uei`, `cageCode`, `naicsCodes[]`, `pscCodes[]`, `applicantTypes[]`, `sectorTag`, `ldaClientIds[]`. |
| `ClientCapability` | `client_capabilities` | **Yes** | `name`, `keywords[]`, `tags` (JSON), `peNumbers[]`, `sector`. |
| `ClientFacility` | `client_facilities` | **Yes** | `state`, `congressionalDistrict`, geocode columns. The only path from a client to a district. |
| `SyncRun` | `sync_run` | No | Ingestion watermarks; `source` is the verb name. |

## Existing routes (before this PR)

`IntelligenceController` (`@Controller('intelligence')`, `@Roles('standard_user')`):

- `GET  mappings` / `GET mappings/:clientId`
- `POST mappings/:clientId/resolve`
- `PATCH mappings/:mappingId`
- `POST mappings/:clientId/manual` (`@Roles('user_admin')`)
- `POST resolve-all` (`@Roles('user_admin')`)
- `GET  contractors/search`, `lda-clients/search`, `fec-employers/search`,
  `assistance-recipients/search`
- `GET  clients/:clientId/district-nexus`, `.../profile-v1`, and ~20 others

`DistrictNexusController` — behind `DistrictNexusFlagGuard` (`district_nexus_v2`).

**There was no opportunity route of any kind.** Grant opportunities were reachable
only as a sub-field of the District Nexus client aggregate.

## Existing Grants.gov ingestion behaviour

- `scripts/sync-grants.ts` → `sync_run.source = 'sync-grants'`. Reads
  `api.grants.gov/v1/api/search2`, which returns **exactly ten fields**
  (`id, number, title, agencyCode, agency, openDate, closeDate, oppStatus,
  docType, cfdaList`) — verified live 2026-07-24 per the script's own header. It
  writes only those columns plus a constructed `url`, deliberately, so it cannot
  wipe the enrichment pass's work.
- `scripts/enrich-grant-details.ts` owns everything else: `category`,
  `fundingInstrument`, `awardCeiling/Floor`, `estimatedFunding`, `expectedAwards`,
  `eligibility`, `description`, `eligibilityText`, `costSharing`, `docType`,
  `revision`, `responseDateDesc`, `amendmentCount`, `lastUpdatedAt`, `raw`.
- `--all-statuses` reconciles all four statuses; `MAX_PAGES = 1000`
  (~100,000 records vs a measured all-status corpus of 82,998 on 2026-07-28).
- A capped run logs loudly rather than silently truncating.

## Existing SAM.gov ingestion behaviour

- `scripts/sync-sam-opportunities.ts` → `sync_run.source = 'sync-sam-opportunities'`.
  `api.sam.gov/opportunities/v2/search`, DoD-filtered by the `deptname` API param
  **and** a client-side org-path check.
- Incremental window from the SyncRun watermark; `--backfill` + `--posted-to` for
  historical windows (SAM caps a search span at ~1 year).
- `SAM_MAX_PAGES` default 50 → 5,000 rows/run; a capped window logs `⚠️ CAPPED`.
- `--match-only` re-runs the pure matcher over the whole existing table.
- **Dropped four source fields it already received**: `baseType`, `subTier`,
  `typeOfSetAside`, `typeOfSetAsideDescription`. All four are present in the
  `raw_jsonb` it stores, so they were recoverable without re-fetching.

## Existing matching behaviour

### Grant relevance (`src/district-nexus/grant-opportunity-relevance.ts`)

Six signals — `assistanceListing` 40, `agency` 20, `capabilityKeyword` 15,
`sector` 10, `fundingCategory` 10, `knownPartner` 5 — over a fixed denominator of
100. Eligibility computed separately, with a reason, from `federal_grant.eligibility`
vs `Client.applicantTypes` (label strings, compared through `applicantTypeKey`).
Already correct on two subtle points: `fundingCategory` is compared only against
`client.sector` (never the opportunity's own text), and `sector` is tokenized with
generic tokens stripped.

### SAM relevance

**Did not exist.** `scripts/sam-opportunity-matcher.ts` matches notices to
Program Elements, not to clients. Its `program_alias` tier is documented as
permanently DORMANT (no office/PSC hint source is wired), so live SAM matches come
only from `description_pe_code` and `psc_naics_component`.

### Contractor identity (`src/intelligence/entity-resolution.service.ts`)

`matchContractor` was `similarity(name, $clientName) > 0.3` against
`federal_contractor.name` — **name similarity only, no UEI path at all**, even
though both `Client.uei` and `federal_contractor.uei` exist.

## Implementation gaps found (the actual worklist)

| # | Gap | Severity |
| --- | --- | --- |
| G1 | Grant opportunities were visible **only** where a nightly `ClientGrantNexus` `opportunity_candidate` row existed. No producer run ⇒ the surface is permanently, silently empty. | Core |
| G2 | SAM.gov contract opportunities had **no client-facing surface at all** and no client↔notice matching engine. | Core |
| G3 | No durable opportunity workflow. Nothing could be saved, pursued, dismissed, assigned, annotated or linked to a project site. | Core |
| G4 | `matchContractor` was name-similarity only, and `candidateDecision` let `contracting` **auto-confirm at confidence ≥ 0.85**, which `scoreCandidate` awards for a multi-token exact fingerprint. **A name could silently become a confirmed corporate identity.** | **Defect** |
| G5 | `IntelligenceService.resolveMapping` created rows with `confirmed: r.confidence >= 0.6` from a **raw pg_trgm similarity** — no fingerprinting, no distinctiveness guard, no ambiguity check. The equivalent defect on the assistance side produced 173 wrong candidates out of 183 live. | **Defect** |
| G6 | `ClientIntelMapping` recorded no match basis, tier or evidence — the UI could only show a bare confidence percentage, and the identity gap (subsidiary / former name / parent) was unrepresentable. | High |
| G7 | `federal_contractor` has **no CAGE column** (its source publishes none), and contractor search could not be queried by UEI at all — so the one identifier that resolves "RTX" ↔ "RAYTHEON TECHNOLOGIES" was unreachable. | High |
| G8 | Four SAM source fields dropped on ingest, including `baseType` — without it an amended notice cannot be told from an original solicitation. | High |
| G9 | `/settings/intelligence-mappings` had no client-scoped entry: a CTA from a client profile landed the reviewer in the whole tenant's list. Seeing candidates at all required pressing a button that WROTE mappings for every client. | Medium |
| G10 | `apps/api/tsconfig.json` **excludes `scripts`**, so no producer script is typechecked by `pnpm typecheck`. This is the gap that let PR #651 ship an uncompilable producer through green CI. | Medium |
| G11 | No blended-total or `$0`-for-null defect was found in the existing District Nexus code — that surface was already careful. The risk was in the NEW surface. | (clean) |

## Known baseline test failures

Measured on this branch at the merge SHA, before implementation:

- `apps/api`: a documented pre-existing baseline of roughly 40 failures across
  ~12 suites, unrelated to this feature (DB-backed suites and integration specs
  that need a live Postgres). Recorded per-suite in
  [verification.md](./verification.md), which compares branch results against the
  **same** `main` SHA rather than against an absolute pass requirement.
- `apps/web`: baseline captured in `verification.md`.
- A fresh worktree **must** have `packages/*` built (`pnpm --filter @capiro/shared build`
  etc.) before any `apps/api` test will run — otherwise every suite fails with
  `Cannot find module '@capiro/shared'`. This is a worktree setup step, not a
  code failure.
