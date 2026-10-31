# SAM action contract v2

This change corrects source attribution and defines the consumer interface. It does not qualify a population, apply SQL, change a scheduled job, or establish a financial result. DB owns the separately reviewed forward migration and qualified population; Release owns the existing image pipeline. The service change requires the v2 relations before activation. Migration 315 and its 14 views remain untouched.

## Source authority and supported records

Sources checked on 2026-10-31:

- [GSA SAM Contract Awards API](https://open.gsa.gov/api/contract-awards/) defines `contractId` agency/PIID/modification/transaction and referenced-IDV fields, `actionObligation`, `dateSigned`, and `transactionData.lastModifiedDate`. Its examples include numeric/string zero and timezone-free date/time strings.
- [USAspending official release log](https://github.com/fedspendingtransparency/usaspending-website/wiki), contract transaction-key and unique-award-key sections: the contract action key uses submitting agency, parent agency, PIID, modification, parent PIID and transaction number. The award key uses `CONT_AWD`, PIID, submitting agency, parent PIID and parent agency, with `-NONE-` for missing components. The submitting agency is not interchangeable with an awarding/funding agency label.
- [FPDS glossary](https://www.fpds.gov/help/Glossary.htm), Modification Number and Transaction Number: modification identifies a modification; transaction number distinguishes separately reported transactions sharing the other key fields.

The implementation supports SAM `AWARD` types A/B/C/D. IDVs and other-transaction awards need their own contract and are counted as unsupported. It requires modification and transaction number, including explicit `0`; it never guesses zero when a field is absent. A/C requires both parent dimensions. B/D may have neither parent dimension, resolving against a direct award. A half-parent, placeholder parent, malformed scalar or contradictory parent fails closed. `oldContractId` changes require a source crosswalk and are rejected; no automatic cross-key correction is inferred.

Supported composite award components are uppercase ASCII letters, digits and hyphens; agency is four alphanumeric characters. Numeric and one-character PIIDs remain valid. Underscores, source sentinels and unsupported characters fail closed rather than being ambiguously split. This is a deliberate supported subset, not a claim that all source identifiers use this alphabet. Exact component matching is case-sensitive after outer whitespace trim. The original payload preserves original spelling and types.

Candidate retrieval may use PIID, but resolution parses the entire canonical award ID, compares all four dimensions and verifies the existing ledger key using `buildAcquisitionIdentity`. Exactly one distinct `(award_unique_id, identity_key)` must remain. Repeated revisions with the same pair do not create multiple awards. Zero, multiple, inconsistent and malformed mappings have separate outcomes. Never pick the first PIID row. Catalog attributes and submitting agency are separate concepts.

Stable source action ID is JSON serialization of `["sam-contract-action/v2", resolvedAwardIdentityKey, modificationNumber, transactionNumber]`. The resolved key already binds all award dimensions. JSON preserves component boundaries before the existing store percent-encodes its outer identity. No amount, date, hash, observation time, run ID or source-version value enters action identity. The shared encoder, store, historical keys, hashes and append-only rows are unchanged. A changed amount/date for the same action appends an observation under the same key. A different transaction number remains distinct even if all financial values match. A distinct negative action is a separate deobligation/reversal; it does not replace another action merely because its amount is negative.

## Provenance and qualification

Existing `raw_jsonb` stores `{sourcePayload, acquisitionProvenance}` for new rows. `sourcePayload` is the original record, including original source IDs. Provenance has these exact fields:

| Field | Type / normalization |
| --- | --- |
| contract | exact text `sam-contract-action/v2` |
| producerCommit | lowercase 40-hex Git SHA |
| imageDigest | `sha256:` plus lowercase 64-hex digest |
| runId, targetId | case-sensitive ASCII `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; no implicit trim |
| awardUniqueId | validated exact source composite |
| sourceRevisionOrder | 26-character source wall-clock `YYYY-MM-DDTHH:mm:ss.ffffff` |
| sourcePayloadHash | lowercase SHA256 of recursively key-sorted JSON; arrays retain order |

These fields are claims, not authorization. Prefix, raw marker, image tag or a timestamp cutoff alone never qualifies a row. CLI requires explicit release/run/target values before any source call or database connection. Operational owners must independently bind the immutable commit/image, actual target, invocation and source scope. The adapter does not create its own approval record.

DB's proposed new table is `defproc_producer_qualification_v2`: `contract_id text`, `producer_commit char(40)`, `image_digest text`, `run_id text`, `target_id text`, `approved_at timestamptz`, `revoked_at timestamptz NULL`, `award_identity_keys text[]`, `evidence_sha256 char(64)`, `scope_description text`. The five text identity fields form its primary key, all columns except revoked_at are NOT NULL, and award scope must be nonempty, distinct, validated full keys. The evidence hash binds the independently retained run receipt and bounded source scope, not the raw marker. No data is inserted by migration. Unknown/mismatched target, release, run, contract, award scope or duplicate approval cannot qualify. Approvals become visible at approved_at. Revocation disqualifies the run even in retrospective queries; knownAt cannot resurrect revoked evidence.

Only the existing DB migration/administration owner may add or revoke qualification rows after independent source/release evidence acceptance. Neither `capiro_app`, `capiro_defense_job`, `capiro_defense_job_login`, `capiro_defense_serve` nor PUBLIC may insert/update/delete this table. DB must capture the real owner/default privileges and express this exact restriction in its reviewed migration, rather than assume new objects escape broad defaults. The producer gets no qualification-table write path. A target binding is a DB-owned constant/configuration in the view, not a producer-supplied current-target parameter. Review any new view SELECT privileges separately; do not expand base-ledger grants. No role/grant mutation is part of this source patch.

Qualification is scoped observed data, never a declaration of complete federal history. Receipt must retain requested window/PIIDs, actual target, request/page counts, failures/truncation, mapping outcomes, source comparison and identity-change/deletion coverage. Do not approve an aborted/partial run as a complete snapshot. The old `--skip-covered` row-count heuristic now fails before effects: revisions, re-observations and omitted/unresolved source records make physical row counts unusable as page checkpoints. An authorized retry re-fetches source pages with a new run ID; do not replay completed DB work. Source quotas and bounded slices remain an operational planning constraint. Old scheduled commands are not migrated or resumed by this patch.

## Revision selection and measures

`sam-action-projection.ts` is the offline executable specification for DB translation, not a SQL implementation. Current selection means latest observed source modification clock within the independently qualified cohort. `knownAt` limits recorded knowledge and approval visibility; optional `sourceThrough` limits the source clock. Neither parameter changes the source payload or recorded observation history.

The API documents lastModifiedDate but does not promise a globally monotone integer version. Therefore version is retained in raw payload, never numerically ordered. The supported timezone-free lastModifiedDate is validated and normalized without inventing UTC. Compare that source wall-clock only within this feed/action. Missing, zoned, malformed or unsupported timestamps are rejected, not sorted by ingestion time. This rule yields latest observed source revision, not proof the source has no later revision or deletion. DST/timezone ambiguity and source resets are population-qualification concerns; if clocks cannot establish ordering, hold that scope pending authoritative source evidence.

For each full action key, choose the maximum supported source clock among eligible observations. Equal-clock identical canonical payloads are repeated observations; choose earliest recorded_at then lexical physical ID only as a deterministic representative. Equal-clock differing payloads are a source fork: exclude the entire action at that query boundary. No hash or physical revision counter decides which conflicting payload is true. A later unique source clock may resolve an earlier fork. Older source data arriving later remains a prior source revision even if the store's append chain points to it. Store `revision`/`supersedes_id` describe observation history; they are not source revision authority. Any cross-award/action predecessor, missing predecessor or non-earlier predecessor is invalid. `corrects_identity_key` is unsupported for this adapter and must be NULL.

Amounts are USD decimal(20,2) action obligations, parsed without floating arithmetic or silent rounding. Strings support the whole schema range; unsafe numeric inputs and extra precision are rejected. SAM supplies no action outlay in this contract: outlay is NULL, never zero and never award total outlay. Unknown/null action dates remain undated actions; invalid non-null dates are rejected. Base/options ceilings and account totals are never added to action obligations.

Disjoint physical-row categories are selected, prior_source_revision, repeated_observation, source_revision_fork, legacy, unqualified_run, invalid_provenance, no_award_match, multiple_award_matches, invalid_chain and source_after_cutoff. `repeated_observation` is used only for identical payload at the selected clock, not all raw-minus-selected amounts. Other older observations belong to prior_source_revision even if some happen to repeat a prior payload. Rows after knownAt are outside the query population.

For each measure separately, `raw signed sum = sum of all disjoint category signed sums`; counts and known-value counts conserve too. There is no logical<=raw inequality. Null-only/empty sums are NULL; report known-value count alongside sums. Numeric totals use unbounded PostgreSQL numeric for aggregation, not numeric(20,2) casts that can overflow a portfolio. Negative amounts remain negative. Family/flow/vendor totals may only compare the same selected cohort; undated and unmatched/ambiguous attribute rows need explicit buckets, never an inner-join disappearance.

## DB relation interface (new objects only)

All projections below fix order/types. NN means every emitted row has a value; PostgreSQL view catalog nullability alone is not a proof. Implement `defproc_action_asof_v2(known_at timestamptz, source_through text DEFAULT NULL)` with this selected-action projection, and `v_defproc_action_v2` as its current equivalent at statement time. No raw source payload is exposed. SQL must validate the JSON-array source ID by parsing its components, not compare PostgreSQL jsonb text formatting with JSON.stringify. Outer transaction identity uses encodeURIComponent over the exact stored sourceTransactionId (UTF-8 percent encoding; preserve the JavaScript unescaped alphabet). Canonical payload equality for ties may use jsonb equality; a payload hash is never a winning revision. Any hash recomputation must reproduce the writer serializer, not hash PostgreSQL jsonb::text. Fixtures must prove the translation, including delimiter/Unicode inputs.

| # | Column | PostgreSQL type | Null / meaning |
| --- | --- | --- | --- |
| 1 | transaction_identity_key | text | NN stable full action |
| 2 | award_identity_key | text | NN canonical full award |
| 3 | award_unique_id | text | NN source award ID |
| 4 | selected_revision_id | uuid | NN physical representative |
| 5 | parent_award_identity_key | text | NULL; no guessed IDV ledger key |
| 6 | source_system | text | NN sam_gov |
| 7 | source_transaction_id | text | NN derived composite, original components retained in sourcePayload |
| 8 | piid | text | NN attribute, never join authority |
| 9 | modification_number | text | NN |
| 10 | transaction_number | text | NN |
| 11 | action_date | date | nullable source date |
| 12 | obligation_usd | numeric(20,2) | NN |
| 13 | outlay_usd | numeric(20,2) | NULL unsupported |
| 14 | source_revision_order | text | NN source clock, not timestamptz |
| 15 | source_observed_at | timestamptz | NN |
| 16 | recorded_at | timestamptz | NN |
| 17 | corrects_identity_key | text | NULL |
| 18 | supersedes_id | uuid | nullable observation predecessor |
| 19 | source_url | text | nullable credential-free URL |
| 20 | contract_id | text | NN |
| 21 | producer_commit | text | NN |
| 22 | image_digest | text | NN |
| 23 | run_id | text | NN |
| 24 | target_id | text | NN |
| 25 | source_payload_hash | text | NN integrity evidence only |
| 26 | qualification_state | text | NN `qualified_observed_actions` |

Diagnostics relation/function: same knowledge/source cutoffs, one row per physical revision, columns `revision_id uuid NN`, `transaction_identity_key text NN`, `award_identity_key text NN`, `parent_award_identity_key text NULL`, `category text NN`, `obligation_usd numeric(20,2) NULL`, `outlay_usd numeric(20,2) NULL`, `source_revision_order text NULL`, `award_unique_id text NULL`. Legacy amounts are diagnostic, never v2 selected amounts. Diagnostic access is limited to existing authorized DB/operators; serving receives aggregate coverage only.

`v_defproc_action_coverage_v2` groups diagnostics by full assigned award key and parent key: ordered columns `award_identity_key text NN`, `parent_award_identity_key text NULL`, `selected_actions bigint NN`, `legacy_rows bigint NN`, `unresolved_rows bigint NN`, `prior_revision_rows bigint NN`, `repeated_observation_rows bigint NN`, `source_after_cutoff_rows bigint NN`. Unresolved includes unqualified/invalid/missing/multiple/fork/invalid-chain categories; a legacy assigned key is only an existing attribution, not proof of correctness. A missing coverage row means no established source coverage. Return zero count only within an existing group, not a fabricated source population.

`v_defproc_award_v2` and its as-of equivalent use `acquisition_record_revision` award observations, never DISTINCT ON(piid). Ordered columns: `award_identity_key text NN`, `award_unique_id text NN`, `award_revision_id uuid NN`, `piid text NN`, `awarding_agency text NULL`, `awarding_sub_tier text NULL`, `contractor_name text NULL`, `recipient_uei text NULL`, `attribute_recorded_at timestamptz NN`, `attribute_semantics text NN` fixed `latest_known_catalog_observation`. Validate source_system/record_kind, encoded identity, raw generated_internal_id/source_record_id agreement and raw Award ID/parsed PIID. Unsupported old raw shapes are excluded as invalid_award_provenance, not silently attributed. Choose latest recorded_at <= knownAt; equal-time contradictory source snapshots exclude the award as award_observation_fork; identical ties choose lexical ID. This is knowledge-time catalog attribution, not event-time ownership reconstruction. Null attributes remain null. `selectAwardObservations` supplies fixtures for this rule.

Versioned family/flow consumers must join selected actions to this full award identity with exactly one match; separate zero/multiple/attribute-fork buckets. Retain undated actions as fiscal_year NULL. V2 family grain is one canonical award; flow grain is fiscal-year plus the explicitly selected catalog attributes. Count selected actions with bigint, sum obligations/outlays with numeric, and track known/null counts. Vendor grouping may inherit selected amounts but contractor-name bridges still do not prove legal entity identity. Never union v1 and v2 money. Existing enrichment PRIMARY KEY(piid) remains unresolved; neither views nor this producer fixes it.

## Ordinary consumers, rollout and inverse

Inventory at backend 4d8398cddd086531a6715e832515001071cd2973:

- `DefenseResearchService.getAcquisitionActions`: direct Prisma read used physical revision ordering. This patch excludes all sam_gov from that legacy read and obtains SAM actions from v2. Existing other-source behavior and API/auth route are preserved. Qualified SAM response raw contains only bounded qualification references and coverage counts, marked partial/qualified_observed_actions; provider payload is not returned. Empty/unresolved canonical SAM award history produces an explicit unavailable response, not a fabricated empty complete history. No feature completion follows from a nonempty list.
- Shared `projectPortfolioAcquisition`: only qualifier/tests invoke it in tracked main. Do not feed corrected physical rows to it; future callers must pass the selected v2 actions, one per identity. Shared generic behavior is unchanged.
- `sync-program-acquisition-continuity` writes catalog observations and relationship gaps, not financial action totals. Original source/raw fallback differs by cohort; unsupported attribute snapshots stay excluded in v2.
- Tracked ordinary source in main and original capirov2 2c1fc7a8 contains no direct v_defproc or enrichment reader. Applied315 SQL has the 14-view dependency chain retained by DB. This does not prove absence of external dashboards/ad-hoc queries; DB dependency/catalog capture and Release route inventory remain necessary before retiring any v1 consumer. This patch retires none.

DB prepares exact forward SQL and tests preserving all14 old definitions/columns/owners/ACLs/options. New dependency order: qualification table and target binding; internal normalization/classification and as-of functions; award/action/coverage v2; v2 family/flow/reconciliation and explicitly reviewed vendor consumers. Existing application role gets only the reviewed view reads required by the new reader; no raw payload or base-ledger access is inferred. No new roles, grant broadening, CASCADE, blind DROP or replay315.

Deploy migration first, verify structural/type/privilege contracts, then coherent source image, then explicitly allocated corrected producer population. Approve exact cohort only after independent run/source evidence; perform serving action/source and Money Flow comparisons, graph/buyer/funding and federal import/draft/review/export including XML/USLM acceptance. Old cron remains a separate operational risk, never a corrected-cohort member merely because it runs later. Meri retains priority for the contended builder.

Inverse is dependency-aware: restore the previous application artifact before removing v2 reader dependencies; revoke qualified cohorts if evidence is wrong; retain immutable ledger history and original315. DB must capture actual dependents and drop only newly created objects in reverse dependency order if a separately reviewed inverse is needed. A new unknown dependent means stop the inverse and forward-repair; never CASCADE. No inverse execution is authorized here.
