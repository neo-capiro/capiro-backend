# Non-RDT&E Defense-Budget Ingestion V1 (Phase 5)

## Overview

Phase 5 completes the non-RDT&E defense-budget ingestion families needed by the Program Elements and Budget Lines experience:

```
Procurement: P-1 → P-40 → P-5/P-5A/P-21/P-3A
O&M:         O-1 → OP-5
MILCON:      C-1 → DD1391
```

For every supplied source document, the system:

1. Preserves the source's native identity.
2. Extracts all represented identity, funding, quantity, unit-cost, narrative, scope, schedule, and relationship facts.
3. Records truthful page/cell evidence and explicit omissions.
4. Uses Phase 3's local-first parser routing and paid-page controls.
5. Emits `defense_budget_extraction_v1` artifacts.
6. Runs Phase 2 trusted verification with family-specific rules.
7. Reconciles authoritative summary/detail exhibits without unsafe inference.
8. Produces a read-only native projection plan and cycle certification report.
9. Makes no canonical data promotion in Phase 5.

## Source Families and Required Exhibits

### Procurement

- **P-1**: Procurement summary, BLIN-level annual funding.
- **P-40**: Line-item detail, resource summary, secondary distribution.
- **P-5/P-5A**: Cost analysis and production detail (optional enrichment).
- **P-21**: Production/delivery schedule (optional enrichment).
- **P-3A**: Individual modification or related line detail (optional enrichment).

### O&M

- **O-1**: O&M summary, SAG-level annual funding.
- **OP-5**: O&M detail, narrative, drivers, change tables.

### MILCON

- **C-1**: MILCON summary, project identity and funding.
- **DD1391**: Detailed MILCON project justification form.

## Native Identity Rules

### Procurement (PROCUREMENT_BLIN)

```
PROCUREMENT_BLIN = component + appropriation account + line code + base/AP distinction
```

- P-1/P-40 line codes are not PE codes.
- Base procurement and advance procurement are distinct identities.
- Titles are aliases, never keys.

### O&M (OM_SAG)

```
OM_SAG = component + appropriation/account + SAG/activity code
```

- O-1 and OP-5 records are not PEs.
- Summary and detail rows reconcile at the same declared scope.

### MILCON (MILCON_PROJECT)

```
MILCON_PROJECT = component + appropriation + project number + installation/location context
```

- Project title is not a natural key.
- C-1 summary and DD1391 detail retain separate source assertions.

## Printed-Unit Rules

- All numeric values use exact decimal strings — no binary float.
- Units are never inferred by magnitude.
- Scope compatibility checks ensure summary/detail arithmetic compares like with like.
- Source-specific rounding/tolerance helpers based on printed units.

## Parser Routing and Paid-Page Authorization

- Phase 3's local-first parser routing is used.
- Local deterministic engines first; targeted OCR/layout escalation.
- Explicit paid-page authorization only (max-page flags).
- No paid parser call during tests or plan execution.

## Summary/Detail Reconciliation

- P-1 ↔ P-40 (procurement): scope-keyed matching at matching FY.
- O-1 ↔ OP-5 (O&M): scope-keyed matching, change arithmetic where defined.
- C-1 ↔ DD1391 (MILCON): native project identity matching, cost-category arithmetic.
- Missing comparison source is NOT_RUN, never pass.
- OCR-derived money cannot auto-pass — requires review per policy.

## Review Workflow

- Needs-review artifacts require an allowed reviewed acceptance.
- OCR low-confidence values require corroboration/review.
- Unresolved pages enter review, not empty success.

## Cycle Certification

- Certification statuses: CERTIFIED_NON_RDTE_READY_FOR_PROJECTION, NEEDS_REVIEW, REJECTED, INCOMPLETE.
- Cannot pass while any required document, identity category, or verification control is missing.
- Certification reports include: expected/supplied/parsed/verified documents, identities by family/account/component, required data-category coverage, reconciliation results, warnings/omissions, parser method and paid/local page counts, review backlog, projection-plan counts.

## Projection-Plan Inspection

- Read-only native projection plan records exact future canonical records Phase 7 will write.
- Plan requires a final trusted verification result.
- No Phase 5 command can execute canonical writes.

## Known Unsupported Layouts

- Unrecognized exhibit layouts become blocking omissions or review routes, not empty successes.
- Complex pages escalate through Phase 3 routing without paid calls in tests.

## Recovery from Corrupt Cache or Failed Parsing

- Family runs can be resumed/replayed from content-addressed artifacts.
- Content SHA mismatch rejects cached parser output.

## Phase 5 Performs No Canonical Promotion

Phase 5 does not promote verified assertions into canonical tables. All projection plans are read-only. Canonical promotion is Phase 7 work.

## Remaining Phase 7 Work

- Promotion-service mappings for procurement budget lines, O&M SAGs, and MILCON projects.
- Cutover tasks for legacy procurement row migration.
- Read-path changes to serve native non-RDT&E identities.
- Prisma migration execution against shared databases.
