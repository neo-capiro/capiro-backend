# District Nexus — open findings, 2026-07-27

Written while executing `district-nexus-open-items-resolution-plan.md`. Everything
here was measured live against `capiro-dev`, not inferred. Where a belief in that
plan turned out wrong, it is called out.

---

## 1. `profile-v1` hangs — partial attribution (plan DoD item 8)

**Status: mechanism identified, specific section NOT yet isolated.** This is a
partial answer, not a closed investigation.

### The plan's prime suspect is exonerated

Plan §3.5 named `getDistrictNexusSpend` (`intelligence.service.ts:5568`, settle
index 18) as suspect (a), on the theory that it "aggregates `federal_award` by
contractor name, and RTX's name matches an enormous slice."

Measured for RTX Corporation (`492ab348-6600-4fca-9d1b-5f072b4e745e`):

| Measurement | Result |
| --- | --- |
| `federal_award` size | 169,663 rows / 179 MB |
| `contractor_name` indexed? | **Yes** — `federal_award_contractor_name_idx` |
| Awards matching `RTX CORPORATION` | **126** — the $68.97B is 126 rows, not a large slice |
| Spend-by-district query (verbatim, line 5602) | **17 ms** |
| `EXPLAIN (ANALYZE)` | **Bitmap Index Scan**, execution time **0.201 ms** |

`census_district` is 440 rows. No query in this section is slow by any margin.

**Consequence:** hard boundary #5 in the remediation plan forbids modifying
`getDistrictNexusSpend` partly because it "is implicated in §3.5's
investigation." That rationale no longer holds. The other half of the boundary
(the v1 widget renders it whenever the flag is off) still stands.

### The signature rules out the obvious causes

- **Not a slow query.** A slow query still finishes, or the statement times out
  and logs. Nothing logs.
- **Not a hanging HTTP call.** `intelligence.service.ts` makes **zero** network
  calls — no `fetch`, no `axios`, no `got`.
- **Not a per-section error.** `intelligence.service.ts:534` logs
  `profile-v1 source "<label>" failed for client <id>` on any rejected section.
  Zero such lines in the window where the failure reproduced.
- **Not an unhandled exception.** Zero `ERROR` lines in the same window.
- **The handler never returns.** `ApiLatencyMiddleware` emits
  `api.endpoint_latency_ms` on finish. It fires for
  `GET /api/intelligence/client-profile/:clientId` (18,149 ms and 4,304 ms
  observed 2026-07-27) but **never once** for
  `GET /api/intelligence/clients/:clientId/profile-v1`.

  ⚠️ These are two DIFFERENT routes — `intelligence.controller.ts:186` and
  `:191`. A latency metric for `client-profile` is NOT evidence about
  `profile-v1`. This is easy to conflate and was conflated once during this
  investigation.

### Leading hypothesis: Prisma pool starvation in the 24-way fan-out

`getClientProfileV1` fans out over **24 sections** (settle indices 0–23) via
`Promise.allSettled`. At least **6** of the entries in that array call
`this.prisma.withTenant(...)`, and each `withTenant` opens an **interactive
transaction** that holds a connection for its duration. Section methods open
further connections internally — `getDistrictNexusSpend` opens a `withTenant`
transaction and then issues `this.prisma.$queryRaw` calls OUTSIDE it, each
needing another connection.

Against that:

- `connection_limit` is **not set anywhere** in the repo. `entrypoint.sh:40`
  composes `DATABASE_URL` as `?schema=public&sslmode=require` with no pool
  parameters, so Prisma falls back to its default of
  `physical_cpus * 2 + 1`.
- The `capiro-dev-api` task is **512 CPU units (0.5 vCPU)**, 1024 MB. That
  yields a default pool of roughly **3–5 connections**.

A transaction that holds one of 3–5 connections while awaiting a query that
needs a connection from the same exhausted pool cannot make progress and cannot
fail. That produces precisely what is observed: permanent hang, no error, no
metric. It is also volume-sensitive — heavier clients keep each transaction open
longer, widening the overlap window — which explains why a light client returns
(slowly) and RTX does not.

This is the same failure class as the 2026-07-21 graph-sync incident, where an
advisory lock held across an association read starved the pool.

### What is NOT yet established

- Which specific section owns the reported ~13 s floor at zero client data.
  The floor was measured on `client-profile`, not `profile-v1`, so it may not
  even be a `profile-v1` property.
- Whether the pool is genuinely exhausted at failure time. Confirming this needs
  a `pg_stat_activity` snapshot captured *during* a hang, or per-section timing
  instrumentation.

### Recommended next steps, cheapest first

1. **Set `connection_limit` explicitly** in the composed `DATABASE_URL`. This is
   a one-line change to `entrypoint.sh` and is worth doing regardless of whether
   it is the root cause — relying on a CPU-derived default on a 0.5 vCPU
   Fargate task is fragile. If the hang disappears, the hypothesis is confirmed.
2. **Instrument per-section timing** — wrap each of the 24 entries so it logs
   its own duration. Without this, "which section" is guesswork.
3. **Audit for transaction-nesting** — any `withTenant` whose callback awaits a
   query issued on the base client rather than on `tx` is a deadlock candidate.
4. **Do not raise the client timeout.** It hides a 30 s page load instead of
   fixing it.

---

## 2. F4 has no producer and no entry UI (plan DoD item 9)

Recording this as a product gap so "F4 shipped" is not misread as "F4 works."

`ClientGrantNexus` supports eight `relationship_type` values. The
`generate-grant-opportunity-candidates` producer creates **only**
`opportunity_candidate`. The seven award-bearing types —
`direct_recipient`, `subrecipient`, `project_site`, `research_partner`,
`coalition_partner`, `beneficiary`, `matching_contributor` — are
reviewer-entered by design, and **there is no UI to enter them.**

Consequences:

- `aggregateRelationshipNexus` returns `[]` for every client, in every tenant.
- `partnerBeneficiary` (10 points) is structurally unreachable, so the District
  Nexus coverage ceiling stays at **65%**, not the 75% F4 was built to unlock.
- F4 is correct, tested, deployed, and permanently inert until either a review
  UI exists or rows are seeded another way.

This is a roadmap item, not a bug.

---

## 3. The `assistance_recipient` auto-matcher is ~95% wrong

Upstream of District Nexus, and the highest-value item in this document.

Of **183** `assistance_recipient` rows in `client_intel_mapping` (all
`confirmed: false`), trigram similarity between the client's own name and
`external_name`:

| Similarity | Count | Share |
| --- | --- | --- |
| 0.40–0.48 | 126 | 69% |
| 0.50–0.59 | 47 | 26% |
| 0.60–0.65 | 2 | 1% |
| 0.78 | 1 | — |
| 0.85–0.86 | 3 | 2% |
| **1.00 (exact)** | **4** | **2%** |

**173 of 183 (95%) fall below 0.6.** The matcher fuzzy-matched shared tokens
(`UNIVERSITY`, `ENERGY INC`, `COUNTY`) and produced confident-looking nonsense:

| Client | Matched to | Obligated |
| --- | --- | --- |
| Olivet University | **DUKE UNIVERSITY** | $4,212,491,964 |
| Olivet University | EMORY UNIVERSITY | $3,370,524,456 |
| Olivet University | UNIVERSITY OF UTAH | $1,982,145,555 |
| National Wildlife Federation | NATIONAL FISH AND WILDLIFE **FOUNDATION** | $1,555,647,586 |
| Olivet University | UNIVERSITY OF MIAMI (×4 duplicate rows) | $1,432,808,639 |
| SANTA ROSA COUNTY | COUNTY OF SANTA **CLARA** | $134,811,719 |
| NANO NUCLEAR ENERGY INC | ION CLEAN ENERGY / M2X ENERGY / NATRON ENERGY / QUINO ENERGY | — |

Confirming a mapping asserts "this client IS this federal assistance
recipient." Bulk-confirming these would misattribute **over $15B** of federal
assistance across unrelated organisations. Only the 2 exact-name RTX rows were
confirmed on 2026-07-27, deliberately.

The threshold needs raising and the queue needs a review gate. As it stands the
matcher generates a review queue that cannot be trusted, and a reviewer working
top-down by confidence would hit `DUKE UNIVERSITY` at 0.5 with $4.2B attached.

---

## 4. Smaller items

| Item | Detail |
| --- | --- |
| `district-nexus.service.ts:866` | `buildClientRelevanceProfile` reads `client.findFirst` with **no** `VISIBLE_CLIENT_FILTER`, and its only caller (line 293) does not short-circuit for archived clients. No live impact — every consumer is independently filtered, so the profile is never used — and it is tenant-scoped. One-line defence-in-depth fix. |
| Producer `findFirst` batching | One `findFirst` per (client, grant) pair inside a per-client transaction. Measured **780–960 ms/client** vs **4–6 ms** batched (130–240×). Recorded as a precondition on the `GenerateGrantOpportunityCandidates` CDK entry. |
| `SyncGrantsReconcile` coverage | `MAX_PAGES=100` caps a run at 10,000 upserts of a reported `hitCount` of 82,982 — **12% per run**, ~8 Sundays per full pass. Legitimately reports `success_with_errors` on cap exhaustion. |
| `EnrichAssistanceAwards` backlog | `--limit 500`/run against 238,619 unenriched rows is **~478 days**. Daily cadence absorbs new arrivals correctly; the backlog needs a bounded backfill (`--limit 50000` ≈ 4.2 h/run at `DELAY_MS=300`). |
| `geocode-facilities` | Has reported `success_with_errors` on **7 consecutive daily runs**; last clean `success` was 2026-07-20. The remediation plan §1.1 listed it under "scheduled and healthy." 18 of 150 facilities are `no_match`. |
| F3's eligibility column | `applicantTypes` is hardcoded `[]` in `shapeClientRelevanceProfile`, so `computeEligibility` can only ever return `needs_review` or `unknown` — **never `eligible`**. Measured: 6,372 / 432 across 6,804 pairs. |
| `fundingCategory` self-match | `grant-opportunity-relevance.ts` scores `haystack.includes(category)` where the haystack is the grant's own title+description — a **client-independent** signal awarding 10 points. It was 120 of 183 total signal hits (exactly 12 clients × 10 grants). Clients with zero capabilities and null sector still scored 10. |
| `sector` tokenisation | Only matches single clean tokens. `DEFENSE` (L3 Harris) matched 14 grants; `Defense / Aerospace` (RTX), `GOVERNMENT_AFFAIRS`, `Government Affairs Technology` matched **nothing**. |
| Scorer denominator | The file's doc comment says the score is "a share of the weight that could match… only signals that could be evaluated count toward the denominator." The code divides by the constant `MAX_SCORE = 100`. Doc and code disagree; the difference is material to any floor choice. |
