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

The authoritative `main` advanced afterward through the FY2027 HASC
qualification and business-development Phase 5 merge
(`c2bc41a86ef087e4b163c556595507ec08b396cf`). That exact current-main
revision is now deployed as API task definition `:464`; migration `:77` found
433 migrations and exited successfully, with two healthy tasks and two final
healthy target-group members. The feature remains fail-closed and Package 9
remains `NO_GO`/`shadow_only`.

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
  evidence remains available separately.
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

| Package | Current decision                                                      | Remaining exit evidence                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–2     | Previously released evidence retained                                 | No status expansion is made by this candidate.                                                                                                                                                                                                                                                                                                                                                                    |
| 3       | NOT_COMPLETE                                                          | Procurement, O&M, and MILCON lifecycle paths are covered. The congressional factory is deliberately not connected to the lifecycle because there is no governed structured-table input provider or production proof packet. No congressional semantic production or publication is authorized.                                                                                                                    |
| 4–7     | Previously released implementation and limited qualification retained | No claim is made that the later Package 9 buyer/accuracy gates are satisfied. Unsupported financial joins remain unresolved by policy.                                                                                                                                                                                                                                                                            |
| 8       | NOT_COMPLETE                                                          | The XML provenance contract is ready for a qualified companion, but production still has zero active/canonical snapshots, zero governed manifests, and zero manifest-eligible rows. The Handriss/DTIC corpus is a discovery and structured-companion lead, not an authoritative replacement for official PDFs and not an approved production manifest. No historical replay or client notification is authorized. |
| 9       | NO_GO / shadow-only                                                   | A predeclared buyer cohort, independent adjudication, complete manifest approvals, matched cost attribution, named operational owners, and explicit activation approval are absent. Product-scale authenticated latency and deployed rollback remain unqualified.                                                                                                                                                 |

## Safe next manifests

1. Package 3: admit at most one immutable official congressional source only
   after its PDF/structured companion identity, review profile, and persisted
   parser proof are governed and independently reviewable.
2. Package 8: use the Handriss catalog to discover candidate official DTIC
   publications, then bind each accepted XML companion to the independently
   archived official PDF. Keep the eligible manifest empty when any required
   identity, bytes, review, or publication gate is missing.
3. Package 9: run the declared benchmark and production-scale qualification
   only after the cohort, adjudicators, price/cost boundary, owners, and
   activation authority are recorded. Until then all protected ingestion and
   publication flags remain false.

No production manifest, replay, canonical publication, paid-provider run,
historical notification, or activation is authorized by this record.
