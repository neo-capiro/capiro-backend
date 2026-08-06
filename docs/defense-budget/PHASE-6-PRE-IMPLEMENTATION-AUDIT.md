# Phase 6 — pre-implementation repository audit

The Phase 6 plan requires, before any code changes, that every referenced file be
read and that any stale path or symbol be replaced with the actual current value,
with every substitution recorded. This is that record.

Audited against `origin/main` at `af9ef9d2` plus the preserved Workstream A/B work
on `agent/pe-budget-congressional-enacted-ingestion-v1`.

## Stated repository facts — all verified as written

| Plan claim                                                                                                                                                                                                                           | Verified                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `extraction-artifact-v1.ts` supports `RDTE_PE`, `PROCUREMENT_BLIN`, `OM_SAG`, `MILCON_PROJECT`                                                                                                                                       | yes — all four present                                                                                                      |
| `committee-artifact-v1.adapter.ts` recognises HASC, SASC, HAC-D, SAC-D, NDAA conference, appropriations conference, public law                                                                                                       | yes — all seven modes present                                                                                               |
| `scripts/__tools__/extract_armed_services_report.py` exists                                                                                                                                                                          | yes                                                                                                                         |
| `committee-report-parser.ts` writes through `ProgramElementWriterService`                                                                                                                                                            | yes — 2 references                                                                                                          |
| Legacy canonical loaders present: `parse-hasc-sasc-reports.ts`, `parse-defense-approps-reports.ts`, `parse-ndaa-conference.ts`, `parse-defense-approps-public-law.ts`, `sync-report-provisions.ts`, `load-defense-budget-package.ts` | yes — all six present                                                                                                       |
| `program-element-field-ownership.ts` distinguishes the stage authorities                                                                                                                                                             | yes — `hascMark`, `sascMark`, `hacDMark`, `sacDMark`, `ndaaConference`, `conference`, `enacted`, `reprogrammed`, `executed` |

No substitutions were required for any TypeScript path or symbol the plan names.

## Required substitution — Python extractor root

The plan's "Shared target files" section specifies:

```text
apps/defense-budget-parser/defense_budget_parser/extractors/stages/
```

That directory does not exist. The actual package layout is:

```text
apps/defense-budget-parser/src/capiro_defense_budget_parser/
```

`pyproject.toml` declares `name = "capiro-defense-budget-parser"` and
`packages = ["src/capiro_defense_budget_parser"]`. The plan's path is wrong in two
ways: the package name, and the missing `src/` layer. There is also no `extractors/`
subdirectory yet, so Workstream D onward will create it.

Substitute for all Phase 6 Python work:

```text
apps/defense-budget-parser/src/capiro_defense_budget_parser/extractors/stages/
```

## Progress against the plan's target files

Workstream A is complete and green; Workstream B is substantially complete. Nothing
past B has been started.

| Planned file                                                                          | State                                            | Workstream |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------- |
| `stage-source-profile-v1.ts` + `.spec.ts`                                             | present, passing                                 | A          |
| `budget-line-reference-v1.ts`                                                         | present                                          | B          |
| `budget-line-reference-v1.spec.ts`                                                    | absent — covered indirectly by the resolver spec | B          |
| `line-reference-resolver.ts` + `.spec.ts`                                             | present, passing                                 | B          |
| `congressional-table-v1.ts` + `.spec.ts`                                              | absent                                           | C          |
| `stage-action-v1.ts` + `.spec.ts`                                                     | absent                                           | J          |
| `enactment-proof-v1.ts` + `.spec.ts`                                                  | absent                                           | L          |
| `stage-cycle-report-v1.ts` + `.spec.ts`                                               | absent                                           | N          |
| `composition/`, `authorization/`, `appropriations/`, `post-enactment/`, `projection/` | all absent                                       | C–N        |

Present but not named in the plan: `stage-vocabulary-v1.ts` (shared stage
vocabulary supporting A and B).

Stages suite: 52 tests, all passing.

## Known inherited hazard — CRLF and the prettier gate

`main` does not carry the `.gitattributes` `eol=lf` rules for `*.ts`, `*.json`, and
`*.md`; those exist only on the unmerged Phase 5 audit-repair branch. With
`core.autocrlf=true`, files checked out on a `main`-based branch receive CRLF,
prettier rejects them, and `git status` still reports clean because autocrlf
normalises on add — so the problem is invisible to git.

Committing the Workstream A/B files already produced the warning
`LF will be replaced by CRLF the next time Git touches it`.

Until Phase 5 merges, any Phase 6 branch will hit this. After it merges, the
`eol=lf` rules land on `main` and new checkouts are correct; files checked out
before that still need renormalising (delete the tracked paths and re-checkout).

## Prerequisite status

The plan requires Phase 5 A–O plus closeout merged before Phase 6 implementation
begins. Phase 5's implementation is on `main`, but its audit-repair branch
(PR #757) is green and **unmerged**. Workstreams C onward should not start until it
lands.
