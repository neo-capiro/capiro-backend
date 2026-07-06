# Plan — line-type-aware Program Element profile (+ PE data backlog)

**Status:** proposed (2026-07-05). **Context:** Ninja asked whether Budget Lines and
Program Elements should have different profile views. They don't today — one
`/program-elements/:peCode` view renders the **same 8 tabs for every line**
(`ProgramElementWatchPage.tsx:986` — `tabItems` is a flat, unconditional list). But the
three underlying line types have different data shapes, so RDT&E-only tabs render empty
on procurement/O&M lines (what Ninja saw on the BLINs).

**Decision:** ONE unified profile shell that *adapts* to `lineType` — not two separate
views. Same money-graph tabs common to all; the ~2–3 type-specific tabs vary.

---

## Current state (grounded)

- `lineType` ∈ {`RDTE_PE`, `PROCUREMENT_BLIN`, `OM_BLI`} lives on the intelligence-cache
  response (`intelligenceQuery.data.lineType`) and is used **only** for a hero label
  (`ProgramElementWatchPage.tsx:1022`). It does not drive the tabs.
- Panels that already exist (so this is mostly conditionalization, not new build):
  - `SecondaryDistributionPanel` — P-40 recipients / quantity·unit-cost — **already
    rendered in the Funding tab** (line 783), fed by `getProgramElementProcurementLines`.
  - `MaturityLadderPanel` — RDT&E research→production ladder — Relationships tab (871).
  - `IncumbentMapPanel` / ContractorsPanel — R-3 performers (RDT&E-only source).
  - `ProjectsPanel` — R-2A projects (RDT&E-only).
- Confirmed data shapes (diag-pe, 2026-07-05):
  - RDT&E PE (0604115A): R-2 desc, R-3 performers (22), R-2A projects, bills, marks, deltas.
  - Procurement BLIN (4700MA6000…): P-40 request + FY25-31 FYDP outyears + marks; **no
    R-3 performers, no R-2A projects**; maturity ladder inapplicable (already fielding).
  - O&M BLI: SAG/OP-5 structure; none of the above.

---

## Phase 1 — line-type-aware profile (the ask)

**1a. Backend — expose `lineType` on the detail response.**
Add `lineType` to `GET /program-elements/:peCode` (derive from `appropriation_type`, or
read the intelligence cache) so the frontend branches tabs immediately instead of waiting
on the separate intelligence query. `program-element-read.service.ts` + the detail DTO.

**1b. Frontend — build `tabItems` from a per-type spec.** Replace the flat list with a
`tabsFor(lineType)` that includes only applicable tabs:

| Tab | RDTE_PE | PROCUREMENT_BLIN | OM_BLI |
|---|---|---|---|
| Overview, Funding, Legislation, Appropriability, People & office, Proof pack | ✅ | ✅ | ✅ |
| Relationships **+ Transition maturity** | ✅ | ✅ edges, **no maturity** | ✅ edges, no maturity |
| Incumbents (R-3 performers) | ✅ | ➖ hide (or Phase 2 award-sourced) | ➖ hide |
| Projects (R-2A) | ✅ | ➖ hide | ➖ hide |
| **Procurement detail** (qty · unit cost · P-40 recipients) | — | ✅ **promote** `SecondaryDistributionPanel` to its own tab | — |
| **Sub-activity (SAG / OP-5)** | — | — | ✅ (needs panel, Phase 3) |

**1c. Relabel + empty-state guards.** Hide `MaturityLadderPanel` for non-RDT&E; hide the
Incumbents tab for procurement/O&M (or repoint — Phase 2); give each intentionally-absent
tab a type-aware empty state so "no data" never looks like a bug. Keep the Funding tab's
mark ladder + the 2026-07-05 "Congress vs request" delta for all types.

**Effort:** ~1 backend field + 1 focused frontend refactor of `tabItems` + panel gating.
Web-only (+ tiny API DTO add). ~½–1 day. Verify per type against 0604115A (RDT&E),
4700MA6000 (proc), an O&M BLI.

---

## Phase 2 — procurement contractor coverage (optional, lower value)

Procurement BLINs have no R-3 performers, so Incumbents is empty. If procurement
incumbents matter, source them from `federal_award` (pe_code + UEI-confirmed primes)
rather than R-3. **Caveat:** diag shows award→procurement-BLIN attribution is sparse
(awards 0–1 per BLIN), so yield is low. Recommend hiding the tab for procurement (Phase 1c)
unless/until award attribution improves. Decide with Ninja.

---

## Phase 3 — data completeness

- **Verify `program_element_procurement_line`** (secondary distribution) is loaded for the
  BLINs — extend `diag-pe` with a `procurementLines` count; if empty, run
  `load-pdoc-enrichment` / re-`parse-pdoc` against the committed corrected artifacts.
- **O&M SAG (OP-5)** — build a SAG-breakdown panel for `OM_BLI` (data via the O&M loaders).
- **Known unfixable gaps** (data doesn't exist yet — documented in the data-ops runbook):
  FY2025 enacted for procurement (no FY25 approps artifact); FYDP prior-PB comparison
  (needs the FY2026 R-1 book).

---

## Phase 4 — freshness / automation

Wire the derive/enrich verbs into the weekly EventBridge ingestion schedule
(`infra/cdk/lib/ingestion-schedule.ts`) so the money graph stays current without manual
runs. Sequence: `derive-budget-actions → derive-relationships → seed-capabilities
(--artifact) → derive-office-program-links → derive-intelligence-cache →
compute-budget-deltas`. Optionally add `sync-sam-personnel` (windowed) + a periodic
`auto-confirm-pe-person-candidates` at the agreed threshold. Currently all manual.

---

## Phase 5 — coverage growth (human-gated)

Work the review queues that grow People-tab reach: **454 open person↔PE candidates** +
**26 candidate office→program links** via the admin review UI (confirming sets `pePrimary`
/ activates the role chain). Deliberately human-reviewed; not auto-approvable below 0.80.

---

## Sequencing / risks

1. **Phase 1** first — highest UX value, self-contained, removes the misleading empties.
2. Phase 3 (verify procurement_line) can run in parallel (read-only diag).
3. Phase 4 hardens freshness; Phase 5 is ongoing curation; Phase 2 only if award data justifies it.

**Risks:** `lineType` must be present before tabs render (Phase 1a fixes the ordering);
don't hide a tab that a given RDT&E line legitimately populates (gate on `lineType`, not on
emptiness); keep the shared money-graph tabs identical across types so the view still reads
as one coherent profile.
