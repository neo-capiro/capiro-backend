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

The current API rollout is task definition `:469`, with two healthy tasks on
digest `sha256:eff8632487f7d390de7d7d4294605ab304ae481113bd0e0a5ea95fb30141d014`.
The bounded coordinator is task definition `:3`; both releases retain all
protected activation flags false.

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

| Package | Current decision                                                      | Remaining exit evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–2     | Previously released evidence retained                                 | No status expansion is made by this candidate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3       | NOT_COMPLETE                                                          | Procurement, O&M, and MILCON lifecycle paths are covered. The congressional factory is deliberately not connected to the lifecycle because there is no governed structured-table input provider or production proof packet. No congressional semantic production or publication is authorized.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 4–7     | Previously released implementation and limited qualification retained | No claim is made that the later Package 9 buyer/accuracy gates are satisfied. Unsupported financial joins remain unresolved by policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 8       | NOT_COMPLETE                                                          | The XML provenance contract is ready for a qualified companion, but production still has zero active/canonical snapshots, zero governed manifests, and zero manifest-eligible rows. The FY2026 DTIC lead now has a qualification-only manifest and offline artifact spike: official XML GET 200 and SHA-256 `02479cd6e67dfee10bb1029d9413dbc35e81174384b25319fedfb9589d4aac6a` exactly matches the pinned Handriss mirror; two PE identities and one narrative were emitted with XML locators and no PDF page claims. Funding mapping remains warning-only, and semantic PDF reconciliation, completeness, human review, and expected-source registration are still incomplete. A second FY2026 DARPA lead is also NO-GO: the official XML URL returned HEAD 200 but GET 404, with no authoritative XML hash and no deterministic expected-source key. No historical replay or client notification is authorized. |
| 9       | NO_GO / shadow-only                                                   | A predeclared buyer cohort, independent adjudication, complete manifest approvals, matched cost attribution, named operational owners, and explicit activation approval are absent. Product-scale authenticated latency and deployed rollback remain unqualified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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
