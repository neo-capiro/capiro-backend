# GAPS — Portfolio module backend audit

Backend gaps found while building the Portfolio module against the live backend
(`PORTFOLIO-HANDOFF` §12, `FOUNDATION-HANDOFF` §10). Each entry was confirmed by
reading the server controller/service — not inferred. Sorted **blocking-first**.

**Scope note:** the module ships inside `apps/web/src/vnext/` (runtime-gated to
the vNext surface). No new backend was written; every screen reads an endpoint
that already exists (see `docs/handoff/portfolio-api-inventory.md`). The gaps
below are the surfaces where the design asks for data no endpoint yet provides.

## Summary

| id | module | surface | blocking | backend surface | owner |
| --- | --- | --- | --- | --- | --- |
| G2 | Portfolio index | Program elements — cross-client aggregation + net portfolio delta | No (per-PE figures render; attribution + net delta omitted) | 1 aggregate endpoint joining watched PEs to clients | unassigned |
| G3 | Portfolio index | Per-row attention / readiness / next-touch without N+1 | No (columns omitted per §7.1 "must not") | 1 portfolio-scoped aggregate | unassigned |
| G1 | Portfolio index | Pulse band `meetingsThisWeek` + `activeStrategies` | No (band shows clients / need-attention / bills / regulations) | extend `intelligence/portfolio-summary` | unassigned |

---

### G1 — Pulse band is missing two of the five designed figures

- **Module / surface:** Portfolio index → Portfolio pulse band (§7.1 band 2).
- **What the UI needs:** clients · need attention · active strategies · meetings
  this week · tracked bills, plus a refreshed-at stamp.
- **What exists:** `GET /api/intelligence/portfolio-summary` returns
  `{ activeClients, needAttention, ldaSpendQtd, billsTracked, activeRegulations }`
  (`intelligence.controller.ts:362`, `intelligence.service.ts:6677
  getPortfolioSummary`). It covers clients, need-attention and tracked bills.
- **What's missing:** `activeStrategies` (lives in `api-strategy`, tenant-scoped
  but not aggregated into the summary) and `meetingsThisWeek` (lives in
  `engagement/meetings`, not aggregated portfolio-wide into the summary).
- **Evidence of absence:** read `getPortfolioSummary` end to end — it queries
  `client`, `clientIntelMapping`, `lda_filing`, `congress_bill`,
  `federalRegisterDocument` only; no strategy or meeting table is touched.
- **Shipped instead:** the pulse band renders the four figures the summary does
  provide (Clients, Need attention, Tracked bills, Active regulations). The two
  missing figures are omitted, not fabricated.
- **Blocking?** No.
- **Estimated backend surface:** extend `getPortfolioSummary` with two counts
  (join `api-strategy` strategies by tenant; count `engagement/meetings` in the
  current ISO week). No migration.
- **Owner:** unassigned

### G2 — Program elements are not aggregated across clients

- **Module / surface:** Portfolio index → Program elements band (§7.1.2).
- **What the UI needs:** each card shows the PE code, program name, the
  PB → Auth → Approp progression, a per-card delta chip, **a client-attribution
  footer**, and the section header shows a **net portfolio delta** summed across
  clients.
- **What exists:** `GET /api/program-elements?watched=true` returns per-PE
  budget figures (`latestRequest`, `latestEnacted`, `latestCurrent`, `deltaPct`,
  stage claims) — everything the per-PE card needs. This is the same source the
  client-level "Relevant budget programs" card uses.
- **What's missing:** a join from watched PEs to the clients they fund, and a
  summed net delta across the portfolio. The watch list is per-PE; no
  client-attribution or portfolio-aggregate endpoint exists.
- **Evidence of absence:** `programs.controller.ts` exposes list / match-queue /
  alias / merge routes only; `PortfolioProgramElementsSection.tsx` (the existing
  canonical widget) reads the watch list and per-PE action counts, with no
  cross-client aggregate. Greped `apps/api/src` for a portfolio-level PE
  aggregate — none.
- **Shipped instead:** the cards render the real per-PE PB → Auth → Approp
  progression and delta chip. The client-attribution footer and net-portfolio
  delta chip are omitted (a missing figure renders `—`, never `$0`, per §7.1.2).
- **Blocking?** No.
- **Estimated backend surface:** 1 endpoint joining watched PEs to clients
  through the existing relevance mapping, plus a summed delta.
- **Owner:** unassigned

### G3 — Per-row attention / readiness / next-touch would need N+1 calls

- **Module / surface:** Portfolio index → Clients table, Work / Intelligence /
  Attention / Next-touch columns (§7.1 band 3).
- **What the UI needs:** per-client strategy count + readiness, tracked-bill and
  funding-match counts, an open-attention count, and the next scheduled
  client-facing event — for every row.
- **What exists:** each value has a per-client endpoint
  (`/strategy-api/strategies`, `/api/intelligence/clients/:id/health-score`,
  `/api/funding-opportunities/clients/:id/opportunities/summary`,
  `/api/engagement/meetings`). None has a portfolio-scoped, all-clients form.
- **What's missing:** a single portfolio-scoped aggregate returning those four
  columns keyed by client. Assembling them per row is the N+1 the handoff
  explicitly forbids ("ship the list without that column rather than firing
  eight requests per page load", §7.1).
- **Evidence of absence:** the named controllers expose only `:clientId`-scoped
  routes; no `…/portfolio` or tenant-wide variant. Verified in
  `intelligence.controller.ts`, `funding-opportunities.controller.ts`,
  `engagement.controller.ts`, `api-strategy/strategy.controller.ts`.
- **Shipped instead:** the table renders Client, Status, Focus and Owner (all
  available from the existing `/api/clients` list). The Work / Intelligence /
  Attention / Next-touch columns are omitted, and the Attention sort falls back
  to name so the control never lies.
- **Blocking?** No.
- **Estimated backend surface:** 1 aggregate endpoint (e.g.
  `GET /api/intelligence/portfolio/client-rollup`) returning the four columns
  per client in one query.
- **Owner:** unassigned

---

## Explicitly checked and NOT gaps

- **Import with LDA (§7.1.1).** The full propose → review → explicit-apply
  contract exists: `GET /api/firm/lda-registrants`, `GET /api/firm/import-candidates`,
  `POST /api/firm/import` (`firm-onboarding.controller.ts:43/59/64`,
  `user_admin`-gated apply). The handoff flagged this as "almost certainly needs
  work" — it does not.
- **Legacy deep links (§6.1).** All eight legacy `?tab=` values resolve and are
  covered by `client-crm-routing.test.ts`.
- **Work ⇄ Strategies node writes (§7.7).** `PATCH
  /strategy-api/strategies/:id/nodes/:nodeId` exists
  (`api-strategy/strategy.controller.ts:72`); the Work tab is a projection with
  no CRM-side task store.
