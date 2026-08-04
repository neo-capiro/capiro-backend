# RDT&E Ingestion V1 — Phase 4 Architecture

Status: COMPLETE (Workstreams A–O on `agent/pe-complete-rdte-ingestion-v1`).
Scope: trustworthy, verified, annual-cycle RDT&E data from the official R-1,
R-2/R-2A, R-3, and R-4/R-4A exhibits — at the **verified artifact and
projection-plan level only**. Phase 4 never writes canonical Program Element
rows; canonical promotion is Phase 7.

## Pipeline

```text
Annual RDT&E manifest (budget_cycle_manifest_v1)
        │
        ├── R-1 master exhibit(s)          [required]
        ├── R-2/R-2A volume(s)             [required]
        ├── R-3 cost-analysis volume(s)    [required]
        └── R-4/R-4A schedule exhibit(s)   [required|optional|not_applicable]
        ▼
Phase 3 parser router (content-addressed replay; local engines by default;
explicitly authorized, page-bounded paid escalation only)
        ▼
Normalized page/table/layout results (ParserPageResultV1)
        ▼
Pure RDT&E semantic extractors (apps/api/src/defense-budget/rdte/**)
  r1/  identity + FYDP budget positions
  r2/  segmentation + PE identity/narrative + PE cost table
  r2a/ project identity/narrative + project funding + project-sum reconciler
  r3/  performers/performing activities (role-honest)
  r4/  milestones + truthful schedule periods
        ▼
defense_budget_extraction_v1 artifact per source document
        ▼
Phase 2 trusted verification (inspect mode; VERIFICATION_PASSED /
NEEDS_REVIEW / REJECTED; immutable review decisions)
        ▼
Cross-exhibit reconciliation (rdte/reconciliation) + cycle certification
(rdte_cycle_bundle_v1: CERTIFIED_RDTE_READY_FOR_PROJECTION only with zero
blocking findings and every required document verified)
        ▼
Read-only rdte_canonical_projection_plan_v1 (deterministic content SHA)
        ▼
Phase 7 verified promotion — NOT IMPLEMENTED IN PHASE 4
```

## Boundaries

### Parser ↔ semantic boundary
Parser engines recover text, tables, coordinates, and reading order. They
carry NO budget semantics. All RDT&E decisions — which row is a PE, which
page belongs to which exhibit, what a column means, whether a value is
budget-year request vs outyear vs historical context vs CTC/total cost, how
projects/performers relate to PEs, what must reconcile — live in the pure
semantic modules under `rdte/`.

### Trust boundary
- Source PDF bytes are the exact bytes registered and parsed (SHA-256).
- Every assertion carries physical PDF page, printed page, table/row/column
  labels, and parser-run provenance.
- Money is exact canonical decimal strings — never binary floats.
- A required source fact is asserted OR explicitly omitted; warnings never
  account for a required fact.

### No-canonical-write boundary
Phase 4 imports no `ProgramElementWriterService`, never calls Prisma
canonical mutations, and the projection commands refuse `--commit`. The
words `projection`, `candidate`, and `ready` do not authorize a write; no
Phase 4 field is equivalent to `promotionReady`. Permanent gates
(`rdte/gates/rdte-phase4-gates-v1.ts` + `verify-rdte-phase-4-safety.ts`)
fail the build on any bypass.

## Exact money / unit rules

- Original value preserved as a canonical decimal string; original unit
  preserved; normalization to millions uses decimal-string arithmetic only
  (`contracts/decimal-string.ts`).
- Units resolve from header/caption text + manifest policy — never from
  number magnitude. Unresolved unit → blocking `missing_unit` omission on
  every money cell.
- Fiscal years come from headers, never column position (positional fallback
  only under an explicit manifest policy, flagged for review).

## Column roles → dispositions (single source of truth)

`rdte-column-role-v1.ts` maps each column role to its ONLY lawful annual
dispositions:

| column role            | disposition                        | canonical target |
|------------------------|------------------------------------|------------------|
| budget_year_request    | canonical_request_candidate        | ProgramElementYear.request |
| outyear_projection     | pe_budget_position / project_budget_position | *BudgetPosition (position of the printing cycle) |
| prior_actual_context   | contextual_only                    | excluded (document fact) |
| current_enacted_context| contextual_only                    | excluded (document fact) |
| base/oco/total_component | contextual_only                  | excluded (document fact) |
| cost_to_complete       | non_annual_cost                    | excluded |
| total_cost             | non_annual_cost                    | excluded |
| quantity / unknown     | —                                  | omission/review |

Outyear projections stay tied to the President's Budget cycle that printed
them (`positionCycle = pb_fy<cycleFY>`) and never become a future year's
canonical request. Historical actual/enacted context printed in a PB exhibit
never populates canonical `executed`/`enacted`.

## Identity doctrine

- PE code is the RDT&E identity key; identity is exhibit-driven (R-series →
  RDTE_PE), never title/code-pattern-driven.
- R-1 owns PE identity: only the R-1 catalog artifact projects
  ProgramElement rows.
- Project identity is `(peCode, projectCode)`; project codes validate
  against the bounded source-faithful policy (1–32 chars, no truncation;
  canonical width expanded via the reviewed migration).
- Titles are descriptive, not keys. Duplicate natural keys produce explicit
  conflicts — input order never picks a winner.
- A project with no valid parent PE is **blocked**, not dropped.

## Page-number conventions

Physical PDF pages are 1-based internally. Printed page labels are preserved
separately (`printedPage`) for citation deep-links. `page_only` evidence is
used whenever coordinates are unavailable; `cell_bbox` only when real
coordinates exist — a full-page bounding box is never fabricated to imply
cell evidence.

## Content-addressed replay

Parser outputs and artifacts are content-addressed (SHA-256 of canonical
JSON). The Phase 4 build consumes Phase 3 page results from `--pages-dir`
(`<documentKey>.pages-v1.json`) and never re-parses; `fixture://` sources
resolve through the built-in synthetic golden fixtures for rehearsals.

## Key modules

| Module | Responsibility |
|---|---|
| `rdte/rdte-column-role-v1.ts` | exhibit/column-role/disposition vocabulary + role→disposition policy |
| `rdte/rdte-header-normalizer.ts` | multi-row header merging, FY/role vocabulary |
| `rdte/rdte-unit-resolver.ts` | unit resolution from text + manifest policy |
| `rdte/rdte-rounding-policy-v1.ts` | exact-decimal comparison + (N+1)×0.5 source-unit tolerance |
| `rdte/r1/*` | R-1 identity + funding extraction + artifact |
| `rdte/r2/*` | segmentation, context resolution, identity, narrative, PE cost table, R-1/R-2 comparison requests |
| `rdte/r2a/*` | project identity/narrative, project funding, project-sum reconciler, artifact builder |
| `rdte/r3/*` | performer extraction, role classifier, normalizer, artifact builder |
| `rdte/r4/*` | schedule-period parsing (no fabricated dates), milestones, artifact builder |
| `rdte/reconciliation/*` | cycle reconciler + certifier (`rdte_cycle_bundle_v1`) |
| `rdte/projection/*` | `rdte_canonical_projection_plan_v1` contract + read-only planner |
| `rdte/cycle/*` | pure end-to-end cycle pipeline + golden fixtures |
| `rdte/gates/*` | permanent architecture gates |
| `scripts/build-rdte-cycle.ts` | manifest-driven build (exit 0/2/3/4/5) |
| `scripts/report-rdte-cycle.ts` | cycle report (machine JSON + human summary) |
| `scripts/plan-rdte-canonical-projection.ts` | read-only projection plan (refuses --commit) |
| `scripts/verify-rdte-phase-4-safety.ts` | permanent gate runner |

## Known unsupported layouts

- R-1/R-2 multi-row headers beyond two physical rows without manifest
  positional fallback policy.
- Project funding tables where the fiscal header is absent AND no manifest
  positional policy is declared (cells route to omission, never guessing).
- R-4 exhibits that encode schedules as pure prose with no tabular structure
  (extractor emits no milestones; manifest policy decides blocking).
- Classified/redacted rows are omitted explicitly; they never pass silently.

See `docs/runbooks/rdte-annual-cycle.md` for operator usage and
`docs/program-elements/rdte-phase-7-handoff.md` for the Phase 7 write
contract.
