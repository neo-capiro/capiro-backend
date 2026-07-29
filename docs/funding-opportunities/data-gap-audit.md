# Funding Opportunities — data-gap audit

What Capiro actually holds, per field, with the file that proves it. The point of
this document is that the product never claims a fact the source did not state.

Legend:

- **Ingested** — stored in a column, populated by a live job.
- **Available, not ingested** — the source returns it and we drop it.
- **Detail only** — absent from the search payload; only the detail/attachment
  fetch carries it.
- **Not provided** — the source does not publish it. Not a TODO.
- **Unknown** — not verified either way; treated as absent.

---

## 1. Grants.gov

Two writers, and the split matters: `sync-grants.ts` may only write the ten fields
`search2` returns (verified live 2026-07-24, recorded in its own header), and
`enrich-grant-details.ts` owns everything from the `fetchOpportunity` detail
payload. The split exists because `sync-grants.ts` used to list the detail columns
in its upsert, where they resolved to `null` every run — harmless only while
nothing else wrote them.

| Fact | Status | Column | Evidence |
| --- | --- | --- | --- |
| Opportunity number | Ingested | `opportunity_number` | `sync-grants.ts` `buildOpportunityFields` |
| Title | Ingested | `title` | same |
| Agency | Ingested | `agency` (name, falling back to code) | same |
| Sub-agency | **Available, not ingested** | `sub_agency` exists, **nothing writes it** | grep: no writer in either script |
| Assistance Listing / CFDA | Ingested | `cfda_numbers[]` | `search2` `cfdaList` |
| Status | Ingested | `status` (`posted`/`forecasted`/`closed`/`archived`) | `oppStatus` |
| Posted / open date | Ingested | `open_date` | `search2` `openDate` |
| Close date | Ingested | `close_date` | `search2` `closeDate` |
| Close-date semantics ("continuous", "TBD", ET cutoffs) | Ingested | `response_date_desc` | `enrich-grant-details.ts`; deliberately **never parsed into `close_date`** |
| Estimated funding | Ingested (detail) | `estimated_funding` | `enrich-grant-details.ts` |
| Award floor | Ingested (detail) | `award_floor` | same |
| Award ceiling | Ingested (detail) | `award_ceiling` | same |
| Expected award count | Ingested (detail) | `expected_awards` | `numberOfAwards` |
| Eligible applicant types | Ingested (detail) | `eligibility[]` — **LABEL strings**, not numeric codes | `applicantTypes[].description`; 17 distinct labels across 816 of 866 rows, verified live 2026-07-28 |
| Eligibility narrative | Ingested (detail) | `eligibility_text` | `applicantEligibilityDesc` |
| Funding instrument | Ingested (detail) | `funding_instrument` | `fundingInstruments[].description`, joined |
| Category | Ingested (detail) | `category` | `opportunityCategory.description` |
| Cost sharing | Ingested (detail) | `cost_sharing` | `costSharing` boolean |
| Description | Ingested (detail) | `description` | `synopsisDesc` ?? `forecastDesc` |
| Source URL | Ingested (constructed) | `url` | built from the opportunity id in `sync-grants.ts` |
| Source update timestamp | Ingested (detail) | `last_updated_at`, `detail_synced_at` | `lastUpdatedDate` |
| Amendment count | Ingested (detail) | `amendment_count` | `opportunityHistoryDetails.length` |
| Doc type (`synopsis` / `forecast`) | Ingested | `doc_type` | the two payload shapes are **not** interchangeable |
| **Geographic restrictions** | **Not provided** | — | Neither `search2` nor the detail payload carries a geography field. `scoreRow` passes `geographicRestrictions: []` and says so in a comment. Inferring one would fabricate an ineligibility. |
| Attachments | **Detail only, not ingested** | — | attachment metadata is reachable via a separate fetch; nothing stores it |

### Consequences carried into the product

- The grant eligibility engine can return `eligible` only because
  `Client.applicantTypes` exists (added 2026-07-28). Before that column it could
  only ever say `needs_review` or `unknown` — the honest ceiling of what was held.
- No grant opportunity ever receives a `districtKey` from its own data. The only
  path is an explicit, reviewed project-site link.

---

## 2. SAM.gov

`sync-sam-opportunities.ts` reads `opportunities/v2/search` and stores the **whole
source record** in `raw_jsonb`. That is why the four newly-promoted columns are a
backfill, not a re-ingestion.

| Fact | Status | Column | Evidence |
| --- | --- | --- | --- |
| Notice ID | Ingested | `notice_id` (unique) | idempotency key |
| Solicitation number | Ingested | `solicitation_number` | — |
| Notice type | Ingested | `notice_type` | `type` ?? `baseType`, clipped to 32 |
| **Base type** | **Promoted by this PR** | `base_type` | `raw.baseType`. Was dropped. An amended notice carries `type: 'Solicitation'` with `baseType: 'Presolicitation'` — without this, a sources-sought notice reads as an open solicitation. |
| Title | Ingested | `title` | — |
| Agency | Ingested (derived) | `agency` | `department` ?? `subTier` ?? 2nd org-path segment. DoD records almost always have null `department`/`subTier`, so the org path is what is populated. |
| **Sub-agency** | **Promoted by this PR** | `sub_agency` | `raw.subTier`. Frequently null on DoD records — a null here means "the notice did not say", not "no subagency". |
| Contracting office | Ingested (derived) | `office` | `office` ?? deepest org-path segment |
| Posted date | Ingested | `posted_date` | — |
| Response deadline | Ingested | `response_deadline` | `responseDeadLine` |
| Archive date | Ingested | `archive_date` | — |
| Active state | Ingested (derived) | `active` | SAM's own `active` flag when present, else derived from `archive_date`. **SAM archives some time AFTER the response date**, so `active: true` with a past deadline is normal — the read path treats a passed deadline as not-active for exactly this reason. |
| NAICS | Ingested | `naics_code` | one code per notice, clipped to 8 |
| PSC | Ingested | `psc_code` | `classificationCode`, clipped to 8 |
| **Set-aside (description)** | **Promoted by this PR** | `set_aside` | `raw.typeOfSetAsideDescription` |
| **Set-aside (code)** | **Promoted by this PR** | `set_aside_code` | `raw.typeOfSetAside` |
| Place of performance | Ingested | `place_of_performance_jsonb` | vendor-shaped JSON; the reader never assumes the shape |
| Description | Ingested, **ambiguous by source** | `description` | SAM returns **either inline prose or a URL to its description endpoint** in this one field. Surfaced as `summaryIsLink` rather than rendered as a synopsis that looks like corrupt data. |
| Point of contact | Ingested (primary only) | `poc_name`, `poc_email` | first `primary`-typed POC, else the first |
| Source URL | Ingested | `source_url` | `uiLink`, with a constructed fallback |
| **Estimated value** | **Not provided** | — | The search payload carries **no estimated value** for a sources-sought, presolicitation, solicitation or combined-synopsis notice. The only dollar figure it ever carries is `award.amount` on an **award notice** — money already obligated to somebody else. `ContractValue.estimatedValue` is therefore always `null` with `basis: 'not_stated_by_source'`, and the UI renders `Not stated`. |
| Contract vehicle | **Not provided** | — | not a field on the search payload |
| Incumbent | **Not provided** | — | not published. Historical award data may be shown separately, labelled historical; it is never presented as this notice's incumbent. |
| Attachments | **Available, not ingested** | — | `resourceLinks` is present in `raw_jsonb`; no column, no UI |
| **Amendment lineage** | **Not provided (as a link)** | — | The payload carries no parent-notice pointer. `solicitation_number` groups a notice family and `base_type` records the prior stage, which together are the closest honest answer. A synthesised parent link would be invented. |

### What must NOT be inferred

- SAM.gov **does not** state a value for a pursuable notice. Anything that showed
  a dollar figure there would be either an award to a competitor or a fabrication.
- SAM's place of performance is where the WORK happens — often a government
  installation with no relationship to the client. It is never, on its own, a
  district attribution for the client.

---

## 3. Client identity and qualification

| Fact | Status | Column | Notes |
| --- | --- | --- | --- |
| UEI | Ingested | `clients.uei` | populated manually or by SAM Entity-Management enrichment (`sam-entity.service.ts`) |
| CAGE | Ingested | `clients.cage_code` | same. **The client half exists; see the gap below.** |
| Legal name | Partial | `clients.name` | the CRM DISPLAY name, which is not necessarily the registered legal name |
| Aliases | **Not stored** | — | no alias table. Reachable only as a reviewed `ClientIntelMapping` with `relationship_type = 'alias'` (added by this PR). |
| Former names | **Not stored** as such | — | same: `relationship_type = 'former_name'` |
| Parent organisation | **Not stored** as such | — | same: `relationship_type = 'parent'` |
| Subsidiaries | **Not stored** as such | — | same: `relationship_type = 'subsidiary'` |
| Domains | Partial | `clients.website` | one URL; `domainOf` extracts a domain for use as a **corroborator only** |
| Addresses | Via facilities | `client_facilities` | address line/city/state/zip + geocode |
| NAICS | Ingested | `clients.naics_codes[]` | — |
| PSC | Ingested | `clients.psc_codes[]` | — |
| **Set-aside certifications** | **NOT STORED** | — | **The single most consequential gap in this audit.** See below. |
| Applicant types | Ingested | `clients.applicant_types[]` | Grants.gov LABELS |
| Capabilities | Ingested | `client_capabilities` | `name`, `keywords[]`, `tags`, `peNumbers[]` |
| Facility states | Ingested | `client_facilities.state` | — |
| Agency history | Derived | — | from CONFIRMED `contracting` / `assistance_recipient` mappings joined to `federal_award` / `federal_assistance_award` |
| Contract history | Derived | — | same |
| Grant history | Derived | — | same |
| Program Element relationships | Ingested | `client_capabilities.pe_numbers[]` | client-stated |

### Gap 3a — the identity gap, stated plainly

A federal award or SAM record may name a **subsidiary, a legal entity, a
historical name, a parent, or an operating unit** that is not the CRM client's
display name. Two symmetric failures follow, and name similarity cannot
distinguish them:

- **False negative:** `RTX CORPORATION` and `RAYTHEON TECHNOLOGIES CORPORATION`
  are one registered entity and share **no** distinctive token. Only the UEI
  reaches it — which is why contractor search now accepts a UEI and the matcher
  queries by it directly.
- **False positive:** `Santa Rosa County` and `Santa Clara County` are different
  entities and share **two** non-generic tokens. This is not hypothetical: 173 of
  183 live `assistance_recipient` candidates were wrong this way (2026-07-27),
  several with $B+ obligated attached.

The answer is not a better string metric. It is that a name never CONFIRMS an
identity — only an exact unique identifier does — and that a confirmed mapping now
records `relationship_type` and `roll_up_awards`, so "whose money is this" has an
explicit, reviewed answer instead of being assumed.

### Gap 3b — no contractor-side CAGE

`federal_contractor` carries `uei` and `recipientId` and **no CAGE code**: its
source (the USAspending/openspending top-contractor dataset, via
`sync-openspending.ts`) does not publish one. So:

- `Client.cageCode` is populated but has nothing to compare against;
- the `exact_cage` basis is declared in the vocabulary and is **not reachable**
  from this catalog today;
- searching the contractor catalog by a CAGE returns an explicit
  `unsupportedIdentifier` message rather than zero rows — an empty result would
  read as "this CAGE is not a federal contractor", which the data cannot support.

**Closing it** requires a CAGE-bearing source: SAM Entity-Management (already used
for client enrichment, and it returns CAGE) would need a stored entity table to
match against, or `federal_contractor` would need a CAGE column fed by a source
that publishes one.

### Gap 3c — no set-aside certifications, and what that costs

This is why `computeSamEligibility` **never returns `eligible` or `ineligible`**.
Contract eligibility turns on:

1. a **certification** for every socioeconomic set-aside — 8(a), SDVOSB, WOSB,
   HUBZone — which Capiro stores nowhere. An absent certification record is *not*
   evidence the client lacks one, so `ineligible` would be a guess in the
   dangerous direction;
2. the **SBA size standard for the notice's own NAICS** for a small-business
   set-aside. `Client.applicantTypes` containing "Small businesses" is a
   self-report, not a determination;
3. a contracting officer's **responsibility determination** for full-and-open,
   which is not published as data at all.

So SAM eligibility is `needs_review` (a set-aside is stated) or `unknown` (none is
stated), always with a reason naming the specific missing input. Grant eligibility
sat in exactly this position until `Client.applicantTypes` was added — the fix here
is the same shape: a `clients.set_aside_certifications[]` column fed from SAM
Entity-Management, at which point `computeSamEligibility` can return `eligible`
for a matching certified set-aside without any change to its callers.

A second, smaller consequence: a **null `set_aside` is ambiguous**. It means either
"full and open" or "we never captured it" (for rows ingested before the promotion,
whose `raw_jsonb` may predate the field). That ambiguity is precisely why the
engine refuses to read a null set-aside as "unrestricted", and why
`backfill-sam-opportunity-fields.ts` reports its `noSourceFields` count rather
than quietly leaving those rows looking unrestricted.

---

## 4. Deferred external sources

Not in this release. Listed so the gaps are explicit rather than discovered later:

| Source | Why deferred |
| --- | --- |
| State procurement portals | ~50 distinct systems, no common API, no shared identifier space |
| Local / municipal procurement | Thousands of systems; no federal identifier to join on |
| Agency-specific systems not covered by SAM | e.g. DOE lab solicitations, some FAA/NASA vehicles |
| OTA consortium portals | Membership-gated; postings are not public and often not scrapable within ToS |
| Prime-contractor subcontract portals | Per-prime auth; no public feed |
| SBA SUBNet | Separate system and identifier space |
| Classified opportunities | Not published, and out of scope for this platform |
| Partner-provided opportunities | No ingestion contract exists yet; would need a durable submission path |

None of these blocks v1. What matters is that the UI never implies coverage it does
not have: the freshness strip names exactly two rails, Grants.gov and SAM.gov, with
their record counts, and an empty result says which rail is empty and why.

---

## 5. Summary of what this PR changed about the data

| Change | Kind |
| --- | --- |
| `sam_opportunity.base_type`, `.sub_agency`, `.set_aside`, `.set_aside_code` | Promoted from `raw_jsonb`; live sync writes them going forward via one shared extractor |
| `client_intel_mapping.match_basis`, `.match_tier`, `.match_evidence_jsonb`, `.relationship_type`, `.roll_up_awards` | New, all nullable, **no backfill** — a pre-existing row's basis was never recorded and reads as `legacy_unrecorded` |
| `client_funding_opportunity` | New tenant-scoped workflow table |
| Contractor search by UEI | New; the identifier path was previously unreachable |

Nothing in this PR invents a value the source did not state, and nothing back-fills
a judgement nobody made.
