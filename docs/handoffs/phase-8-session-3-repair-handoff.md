# Phase 8 Session 3 — Workstream E Handoff

## Repository / branch / PR

- Repository: `neo-capiro/capirov2`
- Branch: `agent/phase8-session3-program-elements-repair`
- Base SHA (`origin/main` at this tip): `91aa1bd79eecce5646d49a4a45e34257f667ef9e`
- Prior head (inherited): `ae0712b63c1a1fca03c1522c0ac7539012316af8`
- PR: https://github.com/neo-capiro/capirov2/pull/1044 — **DRAFT, unmerged, by design**

`main` advanced from `b00c9e301` to `91aa1bd79` during this session (Meri vNext / web
only — nothing under `apps/api/src/program-element`, `apps/defense-api` or the defense
packages). No rebase was needed and none was performed; the branch is still a clean
fast-forward from `main`.

### Commits added this session

| SHA | Subject |
|---|---|
| `5cc68abaf` | `feat(defense-domain): hoist the PE read-path domain layer into packages` |
| `c53e99312` | `feat(defense-api): widen the curated Prisma boundary to the real read contract` |
| `14e709d3a` | `feat(defense-api): port the real Program Elements business logic` |
| `b4ae8f1a1` | `test(defense): real old-vs-new parity gates, and two Docker defects they exposed` |

Changed-file count for this session's work: **45 files** (17 modified, 28 added).

---

## Verdict

**SESSION3_COMPLETE.**

The prior tip's retraction was correct and its itemized gap list was accurate. Every
item on it is now closed, and closure is enforced by permanent gates rather than
asserted. The three correctness bugs that tip fixed (money canonicalization, the
`fundingField`-scoped open-proposal lookup, merge safety) are preserved with their
regression tests intact.

Deviations from `apps/api` are deliberate, few, and listed under
**Stated deviations** below rather than folded into a clean bill of health.

---

## What was actually wrong, and what it is now

The previous implementation's routing, auth and DB boundaries were sound. The product
behaviour behind them was a reduced re-implementation, not a port.

### Program Element list
Was: 20 base catalog columns from a Prisma `findMany`, `orderBy peCode`.
Now: `apps/api`'s actual enrichment query — detail-MV bill counts, per-row money via
the shared funding SQL helpers, the mark-bearing PE cycle FY
(`sqlCurrentCycleFyExpr`, not catalog-latest request FY), a 6-year sparkline, the
most-material live delta, intelligence-cache facets (`lineType` / `maturity` /
`appropTier` / `appropScore` / signal / valley-of-death), capability filtering through
the auditable accepted-match table, and trigram title relevance ordering.

Every dollar headline is a `FundingClaim`; the enacted-vs-request percent is
matched-pair only (request **at the enacted FY**), so a cross-FY comparison stays
`null` instead of becoming a number. `?mode=markup-monitor` now works — the DTO
accepted it and the controller dropped it, so that whole view silently returned the
ordinary catalog page. Service filters are normalized, so `?service=AIR_FORCE` no
longer returns an empty page.

### PE detail
Added `fundingSummary` (the shared model serializer, before the `years` spread so a
record-safe truncation keeps it), `billCount`, `currentCycleFy`, `projectCount`,
`sourceCount`, the 8 previously-unmodeled base columns, and the bounded 60s detail
cache. The cache holds only tenant-agnostic catalog data; `currentUserIsWatching` is
resolved per request and merged on top, so a cache hit cannot leak watch state
across tenants.

### Timeline
Was raw year rows. Now the full per-year enrichment layer: cycle classification,
`FundingClaim`, the per-stage missing-mark taxonomy (a genuine `$0` is `present`, not
missing), current stage + label + legislative vehicle + signed delta-vs-request, and
the conference forecast. `ConferenceProbabilityReadService` has **no persisting
branch at all** — the read-must-not-write rule is structural, and the database backs
it up with no write grant.

### Budget Lines
`getActions`, `getMovement`, `listCapabilities`, `getCapabilityRecommendations` and
`searchCapabilityLines` were unconditional empty returns. All five are real:
normalized budget actions; the movement payload with its open-cycle-only heatmap,
conference-divergence rows, KPIs and cache anomalies; capability totals pinned to ONE
shared FY with coverage disclosure and no fabricated `$0` claim for an empty
capability; per-capability recommendations with wedge/maturity/appropriability and
both request and current claims.

`getIncumbents` now uses the full 3-tier model (`incumbent` / `performer` /
`candidate`) with high/med/low grading and the symmetric award↔performer merge on one
normalized key. The previous 2-tier split could never emit `performer` at all, which
meant an R-3 named prime with no matched award was silently labelled a *candidate
incumbent*.

### Provenance
`getSources` returns the full citation — `exhibitType`, `publisher`, `snippet`,
`confidence`, `pageEnd`, and the `SourceDocument` (title / budgetCycle / sha256) —
ordered by the shared proof-pack comparator, as a **bare array** (the previous
`{data: […]}` wrapper was a breaking change for every consumer), and 404s on an
unknown PE.

### Programs
`getProgram` regains `awards`, `performers`, `component`, `capabilityArea`,
`acquisitionPathway`, `description`, plus `confidenceBand` / `whyShown` /
`evidenceTier` on matches. `listMatchQueue` treats `status='all'` as *candidate +
quarantined, non-weak* (it previously returned every status, putting already-rejected
matches back in a reviewer's queue) with apps/api's page size. `resolveMatch`
protects curated MDAP seeds and allows idempotent re-resolution (it previously
required `status==='candidate'`, so accept-then-accept was a 400). Alias CRUD enforces
the type allowlist, the generic-accounting-label stoplist, duplicate detection and
the last-canonical-alias guard, and always recomputes `aliasNormalized`.

`mergePrograms` now re-points `person_role`, `program_office_program_link` and
`provision_pe_link` in addition to matches and aliases. Omitting them left those rows
pointing at a retired program, so a merged program's people, offices and committee
report language vanished from every view that joins through them.

### Other routes
`getIntelligence` returns the real posture / runway / maturity / anomaly verdict
instead of cache fields only. Provisions use the shared merge with apps/api's
**byte-identical** attribution caveat (the previous wording was a paraphrase of a
governed attribution statement). Data issues persist `suggestedSourceUrl` — accepted
over HTTP and then discarded, so the column was never populated by this path — and
validate `fy`, `fieldName`, URL, notes and status filters at the **service** layer,
because a DTO protects only the HTTP route and does nothing for an internal caller.
`setWatching` no longer collapses every database error into a 409 with the raw driver
message; only the named legacy constraint is translated.

---

## Cross-domain decoupling (Workstream E gate)

No `apps/api` executable import exists (verified). Cross-domain data is reached three
ways, and no profile route makes a per-row call into `apps/api`:

1. **Read-only projections in defense-api's own Prisma schema** — Congress bills and
   actions, bill↔budget-line links, budget packages, SAM notices and matches,
   committee provisions, USAspending awards, the PE↔acquisition-program crosswalk.
   Each uses only the attribution the **owning** domain already computed and
   persisted.
2. **Two narrow SECURITY DEFINER readers** for PE mission vectors (see the finding
   below).
3. **Two typed, batched ports** in `@capiro/defense-contracts` for the two
   enrichments that need another context's live logic — client↔PE relevance and query
   embedding.

`apps/api` answers the relevance question with up to 50 **sequential per-PE probes**,
each its own transaction. That is exactly the unbounded N+1 fanout the master plan
forbids across a service boundary, so `ClientRelevancePort` takes the whole candidate
set in ONE call. Same answer, different call pattern — recorded as a deliberate
improvement, not a silent change.

---

## Finding worth carrying forward: `context_embeddings` is CRM-coupled

The disposable rehearsal caught this; static review would not have.

`context_embeddings` carries `FORCE ROW LEVEL SECURITY`, and its policy references the
CRM's `clients` and `client_memory_access` tables (the client memory-wall rules).
PostgreSQL requires privileges on **every table a policy expression touches**, so a
plain `GRANT SELECT ON context_embeddings TO capiro_defense_serve` fails on the first
read with `permission denied for table clients` — even against an empty table.

The tempting fix is to also grant the defense HTTP role read access to `clients`. That
would hand the defense plane the CRM's client list in order to serve a similarity
suggestion, which is precisely the coupling this workstream exists to remove.

Instead, two narrow SECURITY DEFINER readers follow the pattern Session 2 established
with `capiro_defense_resolve_member`:

- `capiro_defense_related_pe_vectors(pe_code, model, floor, limit) → (pe_code, score)`
- `capiro_defense_search_pe_vectors(query_vector, model, floor, limit) → (pe_code, score)`

Both are `STABLE` (cannot write), return a fixed two-column shape, and are hard-scoped
to `source_type='pe' AND tenant_id IS NULL` — exactly the GLOBAL partition
`embed-program-elements` writes (`tenantId: null`). `capiro_defense_serve` holds
`EXECUTE` on them and **no grant at all** on `context_embeddings`.

The rehearsal proves the scoping is real, not documented: it inserts a
**tenant-scoped** `pe` embedding with an *identical* vector (it would score 1.0 if
reachable) and asserts the reader does not return it.

Anyone else migrating a read off `context_embeddings` will hit the same wall. It is
not specific to Program Elements.

---

## Stated deviations from `apps/api`

Four, all deliberate:

1. **peCode normalization is uniform.** `apps/api` is internally inconsistent —
   `getIntelligence` / `getProgramsForPe` / the Budget Lines reads normalize, while
   `getProgramElement` / `getTimeline` / `getBills` / `getSources` and most others
   pass the raw route param into `where: { peCode }`. The same code therefore resolves
   on some panels and 404s on others based only on its case. Every peCode-taking
   method here goes through `requirePeCode`. Strictly more permissive; the code is
   still matched exactly against the catalog and no authorization decision keys off
   its spelling.
2. **Client relevance is batched, not probed per PE** (see above).
3. **No Phase 7 snapshot gate.** `apps/api` wraps `getProjects`,
   `getBudgetPositions` and `getPbComparison` in `serveWithSnapshotOptionV1`, which
   can serve from an active canonical snapshot and shadow-compare in the background.
   defense-api serves the legacy side directly. **Today the two are identical**: no
   environment has an active snapshot (`activeSnapshot` is null), so the gate's
   `no_active_snapshot` short-circuit takes the legacy path anyway. Rehoming the
   snapshot read runtime is Workstream F (Session 4), which is where it belongs.
   Flagged so it is not discovered later as an omission.
4. **A colliding alias stays with the retired loser on merge.** This IS apps/api's
   behaviour (`continue`, not delete) and is now matched exactly. Noting it because
   the *previous* defense-api implementation deleted that row — a silent divergence in
   the destructive direction — and the regression test now pins apps/api's version.

---

## Gate results — every command re-run on this tip

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | **PASS** (exit 0) |
| `pnpm --filter @capiro/shared build` | **PASS** |
| `pnpm --filter @capiro/auth build` | **PASS** |
| `pnpm --filter @capiro/defense-contracts build` | **PASS** |
| `pnpm --filter @capiro/defense-domain build` | **PASS** |
| `pnpm --filter @capiro/defense-client build` | **PASS** |
| `pnpm --filter @capiro/defense-api prisma:validate` | **PASS** — schema valid |
| `pnpm --filter @capiro/defense-api typecheck` | **PASS** — 0 errors |
| `pnpm --filter @capiro/defense-api test` (no DB) | **PASS** — 43 pass / 4 skipped (DB-gated) / 0 fail |
| `pnpm --filter @capiro/defense-api build` | **PASS** |
| `pnpm verify:phase8-session2` | **PASS** — `SESSION2_BOUNDARY_PASS` |
| `pnpm verify:phase8-session2:db` | **PASS** — `SESSION2_DB_REHEARSAL_PASS` (36 checks); downstream suite 53/53 |
| `pnpm verify:phase8-session3` | **PASS** — `SESSION3_BOUNDARY_PASS` · **49/49** routes |
| `pnpm verify:phase8-session3:db` | **PASS** — `SESSION3_DB_REHEARSAL_PASS` (**54 checks**, was 31); downstream suite 53/53 |
| `pnpm verify:phase8-session3:parity` | **PASS** — **52/52** (was 2/2) |
| `docker build -f apps/defense-api/Dockerfile -t capiro-defense-api:phase8-session3 .` | **PASS** (exit 0) |
| Image fail-closed smoke (`docker run … serve`, no secrets) | **PASS** — `DATABASE_URL is required; CLERK_SECRET_KEY is required` |
| `git diff --check` | **PASS** |

`@capiro/shared` must be built before `@capiro/defense-domain`; the gate list above is
in dependency order.

### Parity coverage: 2 → 52 assertions

Most compare TWO REAL IMPLEMENTATIONS on identical fixtures — `apps/api`'s own pure
modules against the package copies defense-api runs — so a divergence on either side
fails a gate:

| Suite | What it pins |
|---|---|
| `funding-claim-read-parity` | The claim matrix incl. genuine `$0`, NDAA-only marks, FYDP outyears, negatives, fractional cents, no-cycle-anchor; and that defense-domain's two reachable `buildFundingClaim` exports agree |
| `pe-list-projection-parity` | Field-set + value equality against apps/api's list block transcribed against ITS imports; matched-pair-only percent |
| `pe-timeline-projection-parity` | Per-year enrichment equality; GAI-28 naming (no field may read as a probability); zero-delta is `0`, not `null` |
| `provenance-and-provisions-parity` | Comparator permutation equality; provision merge/rank; the attribution caveat asserted byte-identical to apps/api's source text |
| `budget-lines-and-intelligence-parity` | 3-tier incumbents; intelligence verdict; taxonomy; service-filter aliases; the unicode-dash alias normalizer |
| `conference-forecast-parity` | Source identity of the model + its constants + the `simple-statistics` calls, plus behavioural invariants |
| `response-contract-parity` | A required-field inventory for ~35 representative routes, and a no-unconditional-stub check |
| `security-and-error-parity` | Admin gating vs the frozen contract; guard-chain order; tenant-transaction coverage; 404/400/409; no promoter/parser/GPU/DDL authority |
| `pb-comparison-parity` | (pre-existing) PB-comparison money/shape |

`response-contract-parity` asserts each required field is present in **apps/api
first**, so the inventory cannot drift into testing a fiction — if apps/api gains a
field defense-api lacks, the apps/api assertion passes and the defense-api one fails,
which is the direction that matters. This is the check a fixture test structurally
cannot make: the regression being repaired was field **absence**, and a fixture test
passes happily against a response missing ten fields.

The conference forecast is the one comparison that cannot import both sides — the pure
model sits inside a Nest service that imports `@prisma/client` at module scope, and
apps/api's Prisma client is not generated in this workspace. Making a permanent gate
depend on generating a multi-megabyte client to reach one pure function is the wrong
trade, so that suite establishes parity by source identity plus behaviour and says so.

### Two real defects the gates caught

Both introduced by this session's own work, both fixed here:

- The Dockerfile never built `@capiro/shared`, which `defense-domain` now depends on.
  With no `dist` present its types resolved to nothing and `tsc` failed on the derived
  interfaces — a local build passed because `dist` was already there.
- The runtime stage shipped `auth`'s `node_modules` but not `defense-domain`'s. The
  image built and started far enough to load `main.js`, then died on the first
  `require('@capiro/shared')`.

---

## Security posture

Explicitly, for the HTTP runtime:

| Capability | Held? |
|---|---|
| Promoter credentials (`capiro_pe_promoter`, `DEFENSE_PROMOTER_*`) | **No** |
| Snapshot activation / canonical promotion reachability | **No** |
| DDL authority | **No** |
| Generic bypass-RLS (`app.bypass_rls`, `withSystem`) | **No** |
| Parser credentials | **No** |
| GPU / NVIDIA credentials | **No** |
| Write access to `conference_probability` | **No** — enforced by the absence of a grant, not only by code |
| Direct read of `context_embeddings` | **No** — two global-scoped SECURITY DEFINER readers instead |
| PE→BLIN / PE→BLI identity coercion | **No** |

New grants for `capiro_defense_serve`, all in this branch's own **unmerged** migration
and applied only to disposable rehearsal containers:

- `SELECT` on `program_element_detail_mv`, `program_element_acquisition_program`,
  `conference_probability`, `budget_action`, `capability`,
  `capability_budget_line_match`
- `SELECT, UPDATE` on `person_role`; `SELECT, UPDATE, DELETE` on
  `program_office_program_link`; `UPDATE, DELETE` on `provision_pe_link` — the FK
  re-points a program merge requires, and nothing more (INSERT and DELETE on
  `person_role` are asserted refused)
- `EXECUTE` on the two PE-vector readers

---

## Mutation statement

| | |
|---|---|
| AWS mutation | **No** |
| Production DB migration | **No** — disposable rehearsal containers only, destroyed on exit |
| Production data mutation | **No** |
| Traffic / routing mutation | **No** |
| Schedule mutation | **No** |
| IAM mutation | **No** |
| Secret mutation | **No** |
| Snapshot activation | **No** |
| Canonical promotion | **No** |
| Merge performed | **No** — PR #1044 remains draft |
| Session 4 / Session 5 touched | **No** |

`apps/api` remains the sole production owner of all 49 routes. Nothing in
`apps/api/src` was modified; the only `apps/api` change is the branch-local, unmerged
migration file.

---

## Next step

Session 4 — Workstream F, on its own branch (`agent/phase8-session4-runtime-move`,
draft PR #1035), which was deliberately not touched. Its gate is that the same real
FY27 inputs replay through the moved code with the same governed decisions and hashes,
except for documented parser-provider identity changes.

Two things from this session that Session 4 will want:

- The Phase 7 snapshot read gate is the natural first piece of Workstream F, and
  deviation 3 above is exactly its scope.
- `@capiro/defense-domain/pe-read` is where pure defense logic goes. Session 4's
  verification, projection-planning and certification helpers should land beside it
  rather than being re-implemented inside `apps/defense-api`.
