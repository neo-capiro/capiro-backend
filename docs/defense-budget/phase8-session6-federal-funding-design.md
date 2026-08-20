# Phase 8 Session 6 — Federal Funding Event Boundary

## Status

Workstreams H/I establish a source-grounded Federal Funding Event domain and an initial real-source ingestion corpus. This session does **not** change production routes, schedules, canonical snapshots, Program Element annual-stage semantics, or NVIDIA routing.

## Non-negotiable semantic rule

These are separate facts:

```text
Congress enacted broad purpose
!= OMB allotment
!= DoD/service allocation
!= Capiro inferred relevance
!= obligation
!= outlay
```

A source may prove an exact amount at one level without proving that amount at a more specific target level.

## Storage model

Session 6 adds three global public-domain tables:

- `federal_funding_measure` — the legislative/administrative vehicle.
- `federal_funding_provision` — a source-backed section/account/purpose and the amount literally stated by the source.
- `federal_funding_allocation` — a mapping from a provision to a native target at a stated maturity/stage.

The tables are intentionally separate from `program_element_year`. Supplemental, reconciliation, continuing resolutions, rescissions, transfers and reprogramming are not annual PE stages.

### Dollar safety

`stated_amount_usd` on a provision means only “the source states this amount for this provision/account/purpose.”

`authoritative_amount_usd` on an allocation is stronger. PostgreSQL accepts it only when all of the following are true:

- mapping maturity is `exact_identifier`, `exact_line_item`, or `account_level`;
- target type is not `capability`;
- the relationship is not inferred;
- review state is `verified`;
- native target identity exists;
- source evidence is bound.

Consequently, a capability relevance candidate can be useful for government-affairs opportunity detection without fabricating exact program dollars.

## Authority boundary

- `capiro_defense_serve`: `SELECT` only.
- `capiro_defense_job`: `SELECT`, `INSERT`, `UPDATE`; no `DELETE`.
- public role: revoked.
- canonical promotion remains separate.

The Session 6 ingestion command is a non-HTTP job command. It defaults to dry-run and requires `PHASE8_SESSION6_COMMIT_AUTHORIZED=true` plus `--commit` before any mutation.

The job also refuses to write funding facts until the official source bytes have been materialized, SHA-256 hashed, and registered as one live `source_document` row for the exact `(sourceKey, sha256)`.

## Why the new tables are migration-owned in Session 6

Session 6 is the foundation + ingestion workstream. The tables are not added to the curated HTTP Prisma delegate set yet because no new public Federal Funding Event route is being cut over in this session. Reads remain a later dark-service/product integration concern. This avoids widening the HTTP data surface merely to support a job-owned ingestion foundation.

The authoritative migration ledger owns the database objects now. Any later typed read delegate must preserve the same constraints and role boundary; it must not replace the database checks with application-only validation.

## Initial real-source corpus

The committed source-selection corpus contains:

1. P.L. 119-21, Title II (Committee on Armed Services) — 2025 reconciliation defense funding.
2. P.L. 118-50, Division A — Israel Security Supplemental Appropriations Act, 2024.
3. P.L. 118-50, Division B — Ukraine Security Supplemental Appropriations Act, 2024.
4. P.L. 118-50, Division C — Indo-Pacific Security Supplemental Appropriations Act, 2024.

Reconciliation examples remain capability/purpose candidates with `authoritativeAmountUsd=null` even when the statute states a provision amount. The three supplemental examples use exact statutory appropriation-account headings, so the statutory amount may be represented at `account_level`; they still do not imply a PE allocation.

## Governed ingestion flow

```text
official HTTPS source
-> download bytes
-> SHA-256
-> immutable local/operator artifact
-> existing source_document registry
-> prepared measure/provision/allocation identities
-> dry-run validation
-> explicit job mutation authorization
-> one transaction
-> DB constraints
```

The source materializer allows only GovInfo and Congress.gov HTTPS origins and fails if a pinned SHA changes.

## Session 6 gates

- `node scripts/verify-phase8-session6.mjs --enforce-corpus`
- `pnpm --filter @capiro/defense-domain build`
- `node scripts/test-phase8-session6-federal-funding-domain.mjs`
- `node scripts/verify-phase8-session6-db.mjs`

The DB rehearsal applies the entire migration ledger to disposable PostgreSQL and proves negative controls against real constraints.

## Out of scope for this session

- public `/api/federal-funding/*` cutover;
- Total Funding Position UI;
- client relevance fan-out;
- recurring source watcher ownership;
- production schedule changes;
- production data mutation without a separately authorized ingest run;
- NVIDIA changes.
