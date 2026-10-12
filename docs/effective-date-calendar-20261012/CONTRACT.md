# Effective-date calendar source contract

This source adds a bounded calendar view to the existing `FederalRegisterService`
and enriches the existing Federal Register sync owner. Base main is
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. No replacement calendar, ingestion,
receipt, source-document service, or data store is introduced.

## Read contract and authority

`GET /api/federal-register/effective-date-calendar` requires the existing
authenticated tenant context and `standard_user` role floor. This is global public
reference data, with no tenant/client/caller aggregate or customer resource writes.
Queries require `dateFrom` and `dateTo` as exact valid `YYYY-MM-DD` values, an
range whose date endpoints are separated by at most 366 days, page 1–10000 and limit 1–100 (default 50).
The existing upcoming-deadlines route retains its comment-end meaning.

A calendar record is a current local RULE with a strictly validated publisher
`effective_on` date. The projection labels `dateKind: effective`, returns the
calendar date without a timezone conversion, and carries the exact document
number, publication identity, publisher API URL, canonical matching official
GovInfo PDF reference, source field, projection SHA-256 hash, revision,
observation time and latest prior correction. It never substitutes publication,
comment-end, ingestion, or inferred dates.

The authority is explicitly `federal_register_publisher_metadata`.
The publisher's API is the source of the structured date; the official PDF is a
validated edition reference, not a claim that PDF bytes/full Dates text were
retrieved or legally interpreted. FederalRegister.gov itself distinguishes its
informational XML/API renditions from the official edition:
[API documentation/legal status](https://www.federalregister.gov/developers/documentation/api/v1).
The current publisher source exposes `effective_on` from its effective-date event
and the explicit `correction_of`/`corrections` document relationships:
[Entry](https://github.com/usnationalarchives/federalregister-api-core/blob/e9c64236b385c04c7383eef167e6c29d03cfe467/app/models/entry.rb),
[serializer](https://github.com/usnationalarchives/federalregister-api-core/blob/e9c64236b385c04c7383eef167e6c29d03cfe467/app/serializers/entry_serializer.rb).
No paid model, date extraction heuristic, customer upload or provider send is used.

## Explicit exclusions, freshness, and coverage

Legacy `effective_date` values without the new receipt remain unqualified until
the existing source owner observes the exact publisher snapshot. Missing or
malformed dates, non-RULE kinds, missing/mismatched official PDF identities and
incomplete correction metadata are excluded. The reader verifies the exact hash,
current receipt/column observation identity, UTC-midnight compatibility storage,
canonical date-only/ISO timestamps, and bounded provenance shape. Extra JSON keys
are not returned. Future or more-than-48-hour-old observations are excluded.

Separately issued correction documents, or a rule with publisher correction
links, are explicitly `correction_requires_review` and excluded. This source does
not infer which Dates clause a correction changes, silently replace the original
rule's date, or claim all legal effective/compliance/applicability dates are known.
Multiple dates or textual Dates sections that lack a usable structured
`effective_on` stay outside this calendar.

Each response exposes the requested range, returned count, candidate count,
excluded-on-page count, and whether more candidates exist. Candidate totals are
pagination metadata, not a promise that every candidate has current valid
provenance. Coverage is explicitly local publisher metadata and `complete: false`:
all Federal rules, full Dates text, and resolution of separate corrections are
not claimed. It reports local RULE count, absent/unsupported receipt counts,
latest ingestion and latest historical refresh receipts, the freshness cutoff,
and that continued refresh is required. An empty page is not an assertion that
no government rule takes effect in that interval. Counts and rows use one
Repeatable Read snapshot; native MVCC acceptance remains unrun.

## Existing source-owner writes and correction lifecycle

The existing sync requests the publisher's effective_on and correction metadata.
It writes the document metadata and evidence in one transaction. A canonical
identity advisory lock handles first observation; the existing row is then
locked. Metadata document number, normalized kind, publication day and PDF value
must agree with the source snapshot. Responses are ordered by request-start
observation time: older or equal observations are stale no-ops, including metadata
writes, so a delayed response cannot undo a newer correction. This lock protocol
is source-reviewed/synthetically tested, not native PostgreSQL-qualified.

A projection hash change increments the receipt revision and records the latest
prior date/status/hash/revision/observation. Identical source retries refresh the
observation without revision churn. A missing or withdrawn effective_on clears
the compatibility date atomically instead of retaining a stale effective date.
The receipt retains only the latest prior change; it is not an immutable full
legal history. No receipt revocation, permission grant, backfill from other date
columns, HTTP date-mutation route or migration execution is introduced.

`sync-federal-register --refresh-effective-dates` is source-authored to re-read
existing local RULE identities from the canonical detail endpoint, independent of
publication watermarks. It uses an upper document-number bound and 100-record
batches; retries start a fresh traversal. Per-document failures leave the prior
observation unchanged and produce the existing `success_with_errors` SyncRun
status; thrown traversal/setup failures produce error receipts. The next refresh
can recover failed identities. Existing publication ingestion now records partial
window coverage on early page stop, count drift or missing identities; duplicates
produce partial or success_with_errors receipts and cannot yield clean success;
those runs cannot advance the successful watermark. Coverage stats use the
existing SyncRun.stats column and optional RunCounts.stats seam. Other jobs retain
their original behavior when stats is omitted.

Both sync command forms are unexecuted in this task: no provider fetch, data write,
customer mutation or database connection occurred in qualification. Deployment,
scheduling and source/data/native release preparation remain with dot.

## Source migration and remaining qualification

`20281012060000_federal_register_effective_evidence` adds nullable evidence JSON,
observation time and a RULE/effective-date index beside the existing document.
Its CHECK rejects absent receipt identity keys with explicit `IS TRUE`, avoiding
PostgreSQL CHECK-NULL acceptance. There is no legacy backfill or RLS/permission
change. Pinned official Prisma 5.22 WASM validates the source; no native engine
download, alternate host, checksum bypass, database or migration execution ran.

The exact reviewed source/tests, failed and passing commands, hashes and
path intersections are recorded in QUALIFICATION.md and INTEGRATION.md.
Native migration, constraint, lock/MVCC/concurrency and actual upstream/provider
acceptance remain a separate authorized qualification gate. This source contract
is a bounded metadata calendar, not release approval or comprehensive legal-date
coverage.
