# Phase 8 Session 7 — Closeout Handoff

**Prepared:** 2026-08-20
**Repository:** `neo-capiro/capirov2`
**Base `main` at session start:** `c4e4a676955838d764d2360f90d7446f7a0cef2f` (Session 6 merge; verified, no drift)
**Session 7 branch:** `agent/phase8-session7-lifecycle-source-watcher`
**Final Session 7 HEAD:** `53c8e765c8cd4132880a9cdc215928b68fa9e41e`
**PR:** [#1144](https://github.com/neo-capiro/capirov2/pull/1144) — **DRAFT, not merged**
**Workstream:** J — Annual Defense Budget Cycle Controller + Defense Budget Lifecycle Watcher

---

## 1. Final verdict

```text
SESSION7_COMPLETE
READY_TO_MERGE_SESSION7   (awaiting separate explicit authorisation)
```

Session 7 is control-plane/lifecycle automation. It is dark: no HTTP route, no
schedule, no production ownership change, no snapshot promotion, no GPU, no AWS
or production data mutation.

## 2. Files changed

45 files, +10,811 / −12.

```text
apps/api/prisma/migrations/20261120230000_phase8_session7_budget_cycle_lifecycle/migration.sql
apps/api/prisma/schema.prisma                       (7 models + SourceDocument back-relation)
packages/defense-domain/src/budget-lifecycle/       (types, templates, cycle, classifier,
                                                     watcher, signals, progression, health)
packages/defense-contracts/src/public/budget-lifecycle.ts
apps/defense-api/src/budget-lifecycle/              (controller, watcher, adapter registry,
                                                     ports, Prisma store, manifest discovery,
                                                     HTTPS fetch, cycle health, module, spec,
                                                     in-memory store + fixture ports)
apps/defense-api/scripts/run-lifecycle-watcher.mjs
scripts/{verify,test,prepare}-phase8-session7-*      (static gate, domain gate, corpus, replay,
                                                     DB rehearsal)
docs/defense-budget/phase8-session7-lifecycle-{design.md,corpus.json,replay-evidence.json}
.github/workflows/phase8-session7-lifecycle-watcher.yml
```

## 3. Cycle controller

| Requirement | Status |
|---|---|
| Overlapping FY support | Identity is `(fiscalYear, authorityTrack)`, UNIQUE in the DB. FY27/FY28/FY29 coexist; a second cycle on the same pair is refused. |
| Automatic bootstrap | `bootstrapFiscalYearCycle` builds all 5 tracks for any FY. **FY2028 → 5 cycles / 82 expected sources**, no bespoke manifest. `bootstrapRollingHorizon` moves with the clock; `bootstrapCycleFromFirstDiscovery` covers a first source for an unseen FY. |
| Source-family templates | `defense_budget_cycle_template_v1` — versioned, no URLs, no amounts. Covers all required PB exhibit families per component (ARMY/NAVY/AF/SF/DW), authorization, appropriations, alternative funding and supported execution families. |
| Missing / not-filed handling | `expectedSourceFundingPosition` has **no numeric branch**. Optional past-window → `not_filed`; required past-window → `review_required`. No Session 7 table has a monetary column (measured 0 against `information_schema`). DTO exposes `knownFundingPosition: null`. |

## 4. Watcher

| Requirement | Status |
|---|---|
| Official adapters | 14 registered, all `authoritative: true`, all `requiresGpu: false`: DoD Comptroller (+reprogramming), Army, Navy/USMC, SAF-FM (AF/SF), GovInfo committee-reports / bills / public-laws, Congress.gov, HASC, SASC, House & Senate Appropriations, DoD contract announcements. A URL not on the requesting adapter's own official host is refused. |
| First discovery | Classified, versioned, queued — verified on real HASC/SASC/HAC-D/SAC-D/bill/public-law sources. |
| Unchanged no-op | No observation, no version, no ingestion, no parser cost. A 304 retains the prior SHA rather than becoming the identity. |
| Changed SHA versioning | New observation, prior version superseded. |
| Supersession | Prior version marked `superseded`, never deleted, original bytes intact. Job role has no DELETE on any control-plane table. |
| Ambiguous review | Stores NULL track/stage, must carry a reason, cannot be enqueued; an already-queued observation cannot be pushed back into review. |
| Retry / crash safety | Single-owner adapter lease in one atomic statement; expiry lets a second worker resume a crashed run. |
| Concurrency / idempotency | UNIQUE `(expected_source_id, content_sha256)` and UNIQUE `(observation_id, job_kind)` with `ON CONFLICT DO NOTHING`; CHECK `queued_count <= changed_count`. |

## 5. Historical replay — real official sources

`SESSION7_LIFECYCLE_REPLAY_PASS (61 checks)`. 11 official sources downloaded and
hashed at prepare time (bytes are never committed; workdir is gitignored).

```text
PB           FY2024 DoD Budget Request Overview   comptroller.defense.gov   sha bb7f61e61dad…
House cmte   CRPT-118hrpt125 (HASC)               govinfo                   sha 5f777aa98b42…
Senate cmte  CRPT-118srpt58  (SASC)               govinfo                   sha 20a0aa5b70a6…
House action BILLS-118hr2670rh (reported)         govinfo                   sha 59fd96a8097f…
   revision  BILLS-118hr2670eh (engrossed)        govinfo                   sha a3a8026a7d77…
Enacted      PLAW-118publ31 (NDAA FY2024)         govinfo                   sha a8354786883a…
HAC-D        CRPT-118hrpt121                      govinfo                   sha daeddc2215ae…
SAC-D        CRPT-118srpt81                       govinfo                   sha d00a6d5c3b16…
Omnibus (no defence division) PLAW-118publ42      govinfo                   sha eddb25e8906b…
Omnibus (defence division)    PLAW-118publ47      govinfo                   sha 0e6eef8689e4…
Supplemental PLAW-118publ50                       govinfo                   sha baa093f0ae9b…
```

- Corrected/revised source: the publisher's **own** version chain, `rh` → `eh`,
  detected as `superseding_version`; the superseded row keeps its original bytes.
- `recomputeScopeForCorrection` recomputes only the corrected stage and later
  stages on the same track; earlier stages and the other track are returned
  explicitly untouched.
- Appropriations ran independently of authorization: an enacted NDAA did not
  advance, close or overwrite the appropriations track.

## 6. Alternative funding

PL 118-50 classified onto `alternative_funding` / `emergency_supplemental` and
routed to `governed_alternative_funding_ingestion`. **Fabricated dollars: NO** —
the route object carries `fabricatesDollars: false`, no discovery outcome has an
amount field, and the annual authorization/appropriations tracks were untouched.

## 7. Database

- **Rehearsal:** `SESSION7_DB_REHEARSAL_PASS (63 checks)` from a zero-state
  PostgreSQL 16, full migration ledger applied from scratch.
- **Negative controls:** ambiguous source cannot be queued; lying about the
  observation state fails the composite FK; a queued observation cannot be moved
  into review; identical bytes twice refused; concurrent duplicate job refused;
  adapter cannot declare or be flipped to a GPU dependency; signal refuses a
  funding key at top level and nested; run cannot queue more than it observed;
  self-supersession refused; fabricated `source_document` refused; no monetary
  column exists (measured 0).
- **Role boundary:** serve = SELECT only across all seven tables; job =
  SELECT/INSERT/UPDATE, no DELETE, no DDL; no Session 7 role gained promotion or
  snapshot-activation authority.
- **Drift:** zero structural drift on the seven new tables (only the same
  cosmetic FK-name renames the accepted Session 6 tables show).

## 8. Regressions — all fresh on this exact candidate

```text
S2  SESSION2_BOUNDARY_PASS
S3  SESSION3_BOUNDARY_PASS — 49 frozen routes, exact method/path/role match
S3  admin boundary PASS — 5 governed mutations
S4  SESSION4_SOURCE_PARITY_PASS (--enforce-replay) + SESSION4_IMAGE_CONTAINMENT_PASS (8/8)
S5  SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED
S6  SESSION6_FEDERAL_FUNDING_FOUNDATION_PASS + domain 9/9
S7  SESSION7_LIFECYCLE_CONTROL_PLANE_PASS + domain 57/57 + spec 32/32
    + replay 61/61 + DB rehearsal 63/63
Prisma: apps/api validate PASS + generate PASS; defense-api validate PASS
git diff --check: clean
```

GitHub Actions remains externally unavailable repo-wide (startup failures since
2026-07-31). A workflow that never starts is neither pass nor code failure;
everything above was run locally on the exact candidate.

## 9. Safety statement

```text
AWS mutated:                    NO
Production DB mutated:          NO
Production schedules changed:   NO
Production routes changed:      NO   (Session 3 surface still exactly 49 routes)
Snapshot promoted or activated: NO
NVIDIA restarted:               NO   (no endpoint, no transform job, no spend)
Deterministic parser default:   UNCHANGED (DETERMINISTIC_PRIMARY)
Session 8 started:              NO
```

## 10. Bugs found and fixed while building this

1. **Template/classifier vocabulary mismatch.** The classifier could resolve a
   real emergency supplemental to `emergency_supplemental`, but no template
   created an expected source for that stage, so the dedup key matched nothing
   and the watcher blocked the candidate. Added the template entry **and** a gate
   asserting every stage the classifier can emit has somewhere to land.
2. **Session 3 boundary violation introduced by Session 7.** The watcher service
   read an NVIDIA-named env var; the frozen boundary forbids `defense-api` from
   naming a GPU provider. The provider-routing read now lives in
   `defense-domain`, with provider-neutral aliases on the execution contract.
3. **Verifier matched its own prose.** Five prohibition checks failed on the doc
   comments asserting the very thing they check. The verifier now strips comments
   before prohibition checks (requirement checks still read the full text).
4. **Prisma id-default drift.** `@default(uuid())` against a SQL
   `gen_random_uuid()` default drifts on every id column. Switched to
   `dbgenerated`, and the verifier now requires it — this is what took the seven
   new tables to zero structural drift.
5. **Latent CI bug shared with Session 6.** The "Defense Prisma validation" step
   had no `DATABASE_URL` and could never have passed. Fixed in the Session 7 and
   Session 6 workflows.

## 11. Traps worth carrying forward

- **GovInfo serves `Last-Modified` but no `ETag`** on its PDF packages. A
  validator-first design is blind on the sources that matter most; the content
  SHA has to be the identity.
- **GovInfo answers a missing `.htm` rendition with HTTP 200** and a
  "Page Not Found" body (~19 KB). Feeding that to a classifier looks like
  document text. Both the fetch adapter and the corpus preparer detect it.
- **GovInfo interjects `NOTE:` inside division headings**, e.g.
  `DIVISION A-- NOTE: Department of Defense Appropriations Act, 2024`. A naive
  division regex misses it.
- **An "ambiguous omnibus" scenario cannot be faked by hiding evidence.** PL
  118-47's own text proves its defence division, so withholding it was
  dishonest; the real ambiguity case is PL 118-42, a genuine FY2024 omnibus with
  no defence division. The corpus preparer now asserts claimed-absent phrases
  really are absent, not just claimed to be.
- **Real committee reports do not always state a fiscal year.**
  `CRPT-118hrpt121` (HAC-D) has no "fiscal year" phrase in its front matter at
  all; the FY comes from "DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024".
- `.session7-lifecycle/` is gitignored: official source bytes and the prepared
  corpus are materialised locally, never committed.

## 12. Open items for Session 8+

1. **Live discovery adapters.** Session 7 ships a manifest-driven discovery port.
   Per-publisher index-page/API crawling with rate limiting is dark-deployment
   infrastructure work. The manifest adapter already enforces the official-host
   rule a live crawler must obey, so this swap changes where candidates come from
   and nothing about the decisions taken around them.
2. **Review resolution workflow.** A `review_required` observation deliberately
   does **not** auto-advance on re-observation — verified in the replay. Draining
   the review backlog is a human/review action; Session 7 builds the backlog and
   the read model, not the resolution UI (Session 11).
3. **Cycle closeout criteria.** `defense_budget_cycle.status` supports
   `draft | active | closed` and closing requires `closed_at`, but governed
   closeout criteria and the reopen-on-correction workflow are not implemented.
4. **Execution-track coverage is thin by design.** `exec_allocation`,
   `exec_obligation` and `exec_award` are registered as optional families with a
   reference-only posture. Only what an official public source supports.
5. **Session 7 tables are intentionally absent from the curated `defense-api`
   HTTP Prisma subset** (same precedent as Session 6). The store uses
   parameterised raw SQL. Adding them is part of the HTTP/product cutover, not
   this session.
6. **`MAP_STYLE_ATTRIBUTION`** still needs its real value restored — carried
   forward from the Engagement vNext session, unrelated to Phase 8.

## 13. Commands

```bash
# Domain + control loop
node scripts/test-phase8-session7-lifecycle-domain.mjs
pnpm --filter @capiro/defense-api exec tsx --test src/budget-lifecycle/lifecycle-watcher.spec.ts

# Real official sources: materialise, then replay
node scripts/prepare-phase8-session7-lifecycle-corpus.mjs
node scripts/phase8-session7-lifecycle-replay.mjs \
  --out docs/defense-budget/phase8-session7-lifecycle-replay-evidence.json

# Gates
node scripts/verify-phase8-session7.mjs --enforce-replay
node scripts/verify-phase8-session7-db.mjs

# Governed watcher command (dry run by default)
cd apps/defense-api
node scripts/run-lifecycle-watcher.mjs --list-adapters
node scripts/run-lifecycle-watcher.mjs --bootstrap --fiscal-year 2028
PHASE8_SESSION7_COMMIT_AUTHORIZED=true \
  node scripts/run-lifecycle-watcher.mjs --adapter govinfo-bills --manifest <path> --commit
```

**Do not merge until separately authorised.**
