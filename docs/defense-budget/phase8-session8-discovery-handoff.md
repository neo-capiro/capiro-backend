# Phase 8 Session 8 — Closeout Handoff

**Prepared:** 2026-08-21
**Repository:** `neo-capiro/capirov2`
**Base `main` at session start:** `9c302d26064a5f82643a722104dd9e3751181859` (Session 7 merge; verified, no drift)
**Base `main` at close:** `c94b688aafd05cb091c0f91e53e686f501b4e1fc` — main advanced during the session (District Nexus Release 1 / PR #1125, Knowledge Plane Phase 26 gates, an os portfolio-alerts fix, and further commits). The branch was **rebased twice** onto the moving tip and every gate below was re-run on the final rebased candidate. Overlaps were purely additive: `apps/api/prisma/schema.prisma` auto-merged both times, `package.json` was a scripts-block conflict resolved by keeping both sides.
**Session 8 branch:** `agent/phase8-session8-live-source-discovery`
**PR:** [#1153](https://github.com/neo-capiro/capirov2/pull/1153) — **DRAFT, not merged**
**Workstream:** K — Live official-source discovery

---

## 1. Final verdict

```text
SESSION8_COMPLETE
READY_TO_MERGE_SESSION8   (awaiting separate explicit authorisation)
```

All fourteen registered adapters resolve to a registered expected source, and all
five authority tracks are reachable through live discovery. The index-page blocker
disclosed in the first pass of this session — nine adapters unable to resolve
anything because the Session 7 classifier required an official package id — has
been **closed**, not documented around. See §9a.

Session 8 replaces Session 7's manifest-driven discovery with real per-publisher
crawling. It is dark: no HTTP route, no schedule, no production ownership change,
no snapshot promotion, no GPU, no AWS or production data mutation. Live crawling
is opt-in twice over and defaults to the offline manifest adapter.

## 2. Scope derivation — read this first

**There is no Phase 8 master handoff document in this repository.** It is not in
`docs/`, not in git history, and not on any branch. Sessions 2–7 each wrote their
own design/handoff in-session; the scope always came from the operator's prompt.

Session 8's scope was therefore taken from the repository's own committed
forward-pointer map, which is consistent across three files written by different
sessions:

| Label | Location | Scope |
|---|---|---|
| **Session 8** | `run-lifecycle-watcher.mjs:130` | "Live per-publisher crawling is dark-deployment work (Session 8), not control-plane logic" |
| Session 9 | `budget-lines-read.service.ts:636` | provider wiring |
| Session 10 | `verify-phase8-session7.mjs:464` | production schedule ownership |
| Session 11 | `cycle-health.service.ts:5` | product/HTTP integration, review-resolution UI |

That map was confirmed with the operator before any code was written.

## 3. Files changed

37 files, +7,460 / −4.

```text
apps/api/prisma/migrations/20261127120000_phase8_session8_live_source_discovery/migration.sql
apps/api/prisma/schema.prisma                     (3 models)
apps/api/tsconfig.phase7.json                     (ambient-types include; see §10.1)
packages/defense-domain/src/budget-lifecycle/discovery/
    robots.ts  rate-limit.ts  sitemap.ts  govinfo-packages.ts
    listing-extract.ts  candidate-resolution.ts  crawl-cursor.ts  index.ts
apps/defense-api/src/budget-lifecycle/discovery/
    publisher-http.port.ts  discovery-audit.port.ts  publisher-crawler.ts
    https-publisher-http.adapter.ts  govinfo-sitemap.crawler.ts
    index-page.crawler.ts  live-source-discovery.adapter.ts
    prisma-discovery-audit.store.ts  live-discovery.spec.ts
    testing/discovery-test-doubles.ts
apps/defense-api/src/budget-lifecycle/budget-lifecycle.module.ts   (opt-in wiring)
apps/defense-api/scripts/run-live-discovery.mjs
scripts/{verify,test,prepare}-phase8-session8-*                    (static, domain, corpus, replay, DB)
docs/defense-budget/phase8-session8-discovery-{design.md,corpus.json,replay-evidence.json}
.github/workflows/phase8-session8-live-source-discovery.yml
```

## 4. Acceptance criteria

| Requirement | Status |
|---|---|
| Live discovery for every discovery mode | `api` runs on GovInfo collection sitemaps (both official JSON APIs answer `API_KEY_MISSING`); `index_page` and `feed` run on real published entry points. All 14 registered adapters route to a crawler. |
| Per-adapter rate limiting | Keyed by **host**, not adapter, because adapters share hosts. Reserved by a single atomic statement. The publisher's `Crawl-delay` wins when stricter — congress.gov's 2 s beats the registry's 1000 ms. |
| Official-host rule | Every emitted candidate passes the frozen `assertAuthoritativeHost`. Redirects are followed manually and host-checked per hop. |
| Candidate → expected-source resolution | Derived from publisher metadata, then required to match a **registered** expected source. Seven outcomes; six are explicit refusals carrying a reason. |
| Cursor-based incremental crawl | Per-collection watermarks, monotonic, inclusive boundary comparison with an emitted-id set. Round-trips through the frozen opaque cursor column. |
| Determinism | No randomness anywhere; backoff is deterministic. Sitemap entries are sorted because the real index is unordered. |
| Bounded and resumable | Hard request budget. A truncated run does **not** advance the watermark and sets `backfillPending`; the shortfall is logged. |
| Fail-closed ambiguity | An unresolved candidate never receives a dedup key. Enforced by a DB CHECK in both directions. |
| Auditable, nothing silently dropped | Append-only row for every request and every candidate decision, emitted or not. |
| No dollars | No monetary column exists in any Session 8 table (measured 0 against `information_schema`). |
| Dark | No route, no schedule, no promotion, no GPU, no AWS. |
| All 14 adapters functional | Every adapter class resolves to a registered expected source; all five authority tracks reachable. Publisher-native kinds close the index-page gap (§9a). |

## 5. Real-source validation

`SESSION8_DISCOVERY_REPLAY_PASS (32 checks)` against live publishers. Bytes are
never committed; `.session8-discovery/` is gitignored.

```text
robots     www.govinfo.gov                     200   sitemap channel allowed, /search/ denied
robots     www.congress.gov                    200   Crawl-delay: 2 -> effective 2000ms
robots     comptroller.defense.gov             403   Akamai; RFC 9309 unavailable, flagged
sitemap    CRPT_sitemap_index.xml              200   unordered at source; sorting is load-bearing
sitemap    CRPT_2023_sitemap.xml               200   497 entries, both S7 committee reports present
sitemap    BILLS_2023_sitemap.xml              200   13,354 entries, full hr2670 version chain
metadata   CRPT-118hrpt125 mods.xml            200   -> authorization / hasc_report
metadata   CRPT-118hrpt121 mods.xml            200   -> appropriations / hac_d_report
metadata   BILLS-118hr2670rh mods.xml          200   -> authorization / house_auth_action
metadata   PLAW-118publ42 mods.xml             200   -> UNRESOLVED (correct)
listing    comptroller.defense.gov/Budget-…    403   refusal recorded as refusal
listing    asafm.army.mil/Budget-Materials/     403   refusal recorded as refusal
listing    armed-services.senate.gov/legisl…    200   reachable, bytes hashed
```

The HAC-D report resolves onto **appropriations** from a title that contains no
"fiscal year" phrase at all — the exact Session 7 trap, now proven through the
live channel. The FY2024 omnibus with no defence division resolves to **nothing**,
and its appropriations-sounding alternative title does not smuggle it onto the
defence appropriations track.

## 6. Database

- **Rehearsal:** `SESSION8_DB_REHEARSAL_PASS (51 checks)` from a zero-state
  PostgreSQL 16, full migration ledger applied from scratch.
- **Negative controls:** an unresolved candidate cannot carry a dedup key; a
  resolved one cannot lack it; an unresolved candidate cannot be marked emitted;
  a 403 cannot be recorded as a successful crawl; an `unreachable` crawl cannot
  carry an HTTP status; a failed crawl must state a reason; plaintext URLs are
  refused; a crawl cannot finish before it starts; the same candidate cannot be
  recorded twice in one run; a candidate cannot be orphaned from its crawl; a
  blank host is refused; discovery cannot insert into the ingestion outbox.
- **Pacing proof:** two reservations on `www.govinfo.gov` return 0 ms then
  1000 ms, and the count is per host — whichever adapter asked.
- **Role boundary:** serve = SELECT only on all three tables; job =
  SELECT/INSERT/UPDATE, no DELETE, no DDL; no Session 8 role gained promotion or
  snapshot-activation authority.
- **Drift:** **zero structural drift** on the three new tables. The only diff
  entry touching them is a drop-and-re-add of one FK with an identical name and
  definition, part of 209 repo-wide FK churn lines in a 2,584-line pre-existing
  diff. No CREATE/ALTER TABLE, column, index or CHECK difference.

## 7. Gates — all fresh on this candidate

```text
S8  SESSION8_LIVE_DISCOVERY_PASS (--enforce-replay)
S8  discovery domain gate            40/40
S8  publisher-native kind gate       15/15
S8  live discovery control loop      15/15
S8  real-source replay               37/37
S8  disposable DB rehearsal          51/51
S2  SESSION2_BOUNDARY_PASS
S3  SESSION3_BOUNDARY_PASS — 49 frozen routes, exact method/path/role match
S3  SESSION3_ADMIN_BOUNDARY_PASS — 5 governed mutations
S4  SESSION4_SOURCE_PARITY_PASS (--enforce-replay)
S4  SESSION4_IMAGE_CONTAINMENT_PASS (8 checks)
S4  PHASE7_TYPECHECK_BASELINE_MATCH — 4 pre-existing errors, no drift
S5  SESSION5_COMPLETE_NVIDIA_NOT_ADOPTED
S6  SESSION6_FEDERAL_FUNDING_FOUNDATION_PASS + domain 9/9
S7  SESSION7_LIFECYCLE_CONTROL_PLANE_PASS (--enforce-replay)
    + domain 57/57 + control loop 32/32
Prisma: apps/api validate PASS + generate PASS; defense-api validate PASS
defense-api typecheck PASS; build PASS
git diff --check: clean
```

GitHub Actions remains externally unavailable repo-wide (startup failures since
2026-07-31). Everything above was run locally on this exact candidate.

## 8. Safety statement

```text
AWS mutated:                    NO
Production DB mutated:          NO
Production schedules changed:   NO
Production routes changed:      NO   (Session 3 surface still exactly 49 routes)
Snapshot promoted or activated: NO
NVIDIA restarted:               NO   (no endpoint, no transform job, no spend)
Deterministic parser default:   UNCHANGED (DETERMINISTIC_PRIMARY)
Session 9 started:              NO
Session 8 PR merged:            NO
```

Live crawling requires `PHASE8_SESSION8_LIVE_DISCOVERY=true` to be wired at all,
`PHASE8_SESSION8_CRAWL_AUTHORIZED=true` before a single request is issued, and
`PHASE8_SESSION8_COMMIT_AUTHORIZED=true` before anything is persisted. Verified:
without authorisation the command reports `SESSION8_DRY_RUN_PASS` and issues no
request.

## 9. Bugs found and fixed while building this

1. **The MODS primary title is not enough for bills.** A real bill's first title
   is "To authorize appropriations for fiscal year 2024 for military
   activities..." — which names both tracks in one breath and is correctly
   ambiguous, so the FY2024 NDAA would not resolve at all. The popular title sits
   in the **same** record as `<titleInfo type="alternative">`. Resolution now
   tries the document's own titles in order. Two guards keep that honest: only
   titles before the first `<relatedItem>` count, and a bare bill designator
   ("H.R. 2670 (RH)") is skipped because it identifies rather than describes.
   Verified that this does **not** make the no-defence-division omnibus resolve.
2. **Literal backspace characters written into regexes.** Eight `\b` word
   boundaries in `govinfo-packages.ts` became raw `0x08` bytes because the
   edit went through a shell heredoc into a non-raw Python string, where `\b` is
   a valid escape. The regexes still compiled and the build passed, so only a
   byte-level check caught it. All eight repaired and every touched file scanned.
3. **Verifier false positive on `ON DELETE RESTRICT`.** The append-only check
   matched the referential-integrity clause, not a granted privilege. It now
   strips FK clauses before the prohibition check — the same class of bug as
   Session 7's "verifier matched its own prose".
4. **`tsconfig.phase7.json` did not include ambient declarations.** The narrow
   project pulls parts of `src/engagement` in transitively without listing them,
   so the hand-written `src/types/word-extractor.d.ts` was invisible and two
   implicit-any errors appeared that the Session 4 baseline gate correctly flagged
   as drift. Fixed by including `src/types/**/*.d.ts`; the gate now matches its
   recorded 4 errors exactly. Pre-existing, not caused by Session 8 — this branch
   touches no file under `src/engagement` and no lockfile.

## 9a. Publisher-native document kinds (the closed blocker)

Session 7's classifier resolves document kind from the GovInfo package id. Nine of
the fourteen adapters publish on their own websites with no package id at all, so
under that rule live discovery was GovInfo-only — nine adapters could crawl,
record and never emit.

The missing evidence is **who published the document**. The governed cycle
template already binds each mark to exactly one adapter (`hasc` →
`authorization/hasc_mark/HASC/house`), so reading the stage from the adapter is
that binding read from the other direction, on bytes the registry already proved
came from that adapter's own official host.

Four guards, each asserted by a test:

1. **Reachable only when the package-id chain resolved nothing.** GovInfo
   classification is unchanged — both real committee reports still classify at
   confidence `0.95` / `accept`.
2. **Only the nine listed adapters.** No GovInfo or congress.gov adapter has a
   profile, so publisher identity cannot rescue the omnibus: `PLAW-118publ42`
   still resolves to nothing.
3. **The document must still look like what that publisher issues.** A press
   release is not a chairman mark, and where document text resolves a
   *contradicting* track, document evidence wins and the candidate is refused.
4. **Confidence capped at 0.7, below the 0.8 accept threshold.** Such a document
   routes into the persisted review backlog; no stage advances on publisher
   identity alone.

Two pre-existing mapping gaps had to be fixed for these to land on real expected
sources, both of which minted dedup keys nothing could match: reprogramming and
transfer collapsed into `alt_supplemental` despite being separately registered
families, and all President's Budget material defaulted to `pb_overview` despite
the template registering per exhibit family and component. Exhibit designators now
resolve the family, gated by an assertion that every family the resolver can emit
is one the template registers — the same bug class Session 7's closeout found.

Marine Corps volumes fold into `NAVY` because the template registers **zero**
`USMC` entries (measured); `SF` is registered separately and is narrowed.

A useful side effect: committee sites overwhelmingly write "NDAA", which the frozen
Session 7 subject pattern deliberately does not match. Publisher identity supplies
the track, so the frozen pattern needed no loosening.

## 10. Disclosed limitations

### 10.1 (RESOLVED) Index-page candidates now resolve

The first pass of this session disclosed that the Session 7 classifier derived
document kind from the official GovInfo package id and returned `review` without
one, leaving all nine index-page adapters permanently unresolvable. That was a
scope failure, not an acceptable limitation, and it has been closed — see §9a.

### 10.2 Five adapters cover hosts that refuse a plain client

```text
comptroller.defense.gov   403 Akamai   (dod-comptroller, dod-comptroller-reprogramming)
asafm.army.mil            403 Akamai   (army-budget)
www.defense.gov           403 Akamai   (dod-contract-announcements)
saffm.hq.af.mil           no connection (saf-fm-budget)
```

Recorded as refusals, never as absences. Making them yield is an egress /
allowlisting question for the deployment session, not something code can assert.

### 10.3 A cold BILLS backfill is metadata-bound

Measured and published rather than implied: **11,391 of 13,354** `BILLS_2023`
entries survive the id-shape prefilter (85.3%). An id-shape filter cannot know
subject, and congress 118 plus `hr`/`s` covers most of a 2023 bill sitemap, so a
cold backfill needs roughly one MODS request per survivor and spans many bounded
runs. Steady state is cheap because it is driven by `lastmod` deltas.

### 10.4 No API key is configured

`api.govinfo.gov` and `api.congress.gov` both answer `API_KEY_MISSING`. API-mode
discovery is implemented against the key-free sitemap channel and validated
there. A credentialled path was not built and not tested.

### 10.5 GovInfo `BUDGET` collection is reachable but unusable by the registry

`BUDGET_sitemap_index.xml` exists and is key-free, and would be the natural
President's-Budget channel for the blocked `dod-comptroller` adapter. The frozen
registry ties that adapter to `comptroller.defense.gov` only, and
`assertAuthoritativeHost` correctly refuses a govinfo.gov URL from it. Re-routing
would mean editing the frozen adapter registry.

## 11. Traps worth carrying forward

- **A sitemap `<loc>` is not the document URL.** GovInfo lists
  `/app/details/<id>`; the watcher needs `/content/pkg/<id>/pdf/<id>.pdf`.
- **A details page's `<title>` is a label, not a subject.**
  `H. Rept. 118-125 - CRPT-118hrpt125 | Content Details | GovInfo` cannot separate
  authorization from appropriations. MODS can.
- **`lastmod` is metadata mtime, not publication date.** Real FY2024 packages
  carry `lastmod` in late 2024 and 2025.
- **The sitemap index is unordered.** The real CRPT index lists 2001, 2015, 2004,
  2005, 2011 in that order; deterministic discovery must sort.
- **Adapters share hosts**, so a per-adapter limiter multiplies the real request
  rate. Three GovInfo adapters and two comptroller adapters each share one host.
- **The publisher may be stricter than your registry.** congress.gov declares
  `Crawl-delay: 2` against a 1000 ms registry minimum.
- **congress.gov bans a long list of AI-crawler user agents with `Disallow: /`.**
  RFC 9309 group selection has to be correct, and the crawler should refuse to
  run rather than crawl a publisher that excluded it.
- **A 5xx robots.txt is not necessarily a ban.** `api.govinfo.gov` returns a 500
  JSON application error. RFC 9309 permits assuming complete disallow; doing so
  would blind discovery for no stated reason.
- **`\b` is a valid escape in a non-raw Python string.** Editing regexes through
  a heredoc silently produces backspace bytes that still compile.
- `.session8-discovery/` is gitignored: official bytes and the prepared corpus
  are materialised locally, never committed.

## 12. Open items for Session 9+

1. **Egress allowlisting for the Akamai-protected hosts** (§10.2). Deployment
   work, and the prerequisite for any comptroller/service-exhibit yield — the
   resolution logic for those publishers is in place and tested, so this is purely
   a network-reachability question.
3. **Credentialled API path** (§10.4), if a GovInfo/Congress.gov key is ever
   provisioned. The sitemap channel remains the credential-free fallback.
4. **Schedule ownership stays Session 10's.** Session 8 registers no schedule; a
   cold backfill currently needs the governed command invoked repeatedly.
5. **The Session 8 tables are intentionally absent from the curated `defense-api`
   HTTP Prisma subset** (same precedent as Sessions 6 and 7). The store uses
   parameterised raw SQL. Adding them is part of the product cutover.
6. **`MAP_STYLE_ATTRIBUTION`** still needs its real value restored — carried
   forward, unrelated to Phase 8.

## 13. Commands

```bash
# Domain + control loop
node scripts/test-phase8-session8-discovery-domain.mjs
pnpm --filter @capiro/defense-api exec tsx --test \
  src/budget-lifecycle/discovery/live-discovery.spec.ts

# Real official sources: materialise, then replay
node scripts/prepare-phase8-session8-discovery-corpus.mjs
node scripts/phase8-session8-discovery-replay.mjs \
  --out docs/defense-budget/phase8-session8-discovery-replay-evidence.json

# Gates
node scripts/verify-phase8-session8.mjs --enforce-replay
node scripts/verify-phase8-session8-db.mjs

# Governed command (no request without authorisation)
cd apps/defense-api
node scripts/run-live-discovery.mjs --list-adapters
node scripts/run-live-discovery.mjs --adapter govinfo-committee-reports --plan
```

**Do not merge until separately authorised.**
