# Procurement family — composer, verification, and canonical procurement lines

This folder holds the Phase 5 procurement family modules (pure: composer,
verification policy, P-1 ↔ P-40 reconciliation) **and** the canonical writer /
reader for procurement budget line items that have **no Program Element parent**.

A P-1 line such as *Procurement, Defense-Wide 0300D · P-1 Line 68 · 0204WARSYS
"Warrior Systems <$5M"* is a `PROCUREMENT_BLIN`, never an RDT&E PE
(`extractors/types.ts` identity guardrail), so it cannot live in `program_element*`.
Before this work its extraction/composition existed but had no queryable table.

## Tables (apps/api/prisma, migration `20280918010000_procurement_line_canonical`)

| Model | Table | Identity | Notes |
|---|---|---|---|
| `ProcurementLine` | `procurement_line` | `(appropriation_code, line_item_number)` e.g. `("0300D", "0204WARSYS")` | `p1_line_number` shifts per cycle, so it is "latest written cycle"; `related_pe_code` is a **reference string only** (no FK, never creates a PE). |
| `ProcurementLineYear` | `procurement_line_year` | `(line_id, fy, subline_key)` | `subline_key = ''` for the P-1 line total, P-40a category key (`"P1"`) for a subline. `''` not NULL so the UNIQUE actually dedupes. Money is `$M` at `Decimal(18,6)` so `$K`-printed P-1 values stay exact (`511.016`). |
| `ProcurementLineSource` | `procurement_line_source` | `(line_id, source_span_hash)` | Mirrors `program_element_source`: exhibit, fy, page, snippet, publisher, confidence, `source_document_id` FK, `extractor_version`. |

Global tables (no `tenant_id` / RLS): public-domain J-book data, read-only via API.

## Writer — dark by default

`ProcurementLineWriterService.write({ artifacts, report, gate?, scope? })`

* **Input** is the composer's *input and output*: the exact
  `ProcurementExhibitArtifacts` it consumed plus its `ProcurementFamilyReport`.
  The report alone cannot drive canonical writes — it has identities,
  comparisons and the decision, but the per-value page / excerpt / span-hash a
  citation needs lives on the artifact assertions and evidence.
* **Gate:** `DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES=1` (exact match) or the
  call returns `{ mode: 'dry_run', wouldWrite: {...}, skipped: [...] }` and makes
  **no Prisma call at all**. `options.dryRun: true` forces dry-run regardless.
* **Decision:** composer `VERIFICATION_PASSED | NEEDS_REVIEW | REJECTED` maps to
  V1 `PASS | REVIEW | REJECT`; an optional trusted `gate` (`decision`,
  `acceptedAssertionIds`) replaces it.
* **Scope:** `family` (default, strict) writes nothing unless the *family* is
  PASS. `identity` lets clean identities through under a family REVIEW; an
  identity named by a blocking finding is REJECT, by a review finding REVIEW.
  A family REJECT writes nothing in either scope.
* **Rules:** only PASS assertions are written; REVIEW/REJECT/unsupported are
  counted in `skipped[]` with a reason (`assertionId`, `fy`, `field`). A value
  with no page provenance is not written. Conflicting PASS values for one
  `(year, field)` are held back as REVIEW — no winner is picked. RDTE_PE
  identities inside a P-doc and advance-procurement identities are skipped,
  never merged. The service has no `programElement` delegate.
* **Idempotent:** upserts on the identities above; sources dedupe on
  `source_span_hash`; a second identical run reports `inserted: 0`. Year rows
  merge per field — fields not asserted in a run are never nulled.

The planner (`procurement-line-canonical-v1.ts`) is pure and unit-tested on its
own; the service only applies its plan inside one `$transaction`.

## Reads

* `GET /api/defense-budget/procurement-lines?search=<title or BLIN>[&limit=25]`
* `GET /api/defense-budget/procurement-lines/:appropriationCode/:lineItemNumber`
  → `{ line, years: [...], sources: [...] }`; sources ordered like the PE proof
  pack (P-1 → P-40 → P-40A → P-5 → …, then FY desc, page asc) and each carries a
  ready `citation`, e.g.
  `P-1 Line 68 — 0204WARSYS FY2027 request $511.016M — Exhibit P-1, p. 12`, plus
  a `deepLink` (`sourceUrl#page=N`). Money is returned as a number and as an
  exact string under `years[].exact`.

Registered in `ProgramElementModule`; `standard_user` via `RolesGuard`, GET-only.

## Promotion script

```
# dry-run (default) — composes the family, prints the plan, touches nothing
pnpm --filter @capiro/api exec tsx scripts/promote-procurement-lines.ts \
  --artifacts path/to/p1_artifact.json --artifacts path/to/p40_dir/ --p40-required

# write — BOTH the flag and the env var are required
DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES=1 DATABASE_URL=... \
  pnpm --filter @capiro/api exec tsx scripts/promote-procurement-lines.ts \
  --artifacts ... --write [--scope identity] [--report composed.json]
```

Artifacts are `defense_budget_extraction_v1` JSON files (strict-validated) and
are bucketed by `source.exhibit` (P-1 / P-40 / P-5, P-5A / P-21 / P-3A).
`--report` reuses an already-composed report instead of recomposing. Exit codes:
`0` ok, `2` usage/validation, `3` `--write` refused (env flag unset), `1` error.

## Tests

`pnpm --filter @capiro/api exec jest src/defense-budget/procurement` — planner,
writer (mocked Prisma: PASS written, REVIEW/REJECT skipped, dry-run touches
nothing, idempotent second run), read-service ordering + citation labels,
controller. Fixtures model the real Line 68 (`procurement-line-canonical-v1.fixtures.ts`).
