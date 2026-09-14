# Phase 6 acceptance and evidence

See [release-qualification.md](release-qualification.md) for exact 575-test native results, immutable image digests, successful image verification, live rollout and internal canonical preview.

## Status boundaries

Implemented: deterministic discovery, review decisions/manual precedence, typed imported rules, separate keyword delivery controls, fixed internal workflows, governed Meri tools and folder-centered UI.

Locally tested: source/decision locks and real PostgreSQL RLS/history, paging beyond 300 bills, concurrent/retried assignments, manual suppression, stale source/rules, typed import, timezone/DST and held/uncertain delivery, late committed events, cross-service preparation failure injection and human-edit preservation. Regression summary and native exact-source results are recorded in the release manifest when available; a build still running is not a passed build.

Merged and deployed. Internal canonical preview and pause verification passed; the temporary discovery-only flag was then disabled. Automatic assignments, internal outputs and recipient channels remain off. No client acceptance or semantic relevance score is claimed.

## Local evidence

- Final native clean and populated upgrade rehearsal: 460 applied migrations in each isolated database, including 11 Phase 6 owner migrations. Populated public/private assignment fields and Phase 5 publication payload remained byte-equivalent; snapshot SHA-256 `eaf62aa2d06426d940e213b8c5b3d104aadf7b704d9976c63b162ec11f4504fd`. Actual owner/default-ACL conditions exercised; immutable history privileges verified.
- Browser component harness: 24 checks pass at 1440 and 390 px. Actual KeywordReview/WorkflowReview components with synthetic API fixtures, desktop/narrow screenshots, keyboard focus trap/Escape/restore, mixed frozen batch, empty/unsupported/read-only/archived/unresolved states, partial preparation/resume, held/uncertain delivery and delayed folder/tenant callback rejection. This is not a deployed full-shell or live provider test.
- API, Intel, Workspace and web TypeScript checks passed locally; Meri also passed; the exact native release checks passed for all five applications. Existing Phase 3 preparation tests now assert that private folder notes do not enter public configuration. Report tests mount a router for new deep links.
- Import audit preserves all 190 definitions and exact raw hashes; 189 supported, 1 unsupported selected expression (32340 in alert-38); all 10 rules accounted for with 145 references/118 distinct selections. Historical membership is not a labeled relevance corpus.

## Design references

[Phase 6 product page](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1469-2725) extends the existing Capiro Bills shell, component styling and dense folder table.

- [Suggested bills](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1469-2726)
- [Source drawer](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1474-2725)
- [Narrow source review](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1475-2952)
- [Workflow recovery](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1475-2969)
- [Ten-rule readiness](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1476-3089)
- [Narrow preparation recovery](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU?node-id=1476-3505)

Figma is a design reference with illustrative folder/bill content. Implementation screenshots come from the component harness. Neither proves live task execution or client accuracy.

## Remaining acceptance work

| Gate | Current result | Required evidence |
|---|---|---|
| Exact native release | Native build and separate image verification succeeded | Exact source, digests and retained evidence in release-qualification.md |
| Deployment | Completed and verified | Three owner migration tasks, five healthy exact-digest services, preserved data and disabled scheduler targets |
| Current rule mapping | Review required for all 10 | selected owner/folder/jurisdiction/session/document scope/aggregation and active staff mapping |
| Source coverage | Full-document corpus incomplete | qualified document classes/versions and explicit omitted counts |
| Client relevance | No labels supplied | at least 100 bills across 3 folders, labeled positives/negatives and coverage, zero critical identity/manual-override failures |
| Actual workflow pilot | Client pilot pending; deployed internal title preview and closed-gate registered worker verified | real scheduled source→suggestion→assignment→preparation→report review chain, dedup and pause evidence |
| Provider/recipient delivery | Not activated | exact current authorized channels, actual receipt, cadence/opt-out/uncertain reconciliation |
| Tagging time | Not measured | same fixed batch, manual versus assisted active time, sample size/uncertainty; proposed 50% reduction |
| Processing latency | Not measured | p95 after canonical source availability, concurrency/budgets and provider lag separated; proposed ≤5 minutes |
| Meri usefulness | Not measured | precision/recall/review-dismiss by folder and source coverage; proposed ≥90%/≥85%, subject to client approval |

These gates are not waived by passing synthetic tests. A one-rule pilot cannot count all ten imports as activated, and a complete parser cannot establish complete corpus coverage.

Deployed internal preview: 1897 bills / 76 pages in explicit Florida session `2026`; zero side effects, stable repeated page, feature pause confirmed. This is not client labeling or a scheduled source→assignment→preparation pilot.
