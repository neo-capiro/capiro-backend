# Defense-budget Package 7 — customer product

Package 7 completes the customer-facing defense-budget workflow on top of Packages 4–6. The API release is built from code merge `93bf1e4284948145bd3956eed130ab00134a94d5`; the web release includes decision-state hotfix merge `aa537571a1f8bbdeb9cc3a5352926eaebf989e22`.

## Delivered scope

- Explorer queries now apply fiscal year, component/service, budget family, capability, movement, watched-only and search filters to real read parameters.
- Explorer evidence cells no longer call an unreviewed row verified. Profile sources distinguish loading, error, empty, candidate and reviewed states.
- Program-profile and explorer CSV exports carry fiscal year, stage, `USD millions`, data as-of time, export time, attribution status and source-inspector links. Missing facts remain missing rather than becoming zero.
- A pinned buyer-workspace API composes qualified federal legislative evidence, acquisition continuity and funding/execution under one `asOfFy` and `knownAt`. Each section preserves its own coverage and freshness. The canonical budget section remains explicitly unsupported for historical `knownAt` reads rather than silently mixing time scopes.
- Client profiles support program, PE, project and capability watches with a required client-specific reason, append-only subscription/material-update history, and one acknowledgement-or-dismissal decision per update.
- The Meri `get_pe_buyer_workspace` tool requires explicit PE, fiscal year and knowledge timestamp, preserves unsupported gaps, and directs answers to explain change, amount/stage, scope, client implication, next step and citations.
- Existing compare, monitoring, action-board and source-inspector flows remain the workflow seams; Package 7 does not create a second action or memory system.

## Evidence

- [Validation evidence](./validation-evidence-2026-09-24.md)
- [Machine-readable release evidence](./release-evidence-2026-09-24.json)

Release scope: account `967807252336`, region `us-east-1`, cluster `capiro-dev`.

| Runtime | Released state |
| --- | --- |
| API task definition `:451` | ECS steady; desired/running/pending `2/2/0`; both tasks healthy on the pinned Package 7 API digest |
| Migration task definition `:135` | Client watch migration applied; one-off task exited 0 |
| Web task definition `:136` | ECS steady `1/1/0`; runtime config reports hotfix merge SHA |
| Web-vNext task definition `:351` | ECS steady `1/1/0`; `os.capiro.ai` runtime config reports hotfix merge SHA |

## Activation boundary

The customer product and client-watch ledger are active through the existing authenticated surfaces. No Package 4–6 ingestion or publication flags were widened: federal legislative ingestion, acquisition-continuity ingestion, and funding/execution source publication remain independently controlled. Package 7 introduces no outbound notification scheduler and sends no historical notification flood.
