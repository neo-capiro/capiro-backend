# Phase 8 Session 3 — Workstream E Handoff (consolidated)

## Repository / branch / PR

- Repository: `neo-capiro/capirov2`
- Branch: `agent/phase8-session3-consolidated`
- Consolidated head: the tip of this branch (this doc is the last commit on it; see
  the PR for the exact SHA and the commit table below for everything beneath it)
- `origin/main` integrated: `aa7bda236972548583da4a44d34d750191c4600d`
- PR: opened against `main` as a REPLACEMENT for #1044 — **DRAFT, unmerged, by design**

### Why this branch exists

Session 3 was implemented **twice, concurrently**, by two agents on the same branch.
This branch is the consolidation, and it is the one to review:

| | Branch | Head | State |
|---|---|---|---|
| Functional base | `agent/phase8-session3-workstream-e-gated` | `b22b3f059` | every gate executed and green |
| Security source | `agent/phase8-session3-program-elements-repair` (PR #1044) | `cc69f43e6` | own verdict `ACCEPTANCE_BLOCKED`; independently confirmed: `typecheck` fails, parity suite cannot load |

The consolidation takes the gated branch's tested business implementation as the
base and ports **only** the governed-admin security boundary out of #1044. #1044's
overlapping rewrite of the Program Elements / Budget Lines / funding / timeline /
provenance read services is deliberately NOT taken.

Neither original branch was force-pushed or deleted. Both are preserved on the
remote, plus explicit pre-consolidation backups:

- `backup/phase8-s3-gated-pre-consolidation` → `b22b3f059`
- `backup/phase8-s3-repair-pre-consolidation` → `cc69f43e6`
- `backup/phase8-s4-pre-restack` → `cb93e236a`

### Commits on this branch beyond the gated base

| SHA | Subject |
|---|---|
| `0342e55c2` | `security(defense): governed Program-graph admin boundary, ported from PR #1044` |
| `5b8597016` | `test(defense): follow the parity contract into the governed SQL layer` |
| `5a99526ec` | `test(defense): correct three real defects in the governed-admin rehearsal checks` |
| `5d936facc` | `test(defense): differentiate the curated-seed fixture by project_code` |
| `86432926a` | `test(defense): the merge regression now needs a real capiro_admin membership` |
| `2383cfe18` | `Merge origin/main (aa7bda236) — 0 conflicts` |

Gated-base commits (unchanged, inherited): `5cc68abaf`, `c53e99312`, `14e709d3a`,
`b4ae8f1a1`, `b22b3f059`.

---

## Verdict

**SESSION3_COMPLETE.**

Every gap the independent review itemized is closed; the governed-admin boundary
from #1044 is in place and proven against a real database; `origin/main` is
integrated; and the full acceptance suite passes on the exact consolidated SHA
recorded above.

Deviations from `apps/api` are deliberate, few, and listed under
**Stated deviations** below rather than folded into a clean bill of health.

---

## Governed Program-graph admin boundary (ported from PR #1044)

This is the one piece of the concurrent branch worth keeping, and it closes a real
hole rather than adding ceremony.

**The problem.** The preceding dark migration granted `capiro_defense_serve` direct
`INSERT`/`UPDATE`/`DELETE` on the GLOBAL Program graph — `program`, `program_alias`,
`pe_program_match`, `person_role`, `program_office_program_link`,
`provision_pe_link`. Those tables carry no `tenant_id` and no RLS, so the only thing
between an authenticated request and a global mutation was the application's own
role check. One handler missing `@Roles('capiro_admin')`, one guard regression, or a
compromised HTTP task was enough.

**Now.** `capiro_defense_serve` is `SELECT`-only on all six. Every mutation runs
inside a fixed-shape `SECURITY DEFINER` function that re-checks an **ACTIVE**
`capiro_admin` membership in the database, independently of the application:

| Function | Route |
|---|---|
| `capiro_defense_resolve_program_match` | `POST /programs/admin/match-queue/:id/resolve` |
| `capiro_defense_create_program_alias` | `POST /programs/admin/:programId/aliases` |
| `capiro_defense_update_program_alias` | `PATCH /programs/admin/aliases/:id` |
| `capiro_defense_delete_program_alias` | `DELETE /programs/admin/aliases/:id` |
| `capiro_defense_merge_programs` | `POST /programs/admin/merge` |

Each: scalar parameters only (no caller-supplied SQL), fully-qualified object names
under `SET search_path = ''`, revoked from `PUBLIC` **and** from the job role,
granted to `capiro_defense_serve` alone. `capiro_defense_require_admin` is an
internal helper the serve role cannot call — it is not a membership oracle an HTTP
request can aim at a tenant.

**Two improvements over #1044's version.**

1. `require_admin` **saves and restores** `app.bypass_rls` instead of leaving it on.
   The original sets it and returns, so it stays on for the remainder of the
   caller's transaction — any later read in that request would run with RLS
   bypassed. Restoring confines the widening to the membership check itself.
2. The governed call runs **outside** a transaction. The function authorizes from
   its own parameters and needs no tenant GUC, so the transaction-local setting
   cannot outlive the single statement.

**Where validation lives.** TypeScript keeps the alias-type allowlist, the
generic-label stoplist, `normalizeAlias`, duplicate detection, the
last-canonical-alias guard and the merge input checks, so HTTP error semantics stay
apps/api's. The functions repeat the curated-MDAP-seed and last-canonical refusals
as defence in depth. Merge semantics are unchanged from the gated implementation —
including that a colliding alias stays with the retired loser (apps/api's
behaviour), which the DB regression test pins.

**#1044's audit bug, fixed for real.** `audit_logs` has `occurred_at` and **no**
`created_at`, so that branch's first migration would have failed outright on every
governed write; its follow-up migration corrected the column. Rather than trust the
fix, the rehearsal asserts `created_at` does not exist and that the governed write
lands exactly one row with `occurred_at` populated.

### Proof, not description

`verify:phase8-session3:admin` is a new permanent STATIC gate: for all five
functions it checks `SECURITY DEFINER`, the locked empty `search_path`,
schema-qualified names, absence of dynamic SQL, the grant/revoke shape, and that
**no Prisma DML on the six graph tables remains anywhere in `apps/defense-api`**.

The authoritative half is in the disposable-DB rehearsal, which reads the ACTUAL
granted privileges out of `information_schema` and executes the real cases as the
real roles — SQL formatting cannot make that pass:

| Proof | Result |
|---|---|
| serve holds exactly `SELECT` on all six graph tables, nothing more | PASS |
| all five functions SECURITY DEFINER + `search_path` locked + serve-only (job, PUBLIC denied) | PASS |
| `require_admin` not callable by serve | PASS |
| `standard_user` actor refused, and the row is unchanged afterwards | PASS |
| **inactive** `capiro_admin` membership refused | PASS |
| admin of a **different tenant** refused | PASS |
| `capiro_admin` actor succeeds; notes trimmed | PASS |
| audit row written to `occurred_at`; `created_at` proven nonexistent | PASS |
| merge retires (never deletes) the loser and repoints its alias | PASS |
| re-merging an already-merged program refused | PASS |
| curated MDAP seed cannot be rejected, remains idempotently acceptable | PASS |
| direct DML by serve refused on all six tables | PASS |
| serve retains `SELECT` (writes removed, reads intact) | PASS |

`programs-admin-security.integration.spec.ts` additionally drives the real
`ProgramsService` against the real serve login and asserts the HTTP contract: a
`ForbiddenException` with status 403, not a 400 or a 500.

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

## Gate results — every command re-run on the consolidated tip

Repository CI is still in repo-level `startup_failure`, so every gate below was
executed locally against real PostgreSQL containers and a real `docker build`. No
result is carried over from an earlier tip.

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
| `pnpm --filter @capiro/defense-api test` (no DB) | **PASS** — 43 pass / 0 fail / 8 skipped (DB-gated) |
| `pnpm --filter @capiro/defense-api build` | **PASS** |
| `pnpm verify:phase8-session2` | **PASS** — `SESSION2_BOUNDARY_PASS` |
| `pnpm verify:phase8-session2:db` | **PASS** — `SESSION2_DB_REHEARSAL_PASS` (36 checks) |
| `pnpm verify:phase8-session3` | **PASS** — `SESSION3_BOUNDARY_PASS` · **49/49** routes |
| `pnpm verify:phase8-session3:admin` | **PASS** — `SESSION3_ADMIN_BOUNDARY_PASS` · 5 governed mutations |
| `pnpm verify:phase8-session3:parity` | **PASS** — **52/52** |
| `pnpm verify:phase8-session3:db` | **PASS** — `SESSION3_DB_REHEARSAL_PASS` (86 checks) |
| `docker build --no-cache -f apps/defense-api/Dockerfile …` | **PASS** (exit 0) |
| Image runs non-root | **PASS** — `id -u` = `1001` |
| Image fail-closed smoke (no secrets) | **PASS** — nonzero exit; `DATABASE_URL is required; CLERK_SECRET_KEY is required` |
| `git diff --check` | **PASS** |

`@capiro/shared` must be built before `@capiro/defense-domain`; the list above is in
dependency order. The DB rehearsals also hand off to the full defense-api suite at the end, which is
where the 8 DB-gated specs actually execute: **57 pass / 0 fail** under both
rehearsals, versus 43 pass + 8 skipped when run offline.

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
| `response-contract-parity` | A required-field inventory for ~35 representative routes, a no-unconditional-stub check, and uniform `requirePeCode` normalization |
| `security-and-error-parity` | Admin gating vs the frozen contract; guard-chain order; tenant-transaction coverage; 404/400/409; no promoter/parser/GPU/DDL authority |
| `pb-comparison-parity` | (pre-existing) PB-comparison money/shape |

`response-contract-parity` asserts each required field is present in **apps/api
first**, so the inventory cannot drift into testing a fiction — if apps/api gains a
field defense-api lacks, the apps/api assertion passes and the defense-api one fails,
which is the direction that matters. This is the check a fixture test structurally
cannot make: the regression being repaired was field **absence**, and a fixture test
passes happily against a response missing ten fields.

Where a route's behaviour legitimately moved into the governed SQL layer, the
contract entry names the boundary migration as an additional source, so the
requirement still has to be met — it followed the behaviour rather than being
relaxed. Tokens that exist only in SQL are listed explicitly as governed-only so the
apps/api-side assertion skips them and nothing else.

The conference forecast is the one comparison that cannot import both sides — the pure
model sits inside a Nest service that imports `@prisma/client` at module scope, and
apps/api's Prisma client is not generated in this workspace. Making a permanent gate
depend on generating a multi-megabyte client to reach one pure function is the wrong
trade, so that suite establishes parity by source identity plus behaviour and says so.

### Defects the gates caught, and what they say about the gates

Every one of these was found by RUNNING a gate, not by reading code. Three were in
the gates themselves, which is worth stating plainly rather than quietly fixing:

**In the implementation:**
- The Dockerfile never built `@capiro/shared`, which `defense-domain` now depends on.
  With no `dist` present its types resolved to nothing and `tsc` failed on the derived
  interfaces — a local build had passed only because `dist` already existed.
- The runtime stage shipped `auth`'s `node_modules` but not `defense-domain`'s. The
  image built and started far enough to load `main.js`, then died on the first
  `require('@capiro/shared')`.
- A plain `GRANT SELECT ON context_embeddings` cannot work at all: that table's
  FORCE-RLS policy references the CRM's `clients` / `client_memory_access`, and
  PostgreSQL requires privileges on every table a policy expression touches. Found by
  the rehearsal, not by review.

**In the gates:**
- The step-9 `person_role` check asserted the serve role CAN write it — true before
  the governed boundary, deliberately false after. The check was stale, not the
  migration.
- The `search_path` assertion never matched a correctly-locked function: PostgreSQL
  stores `SET search_path = ''` in `pg_proc.proconfig` as the literal
  `search_path=""`, quotes included.
- Two rehearsal fixtures were invalid against the real schema — `status='inactive'`
  is not a `MembershipStatus` (the enum is `invited`/`active`/`removed`), and the
  curated-seed match collided with an earlier row on
  `(pe_code, project_code, program_id)`.

The per-table and per-function privilege probes were also collapsed from 26 `psql`
round-trips into 3 batched queries. Each call goes through the docker-exec shim at
roughly 15 seconds, which had made this permanent gate impractical to run; the
assertions still read actual privileges out of `information_schema` and `pg_proc`
rather than trusting SQL text.

---

## Security posture

Explicitly, for the HTTP runtime:

| Capability | Held? |
|---|---|
| Promoter credentials (`capiro_pe_promoter`, `DEFENSE_PROMOTER_*`) | **No** |
| Snapshot activation / canonical promotion reachability | **No** |
| DDL authority | **No** |
| Generic bypass-RLS (`app.bypass_rls`, `withSystem`) in executable code | **No** |
| Parser credentials | **No** |
| GPU / NVIDIA credentials | **No** |
| Write access to `conference_probability` | **No** — enforced by the absence of a grant, not only by code |
| Direct read of `context_embeddings` | **No** — two global-scoped SECURITY DEFINER readers instead |
| **Direct DML on the global Program graph** | **No** — SELECT-only; every mutation is a governed, DB-rechecked function |
| PE→BLIN / PE→BLI identity coercion | **No** |

Grants for `capiro_defense_serve`, all in this branch's own **unmerged** migrations and
applied only to disposable rehearsal containers:

- `SELECT` on `program_element_detail_mv`, `program_element_acquisition_program`,
  `conference_probability`, `budget_action`, `capability`,
  `capability_budget_line_match`
- `SELECT` **only** on `program`, `program_alias`, `pe_program_match`, `person_role`,
  `program_office_program_link`, `provision_pe_link` — the governed-admin migration
  revokes the DML the earlier migration had granted, and the rehearsal asserts the
  privilege set is exactly `SELECT` by reading `information_schema.table_privileges`
- `EXECUTE` on the two PE-vector readers and the five governed Program-graph mutations,
  revoked from `PUBLIC` and from `capiro_defense_job`
- `INSERT, UPDATE` (never `DELETE`) on `defense_budget_manual_override`; the
  tenant-scoped overlay tables keep their DML because they carry `tenant_id` + RLS

`capiro_defense_require_admin` is granted to **nobody** — not even the serve role. It
is an internal helper for the five mutation functions, not a membership oracle a
request can aim at a tenant.

---

## Mutation statement

| | |
|---|---|
| Merge performed | **No** — the replacement PR is draft; #1044 and #1035 untouched |
| AWS mutation | **No** |
| Production / shared DB migration | **No** — disposable rehearsal containers only, destroyed on exit |
| Production data mutation | **No** |
| Traffic / routing mutation | **No** |
| Schedule (EventBridge) mutation | **No** |
| IAM mutation | **No** |
| Secret mutation | **No** |
| Snapshot activation | **No** |
| Canonical promotion | **No** |
| NVIDIA / GPU runtime introduced | **No** |
| Session 5 started | **No** |
| Force-push over either existing branch | **No** — backups pushed first regardless |
| Either existing branch deleted | **No** |

`apps/api` remains the sole production owner of all 49 routes. Nothing under
`apps/api/src` was modified; the only `apps/api` changes are branch-local, unmerged
migration SQL files.

---

## Next step

Session 4 — Workstream F. Its existing work lives on `agent/phase8-session4-runtime-move`
(draft PR #1035, head `cb93e236a`, backed up as `backup/phase8-s4-pre-restack`) and is
restacked on this consolidated Session 3 rather than recreated.

Three things from this session that the restack depends on:

- Session 4's `SESSION4_SOURCE_PARITY` gate byte-compares nine
  `defense-budget/**/__fixtures__/*.json` slices between `apps/api/src` and
  `apps/defense-api/runtime-source`. None of those files are touched by the `main`
  merged here, so the comparison survives integration.
- This branch's Dockerfile already satisfies all four Session 4 containment checks
  (named `AS runtime` stage, `USER capiro`, copies the compiled `dist` boundary,
  `PNPM_PACKAGE_IMPORT_METHOD=copy`, no wholesale `packages/auth` copy). The restack
  must keep this branch's version, which additionally builds `@capiro/shared` and ships
  `packages/defense-domain/node_modules` — dropping either breaks the image at
  `require` time, not at build time.
- `apps/defense-api/package.json` must keep BOTH this branch's `@capiro/shared`
  dependency and Session 4's `verify:session4` script at its exact expected value —
  the Session 4 verifier asserts that string literally.

- The Phase 7 snapshot read gate is the natural first piece of Workstream F, and
  deviation 3 above is exactly its scope.
- `@capiro/defense-domain/pe-read` is where pure defense logic goes. Session 4's
  verification, projection-planning and certification helpers should land beside it
  rather than being re-implemented inside `apps/defense-api`.
