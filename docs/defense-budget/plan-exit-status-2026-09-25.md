# Defense-budget completion-plan exit status

Date: 2026-09-25

This record updates the evidence for the completion plan without converting
implementation progress into a production-qualification claim. The release
candidate code commit is
`4547c28de1ccedd170f497421194a2d2bc0b25f3`.

Pull request `#1815` merged to GitHub and local `main` at
`2290d4c3dd3d2b9a4d5ad656ea0077f9fceddc57`. That exact revision was built by
AWS CodeBuild, migrated with 432 migrations found and none pending, and
deployed as `capiro-dev-api:462` on pinned image digest
`sha256:cbecc9043392842447e1d988e4ff55f3cab83d779c3b3b9fbfd1a819d1aef877`.
The service reached 2/2 healthy tasks and final load-balancer targets; the four
protected ingestion/publication flags remain false.

The authoritative `main` then advanced through the FY2027 HASC qualification
and business-development Phase 5 merge
(`c2bc41a86ef087e4b163c556595507ec08b396cf`), which was deployed as API task
definition `:464` in the prior evidence record. The current merged main
revision is recorded below; the feature remains fail-closed and Package 9
remains `NO_GO`/`shadow_only`.

Package 4’s manual federal-evidence outbox drain now fails closed unless
`FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED=true`; dry-run inspection remains
available. Package 3’s governed congressional packet resolver is wired through
the parser handoff and trusted runtime mirror, but still requires an approved
manifest and persisted independent proof before any congressional production
artifact can be admitted. These changes merged in PRs `#1825` and `#1826` and
were deployed from merged main
`72a9d6ac85fcbb1cc87426b3908854ac9b76e461`.

The current API rollout is task definition `:472`, with two healthy tasks on
digest `sha256:263b6dd695940cb1e042d264e2baa25b74f309bb4c73423b3185e9c7a1b42e34`
and `RELEASE_SHA=7d222c0de98013eeeac25ece4329717bc6841536`. The bounded
coordinator is task definition `:3`; both releases retain all protected
activation flags false.

A fresh bounded P5 dry-run on `capiro-dev-api-sync-jobs:34` exited 0 without
`--commit`, examined five SAM rows and five awards, and reported no writes with
all P5/P6 flags false. Both capped streams returned `hasMore=true`; the worker
does not emit row-level relationships or residual records, so this is a safety
check rather than the reviewed cohort required for Package 5/6 exit.

A read-only Package 3 source audit identified the official GovInfo HASC FY2027
report `CRPT-119hrpt698` at
`https://www.govinfo.gov/content/pkg/CRPT-119hrpt698/pdf/CRPT-119hrpt698.pdf`
with SHA-256
`6587d1cec52d8d3eda3551648f50e4bc15371ea9167da2999e263e8c8e14480a`. It is
still `NO_GO` for production admission: the exact persisted `SourceDocument`
identity, supported parser-run proof in the durable artifact store, and the
`congressional_structured_packet_v1` envelope are not yet established.

The exact GovInfo bytes were then run through the locked
`deterministic_pdfplumber` runtime for all 48 reviewed pages. The local
production-style provider and semantic-factory proof passed with 926 rows and
zero parser failures; the reproducible summary is
`docs/defense-budget/package-3/qualification/parser-proof-result-2026-09-25.json`.
This strengthens the parser/proof seam but does not change the production
decision. A separate read-only ECS database probe returned zero rows for the
pinned SHA, `CRPT-119hrpt698` source key, and GovInfo URL, confirming that no
production `SourceDocument` registration exists to bind. The proof used a
synthetic UUID and did not register a manifest or write the database.

Package 8 discovery hardening then merged as PR `#1821` at
`5314441e03abe1cfc04e5297296fb7b74703bd0d`. The defense-api image was built
by CodeBuild and pinned into the active hourly lifecycle coordinator as task
definition `capiro-dev-defense-budget-lifecycle-coordinator:2` at digest
`sha256:0f7d828276febe0f074d2d540c7f1c057d77b7385e81d4d0795ca1429b4cb569`.
A bounded AWS schedule tick exited successfully with capability proof and
`PHASE9_SCHEDULE_TICK_COMMITTED`; this is implementation evidence only and
does not create a production manifest or authorize historical replay.

## Hardened seams in this release candidate

- Package 3 now has a guarded congressional semantic-artifact factory for the
  reviewed RDT&E-only committee/public-law profile. It rejects undeclared
  units, missing stage-owned marks, empty rows, incorrect authority/family/
  exhibit/profile/source bindings, and request-valued rows that the legacy
  adapter cannot safely distinguish. The durable wrapper verifies exact stored
  bytes and rebinds the legacy output to the persisted parser proof.
- The non-RDT&E proof path now derives parser identity from the complete
  requested-page set and requires exact requested/succeeded/failed coverage.
- Package 8 can preserve a structured XML companion independently from the
  official PDF: the source record binds the official PDF digest, the parser run
  binds an optional companion digest, and structured-element evidence carries
  a deterministic element path and the same companion digest. PDF page
  evidence remains available separately. The DTIC qualification helper now
  hard-refuses FY/cycle/agency/appropriation scope drift while returning an
  explicitly non-promotable candidate envelope; it still performs no semantic
  extraction, persistence, review, or replay.
- Package 9 queue-age metrics now cover only pending/leased work and use the
  caller's logical clock. The new source-registration-to-evidence-commit
  latency summary is explicitly synthetic-only and cannot be reported as
  buyer-visible or production latency.

## Executed local gates

| Gate                                    | Result  | Evidence                                                                                                                                                                                                           |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package 1 regression set                | PASS    | 64 suites passed, 2 skipped; 915 tests passed, 26 skipped.                                                                                                                                                         |
| Parser-router regression set            | PASS    | 25 suites / 278 tests. The locked Python parser environment was restored with `uv sync --locked --offline`.                                                                                                        |
| Non-RDT&E regression set                | PASS    | 32 suites / 393 tests.                                                                                                                                                                                             |
| New focused regression set              | PASS    | 6 suites / 77 tests, including congressional guardrails, canonical proof identity/coverage, structured XML companion provenance, and Package 9 metrics.                                                            |
| API compile and production build        | PASS    | Prerequisite workspace packages built, Prisma client generation passed, full API TypeScript check passed, and the Nest production build passed.                                                                    |
| Defense API production build            | PASS    | Passed after the shared auth build and Prisma generation.                                                                                                                                                          |
| Runtime-source parity                   | PASS    | 711 source files and 711 trusted-mirror files; zero byte differences. `verify-phase8-session4.mjs` passed.                                                                                                         |
| Formatting and patch hygiene            | PASS    | Prettier check and `git diff --check` passed.                                                                                                                                                                      |
| Fresh disposable Package 9 database run | NOT_RUN | Docker Desktop could not start because its local `sailor-ingest.sock` reparse point was inaccessible. No Docker data was reset or deleted. Prior retained limited-scope evidence remains historical evidence only. |

## Package exit decisions

| Package | Current decision                                                      | Remaining exit evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–2     | Previously released evidence retained                                 | No status expansion is made by this candidate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3       | NOT_COMPLETE                                                          | Procurement, O&M, and MILCON lifecycle paths are covered. The congressional packet resolver now proves an exact offline manifest/packet/parser-proof match, but the factory remains deliberately disconnected from lifecycle admission because there is no governed structured-table input provider, persisted production SourceDocument/proof packet, mixed-family completeness evidence, or independent review. No congressional semantic production or publication is authorized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4–7     | Previously released implementation and limited qualification retained | No claim is made that the later Package 9 buyer/accuracy gates are satisfied. Unsupported financial joins remain unresolved by policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8       | NOT_COMPLETE                                                          | The XML provenance contract is ready for a qualified companion, but production still has zero active/canonical snapshots, zero governed manifests, and zero manifest-eligible rows. The FY2026 DTIC lead has a qualification-only manifest and offline artifact spike: official XML GET 200 and SHA-256 `02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a` exactly matches the pinned Handriss mirror; two PE identities and one narrative were emitted with XML locators and no PDF page claims. A later read-only check found 5/5 PE/project identity/title/FY2026-amount page-text spot matches in the official PDF (`qualification/dtic-official-xml-pdf-reconciliation-v1.json`) and a 2-entry prefix-independent expanded-QName locator inventory bound to the XML hash (`qualification/dtic-fy2026-xml-locator-inventory-2026-09-25.json`). Funding mapping remains warning-only and field-complete semantic reconciliation, completeness, human review, and expected-source registration remain incomplete. A second FY2026 DARPA lead is also NO-GO: the official XML URL returned HEAD 200 but GET 404, with no authoritative XML hash and no deterministic expected-source key. No historical replay or client notification is authorized. |
| 9       | NO_GO / shadow-only                                                   | A predeclared buyer cohort, independent adjudication, complete manifest approvals, matched cost attribution, named operational owners, and explicit activation approval are absent. Product-scale authenticated latency and deployed rollback remain unqualified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Safe next manifests

1. Package 3: admit at most one immutable official congressional source only
   after its PDF/structured companion identity, review profile, and persisted
   parser proof are governed and independently reviewable.
2. Package 8: use the Handriss catalog to discover candidate official DTIC
   publications, then bind each accepted XML companion to the independently
   archived official PDF. The DTIC FY2026 XML is the first qualification-only
   candidate with an exact official-byte match; keep the eligible manifest empty
   until semantic extraction, completeness, review, and publication gates pass.
3. Package 9: run the declared benchmark and production-scale qualification
   only after the cohort, adjudicators, price/cost boundary, owners, and
   activation authority are recorded. Until then all protected ingestion and
   publication flags remain false.

No production manifest, replay, canonical publication, paid-provider run,
historical notification, or activation is authorized by this record.

## 2026-09-25 follow-on candidate deployment

After the evidence-only merges above, the locator-inventory runtime source was
shipped from exact local/GitHub `main` revision
`b7f6856732bf4ff360deb427aabc5d00d82dc99a`. Native ARM64 CodeBuild
`capiro-build-intel-api:bf8d0456-7b4a-459b-b871-fc2fae9a3faf` succeeded and
pushed API digest
`sha256:0904b41a5981e31966ab3600ee87e0364520831ccd2f7cd69502109fb4f6c9d7`.
The idempotent migration `capiro-dev-api-admin-migrate:78` exited 0 with no
pending migrations, and `capiro-dev-api:474` reached `COMPLETED` at 2/2
healthy tasks. The public app health request returned HTTP 200 and the
five-minute API log check found zero error-like matches. `GIT_SHA` and
`RELEASE_SHA` equal `b7f6856732bf4ff360deb427aabc5d00d82dc99a`; all four
protected activation flags remain false.

This deployment does not change the exit decisions: Package 8 remains
`NOT_COMPLETE` because the DTIC locator inventory is candidate-only and lacks
field-complete semantic extraction, completeness, review, expected-source
registration, persistence, and replay evidence. No production manifest,
historical replay, canonical publication, or notification was performed.

## 2026-09-25 evidence addendum

After this record was written, the following docs/evidence-only changes merged
to both local and GitHub `main`: Package 3 resolver success-path qualification
(PR #1845, merge `b983a25385ef96f2307552f2760133de49cfdf7e`), the DTIC
official XML/PDF qualification report (PR #1847, merge
`8ac297da24d53c7257c44993631428de5dc9f4c2`), and the Package 9 buyer intake
draft (PR #1848, merge
`0196391eba6d7d4e94fd088cf9e300fcf8756ee0`). No AWS deployment was performed
for these docs-only
changes. The buyer intake remains `DRAFT_NOT_APPROVED`; Package 9 remains
`NO_GO`/`shadow_only` until buyer-owned cohort, adjudication, cost, ownership,
and activation inputs are supplied and independently reviewed.

## 2026-09-26 bounded Package 9 overlap qualification

The disposable Package 9 harness gained an opt-in sustained mixed-load mode
that preserves the 100-row cap while pacing four local workers. Run
`p9-20260926000657425-8c3acf` passed with 100 accepted facts, 100 logical
notifications, terminal queue `0/0/0`, 120 compiled-query samples, query p95
7.23 ms, and 29,190 ms of drain/query overlap. This is retained as
`PASS_LIMITED_SCOPE` evidence only. It does not qualify production-scale
throughput, authenticated HTTP/network latency, source-change-to-verified
update latency, buyer outcomes, cost attribution, paid-provider economics,
rollback, or activation. Package 9 remains `NO_GO`/`shadow_only`.

The merged harness revision was also shipped directly to the dev API through
native ARM64 CodeBuild `capiro-build-intel-api:d2986a84-ebca-40df-ab66-a62fe65766be`
and ECS task definition `capiro-dev-api:475`, pinned to image digest
`sha256:08257e280c32b1dc49f5e5e1b3ee15d656a97b9915b7166a16130b8d86f8252a`.
The migration task exited 0, both replacement tasks are healthy, app health is
HTTP 200, and all four protected activation flags remain false. This is
runtime shipment evidence only; it does not change the Package 9 decision.

## 2026-09-26 bounded Package 3 native HASC seam

PR `#1855` merged the candidate-only native HASC stage-packet seam at
`0ee809cb4551b6ffc37393879f685d1d74a7f237`, matching local and GitHub `main`.
The strict `congressional_stage_packet_v1` provider binds mixed-family-capable
tables to a reviewed HASC identity index, exact source/profile/table-page
identity, and one persisted parser proof. The handoff routes the tagged packet
to the HASC composer, while the legacy committee adapter remains RDTE-only;
the durable factory proof-binds the composed artifact before immutable
persistence. Focused provider/handoff/resolver/durable tests passed (4 suites,
19 tests), the API and parser-router TypeScript scopes passed, and the existing
Package 3 qualification helper passed offline with no production writes.

The exact merged SHA was built by CodeBuild
`capiro-build-intel-api:5267959d-1447-4dc6-889c-5e3a939dd0df`, pushed as API
digest `sha256:01a42aa2c42cbaa6206c0f063db87c24c30899e438e95b8b5bfb7ec0a0f6891b`,
migrated with task `capiro-dev-api-admin-migrate:79` (exit 0; no pending
migrations), and deployed as `capiro-dev-api:476`. The service reached
`COMPLETED` at 2/2 healthy tasks; the app-dev health request returned HTTP 200,
running-task error-like log matches were zero, and all four protected flags
remained false. Full machine-readable details are in
`docs/defense-budget/package-3/release-evidence-2026-09-26.json`.

This increment does not satisfy Package 3 exit: no governed production source
registration, mixed-family completeness denominator, independent review,
expected-source admission, historical replay, canonical publication, or
activation was performed. Package 3 remains `NOT_COMPLETE`.

## 2026-09-26 native HASC qualification-only follow-on

PR `#1861` merged the qualification-only native HASC harness at
`c53d7439043c431bdcb29a3bef1332a4c682c6a4`, matching local and GitHub `main`.
The pinned 926-row FY2027 HASC fixture is converted into 48 native
`congressional_stage_packet_v1` tables and passed through the proof-bound HASC
factory. Because the reviewed fixture contains no independent Phase 4/5 native
identity index, the resolution context has zero entries: all 926 rows remain
explicit unresolved omissions, zero accepted HASC funding assertions are
emitted, and completeness is `incomplete`. The exact parser-result bytes are
re-read from disposable verified storage before artifact persistence.

The exact merged SHA was built by CodeBuild retry
`capiro-build-intel-api:2403fbac-e690-47a5-9008-7bc804e76d66` and pushed as API
digest
`sha256:06fb54947e1485b1973568840b571efedb0c8515a2f449f0c53727c4e01aa646`.
The first build compiled successfully but was stopped by a truncated push tag;
it pushed no image and mutated no ECS service. Migration task
`capiro-dev-api-admin-migrate:82` exited 0 with no pending migrations, and
`capiro-dev-api:479` reached `COMPLETED` with two healthy replacement tasks.
`/health` returned HTTP 200, the five-minute error-like log scan returned zero
matches, and all four protected flags remain false. Full details are in
`docs/defense-budget/package-3/release-evidence-2026-09-26-native-qualification.json`.

This remains an offline/candidate-only seam. No governed production
SourceDocument, mixed-family completeness denominator, independently approved
identity index, manifest admission, replay, canonical publication,
notification, or activation occurred. Package 3 remains `NOT_COMPLETE`.

## 2026-09-26 Package 8 DTIC semantic candidate

PR `#1859` merged the strict DTIC/JDOCS XML semantic candidate extractor at
`601d027a1f89717b77e0fc018e205b02f2488ee1`, matching local and GitHub `main`.
The extractor requires one PE number, title, budget year, monetary-unit
attribute, and five canonical funding fields per record. It emits typed values
with prefix-independent expanded-QName locators and binds the candidate to the
original XML SHA-256. Missing fields and non-canonical numeric text are hard
failures. The trusted runtime mirror is byte-for-byte aligned.

The API TypeScript check and focused inspector suite passed (1 suite, 13
tests). A real FY2026 DTIC XML smoke run against SHA-256
`02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a` emitted
PEs `0605801KA` and `0605998KA` with 10 and 9 field locators. Prefix-renamed
fixtures produced identical records while changing the original-byte SHA.

The exact merged SHA was built directly by CodeBuild
`capiro-build-intel-api:465de257-1b0d-4982-bd75-a0125e9f53d5` and pushed as
API digest
`sha256:98c0179957909c7d1a0acd18c02defee5b64cf4c853464e4d60a4fd3c7b164ba`.
Migration task `capiro-dev-api-admin-migrate:81` exited 0 with no pending
migrations, and `capiro-dev-api:478` reached `COMPLETED` with two healthy
replacement tasks. `/health` returned HTTP 200, the five-minute running-task
error-like log scan returned zero matches, and all four protected flags remain
false. Full machine-readable details are in
`docs/defense-budget/package-8/release-evidence-2026-09-26.json`.

This is still qualification-only evidence. No expected-source registration,
completeness denominator, PDF field reconciliation, human review, durable
artifact persistence, historical replay, canonical publication, or
notification occurred. Package 8 remains `NOT_COMPLETE`.

The trusted runtime mirror was then synchronized in PR `#1857` at the same
merged SHA, and `node scripts/verify-phase8-session4.mjs` returned
`SESSION4_SOURCE_PARITY_PASS` (the optional real FY27 replay gate remains not
enforced because no real replay evidence is available). The mirror-aligned
SHA was rebuilt by CodeBuild
`capiro-build-intel-api:e575c800-ebd3-4e74-81a8-44792221ebf7`, producing API
digest `sha256:1bf5427f2e0cfb3cb47ceb5a3fd14ccd18b4e576571515fff8f4cefa30b3cc93`.
Migration task `capiro-dev-api-admin-migrate:80` exited 0 with no pending
migrations, and `capiro-dev-api:477` reached `COMPLETED` with two healthy tasks,
HTTP 200 app health, zero error-like logs on the running tasks, and all four
protected flags false. Machine-readable details are in the Package 3 release
evidence JSON.
