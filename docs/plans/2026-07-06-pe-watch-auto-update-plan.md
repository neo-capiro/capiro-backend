# PE Watch — Auto-Update Assessment + Deployment Plan

**Date:** 2026-07-06 · **Author:** Claude + Ninja · **Status:** PROPOSED (sequencing = Ninja)
**Input:** Ninja's "Capiro Intelligence Engine / PE Watch" proposal (shared pipeline across
Bill Tracker + Hearing Watch + PE Watch). This doc assesses that proposal against what is
actually built and shipped, then gives a phased deployment plan with steps and success criteria.

Companion docs: [defense-money-graph-consolidated-plan.md](defense-money-graph-consolidated-plan.md)
(the object model + §7 deployment playbook + §7.5 scheduled-jobs table this plan finally stands up),
[2026-07-06-bucket3-net-new-capabilities-plan.md](2026-07-06-bucket3-net-new-capabilities-plan.md)
(C2 emit-floor-alerts and C6 entity-norm are adjacent, not overlapping),
[2026-06-07-source-document-registry.md](2026-06-07-source-document-registry.md) (the checksummed
document registry the watcher diffs against).

---

## 1. Assessment — the proposal vs. what exists

### 1.1 Verdict

The proposal's core instinct — **PE Watch must not be a standalone scraper or static database;
it should be a third object type in the same ingestion → diff → watchlist → alert engine as
Bill Tracker and Hearing Watch** — is correct, and it is *already our architecture*. Bill Tracker
+ Hearing Watch merged into LegiWatch (intel-api canonical) in July; the canonical 7-field Alert
(#322, contract in `@capiro/shared`) + freshness dedup layer (#320) now spans all three chat/alert
surfaces. PE Watch joins that spine; it does not get its own.

The surprise from the code inventory: **almost every stage of the proposed 7-step PE pipeline is
already built — and most of it is richer than proposed.** What's missing is (a) scheduling (zero
PE jobs on EventBridge today), (b) a new-document watcher, (c) the bridge from PE events into the
shared alert/watchlist system, and (d) hearing/opportunity linking. That is wiring work, not
platform work.

### 1.2 Stage-by-stage mapping of the proposed pipeline

| Proposed stage | Status in our stack | Detail |
|---|---|---|
| 1. Pull official budget/PE source docs | ⚠️ **Semi-manual** | J-book sync verbs fetch live URLs (dry-run default) but prefer committed artifacts; seasonal PDFs are hand-downloaded → `extract_*.py` (pdfplumber) → committed JSON. `SourceDocument` registry fingerprints (sha256) + version-chains every doc. **Missing: detection that a new/changed doc exists.** |
| 2. Extract PE records | ✅ Built, human-gated | `extract_jbook_r1/r2/performers/pdoc/armed_services_report.py` + `toc_parse.py`. The `*_corrected.json/md` artifacts are the proof this stage needs eyeballs — keep it gated. |
| 3. Normalize PE data | ✅ Built | `ProgramElementWriterService` + quarantine + ingest-run audit (units-anomaly + truncated-title guards), per-field `program_element_year_source_value` reconciliation with review queue. |
| 4. Compare against prior versions | ✅ Built, **better than proposed** | `compute-budget-deltas` (12 typed delta kinds + materiality scoring, latest-wins) + `derive-budget-actions` (add/cut/new_start/termination, evidence-carrying). The proposal's delta_amount/delta_percent is a subset. |
| 5. Link to bills / hearings / reports / awards / opportunities | ⚠️ **Partial** | Bills: `extract-bill-pe-codes` (explicit codes only). Reports: provisions extraction exists. Awards: `federal_award.peCode` + MDAP map + enrichment verbs (accumulating). **Missing: hearing-mention → PE, SAM opportunity → PE, and title/semantic bill matching.** |
| 6. Match against client watchlists | ⚠️ **Split-brain** | `program_element_watch` (apps/api, per-user PE watches + `/watchlist/signals`) vs. `intel_watchlist(_term/_topic/_match)` (LegiWatch, per-tenant terms). **Missing: one watchlist powering all three modules — the heart of the proposal.** |
| 7. Generate PE-specific alerts | ⚠️ **Wrong rail** | Budget Movement feed + watch signals exist on `/program-elements`, but PE events do NOT flow through the canonical Alert / freshness-dedup / digest system. |

### 1.3 What to adopt, modify, and reject from the proposal

**Adopt:**
- One shared engine; PE as the third watch object. Shared watchlists across modules.
- The source stack as listed — comptroller budget-materials + component J-books (primary),
  Congress.gov bills/committee-meetings, GovInfo historical hearings, SAM.gov + USAspending.
  All but GovInfo-historical are already integrated and (except budget docs) synced daily.
- The "high-value update types" list — maps ~1:1 onto our existing `deltaType`/`budget_action`
  vocabulary + the new event sources (hearing mention, opportunity, award).

**Modify:**
- **No new `program_elements` table.** The proposed JSON model is a strict subset of what ships
  today (`ProgramElement` + `ProgramElementYear` + per-field provenance + deltas + actions +
  relationships + capability matches + intelligence cache). The money-graph BudgetLine reframe
  remains the target model; PE Watch consumes it, never forks it.
- **"Pull → parse" must stay human-gated for dollars.** Every mark/dollar load keeps
  dry-run → inspect → commit (playbook §7.1 — this discipline has caught real bugs twice).
  What gets automated is *detection, download, extraction-to-staging, and a diff report* —
  the commit stays a human decision. Full lights-out parsing of J-books/committee PDFs is
  where this plan deliberately stops short of the proposal.
- **Product surface:** v1 does NOT add a LegiWatch "Program Elements" tab. PE alerts land in the
  LegiWatch **Feed** (typed, filterable) and deep-link to the existing Program 360 page, which
  already has the funding-history / linked-bills / performers / people panels the proposal
  sketches. A dedicated tab is a later product call (fits the per-surface alert type-collapse
  roadmap item).

**Reject:**
- Standalone PE scraper/cron outside the shared engine (the proposal itself rejects this).
- Auto-accepting fuzzy links (hearing mentions, title matches). Everything fuzzy lands as a
  `candidate` with confidence + evidence, consistent with the money-graph ambiguity rules (§4.5).

### 1.4 Non-overlap with bucket #3

C4 (Budget/Fiscal) is macro CBO/Treasury — different layer. C2's `emit-floor-alerts` already
plans to join floor items × tracked PEs — Phase 2's unified watchlist is what makes that join
possible. C6 entity-norm will strengthen Phase 3 matching (program/office aliases) but is not a
prerequisite.

---

## 2. Architecture (target state)

```
                    ┌─ sources (all already syncing daily except budget docs) ─┐
 comptroller/J-book │ congress.gov bills │ hearings (LegiWatch) │ SAM opps │ USAspending
        │                   │                    │                  │           │
  [P1: watch-budget-docs]   │                    │                  │           │
   sha256 diff vs           │                    │                  │           │
   source_document          │                    │                  │           │
        │                   │                    │                  │           │
  [P4: gated parse ────► program_element* tables ◄── extract-bill-pe-codes     │
   dry-run → diff           │                        [P3: title/alias match]   │
   report → human           ▼                        [P3: hearing mentions]    │
   --commit]        [P0: nightly derive chain]       [P3: opportunity match]   │
                     compute-budget-deltas                                     │
                     → derive-budget-actions         enrich-award-pe ◄─────────┘
                     → derive-relationships          [P0: scheduled daily]
                     → derive-intelligence-cache
                            │
                            ▼
                  [P2: emit-pe-alerts]
                   budget_action/delta/doc-detection → canonical 7-field Alert
                   → freshness dedup (dedupe_key) → LegiWatch feed + digests
                            │
                  [P2: unified watchlist match]
                   intel_watchlist terms + PE codes + capability aliases
                            │
                            ▼
              LegiWatch Feed / briefs / archive · Program 360 deep links · Meri tools
```

Everything runs on the existing rails: verbs on the `capiro-dev-api-migrate` task-def family,
EventBridge rules copying the `sync-federal-award` target (cluster `capiro-dev`, invoker role
`capiro-dev-eventbridge-sync-invoker`, 3 private subnets, `sg-01def4e5c0fe44d4a`, container
override `["<verb>", ...args]`). Rules are out-of-band (NOT in CDK) — each one added must be
documented in this file's §6 table (playbook gotcha §7.3f).

---

## 3. Deployment plan

Each phase is independently shippable and follows the invariant pipeline:
branch → PR → CI → squash-merge → **confirm `:latest` ECR sha == merged sha** → roll api →
one-off ECS dry-run → inspect → commit/enable → verify (logs + live browser).

### Phase 0 — Schedule the continuous layer (~1–2 pd) — do first, this week

The §7.5 jobs from the money-graph plan, never stood up. All verbs exist and are idempotent.

**Steps:**
1. **New wrapper verb `run-pe-derive-chain`** (small PR): sequentially runs
   `compute-budget-deltas` → `derive-budget-actions --commit` → `derive-relationships --commit`
   → `derive-intelligence-cache`, aborting the chain on any non-zero step and logging per-step
   counts. One task = guaranteed ordering (independent cron offsets can't promise it).
2. **Baseline manual runs on prod** (one-off ECS tasks, before any rule exists):
   each derive verb dry-run → inspect output → commit; then run the wrapper once end-to-end.
   Record before/after `diag-graph-coverage` numbers in the PR.
3. **Prove idempotence in prod:** run the wrapper a second time — expect 0 material changes
   (latest-wins rows unchanged, cache rewrite with same values).
4. **Create EventBridge rules** (CLI, copying the sync-federal-award target verbatim):
   | Rule | Command | Schedule (UTC) |
   |---|---|---|
   | `capiro-dev-enrich-award-pe` | `enrich-award-pe --limit 5000` | `cron(15 10 * * ? *)` (daily, after sync-federal-award at 09:50) |
   | `capiro-dev-pe-derive-chain` | `run-pe-derive-chain` | `cron(30 10 * * ? *)` (daily, after enrichment) |
   | `capiro-dev-diag-graph-coverage` | `diag-graph-coverage` | `cron(0 11 ? * MON *)` (weekly snapshot) |
   | `capiro-dev-export-master-lists` | `export-master-lists` | `cron(30 11 ? * MON *)` (weekly) |
   Ordering: sync-federal-award (09:50) → enrich-award-pe (10:15) → derive chain (10:30).
5. **Staleness alerting:** wire the existing SNS path (`capiro-dev-alerts`) — job failure or
   last-success > 2× cadence alerts neo@capiro.ai (same pattern as other syncs; verify the
   derive verbs write SyncRun rows, add if missing — small PR addition).
6. Document all four rules in §6 below.

**Success criteria:**
- All four rules fire green for 7 consecutive days (CloudWatch: task exit 0, no ERROR in
  `/capiro/dev/api`).
- `program_element_intelligence_cache.computedAt` is < 26h old at all times (this is the
  "PE information is auto-updating" heartbeat — the catalog, movement feed, and Meri all read it).
- Award→PE links grow ≥ +500/week while backlog remains (money-graph §8.1 target).
- Second consecutive derive run produces 0 material row changes (idempotence in prod, verified once).
- Weekly diag snapshot lands as an artifact; any metric regressing > 2% triggers investigation.
- Browser check: Budget Movement feed on `/program-elements` shows fresh `computedAt`/signal data.

### Phase 1 — Budget-document watch (~3–4 pd)

Automates the *detection* half of "pull official budget documents." New verb `watch-budget-docs`.

**Steps:**
1. **New verb `watch-budget-docs`** (PR):
   - Polls publisher indexes: comptroller.war.gov budget-materials pages (direct fetch works),
     service J-book index pages per the §7.3g routing table (asafm → Wayback; secnav → browser
     UA; saffm/afpims → **index-page diff only**, PDFs not bot-fetchable), Congress.gov
     committee-reports API for HASC/SASC/HAC-D/SAC-D report publications, GovInfo CRPT.
   - For fetchable docs: download → sha256 → compare against `source_document (sourceKey, sha256)`.
     New sourceKey or changed sha → **detection event**. For blocked publishers: diff the index
     page's link inventory; a new link = detection event with `fetchable: false`.
   - Emits: one canonical Alert per detection through the freshness layer
     (`dedupe_key = watch-budget-docs:<sourceKey>:<sha256|linkUrl>` — re-runs are no-ops) +
     SNS email to neo@ with doc type, URL, and **which loader chain applies**
     (r1 → sync-comptroller-jbooks; committee_report → extract_armed_services_report → parse-hasc-sasc-reports; etc.).
   - Dry-run default; `--commit` records detections + sends alerts.
2. **Baseline run against the current corpus** (one-off, dry-run): must recognize every already-
   ingested FY27 doc as known (0 false "new"). Tune sourceKey derivation until true.
3. **Schedule:** `capiro-dev-watch-budget-docs`, `cron(0 12 * * ? *)` daily. (Budget docs are not
   intraday; daily is right. Revisit to 2×/day during Feb PB week if wanted.)
4. Document rule in §6.

**Success criteria:**
- Baseline: 0 false-new against the ingested FY27 corpus; re-run emits 0 duplicate alerts.
- Synthetic test: a staged fake index entry (test fixture mode) produces exactly one alert with
  correct doc-type classification and loader-chain hint.
- Live: the next real publication (SAC-D FY27 report / FY27 conference / any PB28 early drop)
  is alerted within 24h of appearing — measured when it happens; until then the synthetic
  test is the gate.
- Blocked-publisher path verified: an AF index change alerts with "manual browser download
  required" flagged.

### Phase 2 — PE Watch joins the shared engine (~4–6 pd)

The heart of the proposal: shared watchlists + PE alerts on the canonical rail.

**Steps:**
1. **New emitter verb `emit-pe-alerts`** (PR): reads budget_action / program_element_delta rows
   whose `computedAt` is newer than the last emit watermark (SyncRun), filters by materiality
   score, and emits canonical 7-field Alerts (`dedupe_key = pe:<peCode>:<fy>:<stage>:<action>:<amount-hash>`)
   through the freshness layer into the LegiWatch feed + daily/weekly digests. Alert types map
   from the existing vocabulary: funding increase/cut, new start, termination, congressional
   add/cut, zeroed, transfer candidate — exactly the proposal's "what PE Watch should monitor" list.
2. **Unified watchlist matching** (same PR or follow-on): extend `intel_watchlist_term` matching
   to PE space — a term matches a PE if it hits (a) an explicit PE code, (b) budget-line
   title/canonical title, or (c) a `capability` alias (which then fans out through
   `capability_budget_line_match` accepted rows). Matched alerts carry client relevance;
   unmatched material alerts still land in the firm-wide feed. Bridge (don't migrate)
   `program_element_watch`: user PE watches count as watchlist entries for alert routing.
3. **Surface:** PE alert type renders in LegiWatch Feed with evidence (source doc + page deep
   link from `program_element_source`) and a Program 360 deep link. No new tab in v1.
4. **Email delivery (per resolved decision §5.2):** `pe_alert_email_pref` table + the
   "Email alerts" control on `/program-elements` (Off / Daily digest / + immediate-critical);
   digest flusher gains a PE Watch section; immediate-critical sends ride the existing SES
   path. Emails link to Program 360 + the Feed item.
5. **Schedule:** append `emit-pe-alerts` as the final step of `run-pe-derive-chain` (alerts fire
   only after fresh derivations — same reason emit-bill-alerts trails detect-bill-changes).
6. **Canary:** capiro-internal tenant first (consistent with the standing canary posture), using
   the Aperture Defense Systems seed client (it has the PE 0603270A fixture). Flip customer
   tenants after one clean week.

**Success criteria:**
- E2E on canary: add "Collaborative Combat Aircraft"-class term + a PE code to an Aperture
  watchlist → seeded budget_action change produces exactly one Feed alert with all 7 fields,
  correct client match, working evidence deep link — verified in the browser on prod.
- Idempotence: re-running the chain emits 0 duplicate alerts (freshness dedupe verified in prod).
- Digest inclusion: PE alerts appear in the daily digest flush for subscribed users.
- Email e2e: a canary user with "Daily digest" ON on `/program-elements` receives the PE Watch
  section in the next flush; an immediate-critical alert (seeded termination on a watched PE)
  emails within 15 min of the chain run; a user set to Off receives nothing PE-related.
- Noise gate: materiality threshold tuned so canary week produces a reviewable volume
  (target: every alert is explainable; zero alerts Ninja judges as spam — else raise threshold
  before customer flip).
- No regression in existing bill/hearing alert paths (the 7-field contract's drop-nothing
  adapters already guard this; smoke the three surfaces).

### Phase 3 — Cross-linking depth: hearings, bills-by-title, opportunities (~5–8 pd)

Closes the proposal's stage 5 beyond what exists.

**Steps:**
1. **Hearing mentions → PE:** matcher over LegiWatch transcript segments (live Deepgram +
   ingested official transcripts) against a name bank built from program names, budget-line
   titles/canonical titles, and capability aliases. Hits create candidate links
   (confidence + timestamp evidence) + a "hearing mention" PE alert routed as in Phase 2.
   Golden fixtures required (≥20 real transcript segments incl. known negatives).
2. **Bill/report language → PE beyond explicit codes:** extend `extract-bill-pe-codes` with
   title/alias matching → candidate `bill ↔ PE` links (the money-graph §1.5
   `bill_budget_line_link` shape), rendered on Program 360's linked-bills panel as
   "candidate — needs review" tier.
3. **SAM opportunity → PE:** keyword/alias match of daily-synced opportunities against the same
   name bank → "execution signal" candidate alerts (proposal's opportunity → award → vendor chain;
   award side already flows via enrich-award-pe).
4. Nothing fuzzy auto-accepts; candidates land in the existing review-queue pattern.

**Success criteria:**
- Fixture gate in CI: 100% of golden fixtures pass; matcher changes require fixture changes in
  the same PR (house rule from the engines).
- Precision audit: on a 50-sample of accepted-threshold hearing/opportunity matches, ≥80%
  confirmed correct by human audit before alerts flip on for customer tenants; below that, the
  type ships candidate-only (visible on Program 360, no alerts).
- Live proof: one real defense posture/approps hearing produces a correctly-linked,
  timestamped PE mention alert on the canary tenant.

### Phase 4 — Assisted seasonal ingestion (~5–8 pd, optional but recommended before the FY27 enacted cycle)

Automates everything about a new budget document *except the commit decision*.

**Steps:**
1. On a Phase-1 detection of a fetchable doc: an operator-triggered (or auto, per doc type)
   pipeline runs download → `extract_*.py` in a container → artifact JSON to S3 + a generated
   branch/PR with the artifact committed → loader dry-run against prod → **diff report**
   (before/after diag numbers, quarantine count, units-anomaly sentinel) posted to the PR.
   Human reviews → merges → runs `--commit` one-off → derive chain picks it up that night.
2. Write the two stub verbs while in here: `parse-ndaa-conference` and
   `parse-defense-approps-public-law` (extraction tool for NDAA tables already exists) —
   these are exactly the docs arriving in the FY27 fall cycle.
3. Regenerate P-1 artifacts via the existing `extract_pdoc.py` (in progress) so procurement
   rides the same rail.

**Success criteria:**
- Drill: replay an already-ingested FY27 committee report through the full pipeline → dry-run
  diff shows 0 changes (proving the rail is faithful).
- The first real new document (target: FY27 SAC-D report or conference) goes detection → loaded
  in < 48h with ≤ 1h human time, dry-run→inspect→commit discipline intact, 0 quarantine floods.
- Second run of any load = 0 changes (idempotence, per playbook §7.1.3).

---

## 4. What deliberately stays manual

- **The commit decision for dollars.** Every mark/enacted load keeps a human between dry-run
  and `--commit`. The `*_corrected` artifact suffixes across `__data__` are the scar tissue
  justifying this.
- **AF (saffm/afpims) document downloads** — publisher blocks non-browser clients; the watcher
  alerts, a human fetches (counsel posture on browser-UA automation is an open Ninja call,
  same question as bucket-3 C2).
- **Fuzzy-link acceptance** — candidates queue for review; only deterministic tiers auto-accept.

## 5. Decisions — RESOLVED 2026-07-06 (Ninja delegated to recommendations; email requirement added)

1. **Browser-UA fetching of secnav/saffm: index-diff detection only** until counsel clears
   browser-UA automation (same memo as bucket-3 C2's house.gov question). The watcher alerts
   with "manual browser download required" — detection UX is intact either way.
2. **Alert surface: LegiWatch Feed + Program 360 deep links, no new tab in v1** — plus
   **email delivery (Ninja requirement)**: PE alerts email out the way LegiWatch alerts do,
   but the **email configuration lives on the Program Elements surface**, not in LegiWatch
   settings. Design (best-UX recommendation):
   - A per-user **"Email alerts" control on `/program-elements`** (small settings panel next
     to the watchlist affordance): `Off / Daily digest / Daily digest + immediate for
     critical`. Default for users who already watch a PE: Daily digest.
   - Scope: alerts on the user's watched PEs (`program_element_watch`) + alerts matched to
     their tenant's watchlists. Firm-wide material moves appear in the Feed but do NOT email
     unless watched/matched — email stays high-signal.
   - **Immediate tier** = critical types only (termination, zeroed, cut ≥ materiality
     threshold) on explicitly watched PEs; everything else batches into the daily digest.
   - Storage: new per-user, tenant-scoped `pe_alert_email_pref` row (RLS like other tenant
     tables); delivery reuses the existing SES path and digest-flush pattern (the Tracker
     email rail is LIVE) with a **PE Watch section** in the digest email — one email a day,
     sectioned, not a new parallel email stream.
3. **Phase 4 auto-download: operator-triggered per detection.** The detection alert carries a
   one-line runbook command; fully-automatic download stays off until the pipeline has
   handled ≥2 real documents cleanly.
4. **Sequencing: Phases 0–1 start immediately** (independent of bucket #3). Phases 2–3
   before/alongside bucket-3 Wave 1; C6 entity-norm strengthens Phase 3 matching but is not
   blocking.

## 6. Out-of-band EventBridge rules added by this plan (registry — keep current)

| Rule | Command | Schedule (UTC) | Added | Phase |
|---|---|---|---|---|
| `capiro-dev-enrich-award-pe` | `enrich-award-pe --limit 5000` | cron(15 10 * * ? *) | 2026-07-06 | 0 |
| `capiro-dev-pe-derive-chain` | `run-pe-derive-chain --commit` | cron(30 10 * * ? *) | 2026-07-06 | 0 |
| `capiro-dev-diag-graph-coverage` | `diag-graph-coverage` | cron(0 11 ? * MON *) | 2026-07-06 | 0 |
| `capiro-dev-export-master-lists` | `export-master-lists` | cron(30 11 ? * MON *) | 2026-07-06 | 0 |
| `capiro-dev-sync-task-failures` | (event pattern, not cron): ECS Task State Change, migrate-family task STOPPED with non-zero exit → SNS `capiro-dev-alerts` (topic policy has an events.amazonaws.com statement scoped to this rule) | n/a | 2026-07-06 | 0 |
| `capiro-dev-watch-budget-docs` | `watch-budget-docs --commit` | cron(0 12 * * ? *) | pending merge | 1 |
| `capiro-dev-match-pe-mentions` | `match-pe-mentions --commit --limit 50` | cron(45 12 * * ? *) | pending merge | 3 |

Phase 2 email delivery has NO separate rule: `send-pe-alert-emails` runs as the final step of
`run-pe-derive-chain` (nightly 10:30). Its canary gate is the `PE_ALERT_EMAIL_TENANTS` env var
(comma tenant UUIDs or `all`; unset = dark) — set via the chain rule's containerOverrides
`environment`, so the canary flips without a task-def revision.

Note (discovered during Phase 0): the CDK `ApiSyncJobsLogs`/`IngestionErrorMetricFilter`/
`api-sync-jobs` constructs in `compute-stack.ts` are NOT deployed in prod (ComputeStack is
wedged); live scheduled tasks run on the migrate family and log to `/capiro/dev/api`. The
`capiro-dev-sync-task-failures` rule above is the operative failure alerting for ALL
migrate-family one-off tasks, not just PE jobs.

All copy the `sync-federal-award` target: cluster `capiro-dev`, task-def **family**
`capiro-dev-api-migrate` (family ref → auto-picks new revisions incl. the AI-credential secret),
role `capiro-dev-eventbridge-sync-invoker`, subnets `subnet-0e38bd390f8961fef` /
`subnet-0920665f91c905f01` / `subnet-06db79cd21239de19`, SG `sg-01def4e5c0fe44d4a`, no public IP.

## 7. Success criteria rollup (the "is PE info auto-updating?" dashboard)

| Signal | Target | Phase |
|---|---|---|
| Intelligence cache freshness (`computedAt`) | < 26h, always | 0 |
| Award→PE link growth | ≥ +500/week while backlog exists | 0 |
| Scheduled-job health | last success < 2× cadence, SNS on breach | 0 |
| Weekly diag drift | no metric −2% without linked explanation | 0 |
| New budget doc → alert latency | < 24h from publication | 1 |
| Duplicate alerts across re-runs | 0 (freshness dedupe) | 1–2 |
| Watchlist term → PE alert e2e (canary) | works in browser, 7 fields, evidence link | 2 |
| Email delivery (digest + immediate-critical) | e2e on canary; Off is respected; config on /program-elements | 2 |
| Alert precision (fuzzy types, 50-sample audit) | ≥ 80% before customer flip | 3 |
| New doc → loaded (human-gated) | < 48h, ≤ 1h human time | 4 |
| Any loader re-run | 0 changes (idempotence) | all |
