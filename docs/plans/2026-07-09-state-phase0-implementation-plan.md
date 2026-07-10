# State Legislation — Phase 0 Implementation Plan (the substrate, production-grade)

**Date:** 2026-07-09 · **Parent:** `docs/plans/2026-07-09-state-legislation-platform-plan.md` (§3)
**Scope:** everything required to _serve_ a state client — LegiScan-spine ingestion with a
freshness SLA, the state truth-layer schema, canonical status, per-bill state alerts through
the LegiWatch rail, client association, Meri tools + pinned eval, and the UI surfaces.
**Grounding:** every extension point below was read from the code at `87ff019` (post-#374);
file:line anchors throughout. Where behavior depends on LegiScan, the claim was verified
against the LegiScan API manual (v1.91).
**Blocking assumptions:** (A1) build + staging run on a free LegiScan pull key (30k q/mo);
commercial terms (parent D1) must be resolved before tenant-facing GA, not before build.
(A2) The `state_bill` re-key (parent D3) is approved — Phase 0 executes it while the table
is still consequence-free (nothing tenant-facing references state ids today, verified in §S2.4).

---

## 0. Shape of the phase

```
S1 ingestion  ──┐                        (S1 ∥ S2 can start together; S1's normalize step
S2 schema     ──┴─► S3 status ─► S4 alerts ─► S5 association ─► S7 UI
                                  S6 Meri tools (after S2+S3, ∥ S4)
```

| WS  | What                                                                        | New files (≈)        | Modified files (≈) | Effort |
| --- | --------------------------------------------------------------------------- | -------------------- | ------------------ | ------ |
| S1  | LegiScan client + backfill + 2 sync verbs + schedules + telemetry           | 6                    | 4                  | 4–5 d  |
| S2  | 9 new tables + StateBill/StateLegislator extension + re-key + crosswalk     | 1 migration + models | 2                  | 2–3 d  |
| S3  | `deriveStateBillStatus` in shared + `derive-state-bill-status` verb + specs | 2                    | 2                  | 2 d    |
| S4  | intel-api state rail: repo reads, detector branch, delivery, prefs facet    | 2                    | 7                  | 5–6 d  |
| S5  | watchlist→state matching, track path, `emit-state-changes` (apps/api)       | 2                    | 4                  | 3 d    |
| S6  | 3 new + 1 upgraded Meri tools, resolve_entity, eval pin, catalogs           | 2                    | 6                  | 2 d    |
| S7  | feed facet, tracker jurisdiction, StateBillDrawer, Explorer, chips          | 3                    | 6                  | 4–5 d  |

Total ≈ 3.5–4 wk single-engineer serial; S1+S2 parallelizable to compress week 1.

---

## 1. Locked design decisions (DD1–DD9)

These are cross-cutting; each names the alternative rejected and why.

**DD1 — Canonical state bill key: `"<state>-<sessionKey>-<billnumber>"`**, lowercase, e.g.
`tx-2025-hb1234`, where `sessionKey` = LegiScan `session.year_start` for a regular session and
`${year_start}x${session_id}` for a special session (LegiScan `session.special=1`). Bill
numbers are unique within a session; `session_id` disambiguates specials. Mirrors the federal
`119-hr-8800` convention (`CongressBill.id`, `schema.prisma:2204`). LegiScan `bill_id` (int)
and the OpenStates id are kept as columns + `entity_crosswalk` rows — never as the PK.
_Rejected:_ raw `legiscan_bill_id` PK (opaque, single-vendor lock-in); OpenStates id PK
(the current PK — OpenStates is being demoted to people-only).

**DD2 — LegiScan is the bill spine; OpenStates is people/committees only.** `getMasterListRaw`
returns every bill in a session with a `change_hash` designed for cheap diffing; `getBill`
carries history/sponsors/votes/texts/`sasts`/calendar/supplements in one payload (verified
against the API manual). `sync-openstates.ts` drops its bills loop and keeps `/people`
(sync-openstates.ts:136-168). _Rejected:_ OpenStates bills (20/page hard cap, no push, no
hash-diff — the throttle problem we're deleting).

**DD3 — One detector, partitioned by source — not a forked service.**
`BillChangeDetectorService.runDetectionCycle` already scans ALL `intel_tracked_bill` rows with
no `source` filter (bill-change-detector.service.ts:119-137); a state row today dies silently
at the `!bill` guard (:183-184). We partition the scanned rows on the existing
`source` column (`'congress'|'state'`, intel-api schema.prisma:146) and resolve each partition
against its own reads. The 8 `lastSeen*` watermark columns are jurisdiction-agnostic and are
reused as-is. _Rejected:_ a separate `StateBillChangeDetectorService` (duplicates the
watermark/dedup/fan-out machinery that just stabilized in #374).

**DD4 — Two-rail responsibility split (forced by intel-api's read-only invariant).**
intel-api may not write apps/api tables (invariant documented at
`source-data.repository.ts:9-15`). Therefore:

- **intel-api** owns per-client state alerts: `intel_alert` rows → LegiWatch Feed + email.
- **apps/api** owns the dashboard/changes-inbox surface: a new transition-anchored
  `emit-state-changes` step writes `intelligence_change` rows (source `state_bill`), replacing
  the misleading synced*at count entry (`emit-changes.ts:72-78`). Precedent for apps/api
  raw-reading intel-owned tables for the client fan-out: `tracker-change-detector.service.ts:459-479`.
  \_Rejected:* intel-api writing `intelligence_change` (breaks D2); leaving the count row
  (fires on re-sync, the exact audit complaint).

**DD5 — Jurisdiction facets, additive and default-preserving.**

- `intel_watchlist.jurisdictions String[] @default([])` — empty = federal-only (today's
  behavior, zero migration surprise). Non-empty = also match state corpora for those states.
- `intel_alert_preference.jurisdictions String[] @default([])` — empty = ALL jurisdictions
  (today's subscribers keep getting everything they subscribe to by trigger; state alerts are
  additionally gated by the watchlist opt-in above, so no one gets state spam by default).
- Alert events carry `jurisdiction: 'US' | <state-code>`; `fanOut` filters
  `pref.jurisdictions.length === 0 || pref.jurisdictions.includes(event.jurisdiction)`.
  _Rejected:_ `@default(["US"])` on prefs (would require backfilling every existing row and
  makes "empty" ambiguous).

**DD6 — Matching is keyword-first in Phase 0; semantic is a gated add-on.** Federal
recommendations blend Titan embeddings (`context_embeddings` with hardcoded
`source_type='bill'`, source-data.repository.ts:226) + keyword candidates. Embedding the state
corpus is a separate pipeline decision (volume ≈ 100k+ in-session bills). Phase 0 ships the
keyword/entity/subject path with a state-specific floor
(`LEGIWATCH_STATE_FIT_FLOOR`, default **0.40** vs federal 0.45 — without the 0.40-weight
semantic component, `scoreBillFit`'s max is 0.60, so the federal floor would starve matches).
An `embed-state-bills` job is specced (S5.5) but ships dark; enabling it later restores the
federal floor. _Rejected:_ blocking P0 on embeddings; silently reusing the federal floor.

**DD7 — No bill-text blobs in Phase 0.** The text-changed emitter (B2) anchors on a **date**
watermark, not content (`lastSeenTextDate`, detector :413-424) — LegiScan `texts[]` gives us
`date`/`doc_id`/`state_link` per version, which is all S4 needs. We persist version _metadata_
(`state_bill_version`), not text. Text blobs (for P1 contagion / P2 diffing) follow the
`official_hearing_transcript` precedent (text-in-Postgres, schema.prisma:3814-3834) when
those phases need them. _Rejected:_ S3-bucket text mirroring now (cost + scope with no P0 consumer).

**DD8 — Status vocabulary & precedence (state ≠ federal).** No House-rule mechanic in states →
no `rule_pending/rule_failed`. Union (12):
`introduced | committee | reported | floor | passed_chamber | resolving | to_governor |
enacted | vetoed | veto_overridden | failed | dead_by_deadline`. Derivation spine = LegiScan's
own coded facts, text-regex only as fallback (the exact inverse of the 4-copy regex bug fixed
federally): status ints 1 Introduced / 2 Engrossed→passed*chamber / 3 Enrolled→to_governor /
4 Passed→enacted / 5 Vetoed / 6 Failed; progress events 8 Chaptered→enacted, 7
Override→veto_overridden, 10 Report Pass→reported, 11 Report DNP→failed; own-chamber passage
vote sets from `state_roll_call_vote`; `dead_by_deadline` when the session's `sine_die` has
passed and the bill is non-terminal. Note: the parent plan listed `crossed_over` — dropped;
crossover **is** the `passed_chamber` event (M2's deadline machinery uses the crossover \_date*,
not a distinct status).

**DD9 — Alert rollout is feed-first, email-second, per the existing gates.** The LegiWatch
Feed reads `intel_alert` rows directly (`feed.controller.ts`, `GET :clientId/feed`), but the
email sweep only picks `sourceType ∈ LEGIWATCH_EMIT_SOURCE_TYPES` (default `'bill'`,
intel-alert.service.ts:226-229). So state alerts are **web-visible the moment the detector
writes them** and **email-dark until we flip the env to `bill,state_bill`** — a staged cutover
with no new flag, on top of the existing `owned && TRACKER_ALERTS_ENABLED` gates (:113-114,
live since 2026-07-04; value must be `true|1|yes`, `on` does NOT parse — radar-cutover-rollout.md:123-130).

---

## 2. S1 — Ingestion: LegiScan spine + freshness SLA

### S1.1 LegiScan client module — `apps/api/src/external/legiscan/legiscan.client.ts` (new)

Thin fetch wrapper mirroring `fetchJson` in sync-house-votes.ts:75-93 (3 attempts, backoff,
honor `retry-after` on 429/5xx). Base `https://api.legiscan.com/?key=<KEY>&op=<OP>`. Ops used:

| Op                              | Params                    | Used by               | Returns (fields we consume)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSessionList`                | `state`                   | masterlist sync       | sessions[]: session_id, year_start, year_end, special, session_name, sine_die, prior                                                                                                                                                                                                                                                                                                                                                                                              |
| `getMasterListRaw`              | `id=<session_id>`         | masterlist sync       | masterlist{bill_id → {bill_id, number, change_hash, url, status_date, status, last_action_date, last_action}}                                                                                                                                                                                                                                                                                                                                                                     |
| `getBill`                       | `id=<bill_id>`            | bill drain            | bill{bill_id, change_hash, session{...}, url, state_link, number, bill_type, body, current_body, title, description, status, status_date, progress[], history[{date, action, chamber, importance}], sponsors[{people_id, name, party, role, sponsor_type_id, sponsor_order}], sasts[{type_id, sasts_id}], texts[{doc_id, date, type, mime, state_link}], votes[{roll_call_id, date, desc, yea, nay, nv, absent, total, passed, chamber}], calendar[{type, date, time, location}]} |
| `getRollCall`                   | `id=<roll_call_id>`       | bill drain (per vote) | roll_call{roll_call_id, votes[{people_id, vote_text}], yea, nay, nv, absent, passed, desc, date, chamber}                                                                                                                                                                                                                                                                                                                                                                         |
| `getDatasetList` / `getDataset` | `state` / `id,access_key` | backfill              | weekly ZIP per session (base64), containing bill/people/vote JSON — **no per-bill query cost**                                                                                                                                                                                                                                                                                                                                                                                    |
| `getSessionPeople`              | `id=<session_id>`         | people crosswalk      | people[{people_id, name, party, role, district, …}]                                                                                                                                                                                                                                                                                                                                                                                                                               |

Always use the `id=<session_id>` form of `getMasterListRaw` (the `state=` form is documented
"use with caution"). Pace ≥250 ms between calls (mirrors the 150 ms house-votes pacing, wider
because quota, not rate, is the binding constraint). Every call increments a local counter
persisted per run (S1.6) — LegiScan sends no quota headers, so we self-account.

### S1.2 Cursor/hash state — one new table (in S2's migration)

```prisma
model StateSyncCursor {            // @@map("state_sync_cursor") — GLOBAL, no RLS
  id           String   @id       // "<state>-<session_id>"
  state        String              // "TX"
  sessionId    Int      @map("session_id")
  sessionKey   String   @map("session_key")     // DD1 sessionKey, e.g. "2025"
  billHashes   Json     @default("{}") @map("bill_hashes")  // { "<bill_id>": "<change_hash>" }
  pendingBills Int[]    @default([]) @map("pending_bills")  // drain queue of changed bill_ids
  queriesUsed  Int      @default(0) @map("queries_used")    // month-to-date self-accounting
  quotaMonth   String?  @map("quota_month")                 // "2026-07"; reset on rollover
  lastListAt   DateTime? @map("last_list_at") @db.Timestamptz(6)
  lastDrainAt  DateTime? @map("last_drain_at") @db.Timestamptz(6)
  @@index([state])
}
```

Hash-cache loss is harmless (next masterlist marks everything changed → drain re-upserts,
idempotent). `pendingBills` makes the drain resumable across runs and caps per-run spend.

### S1.3 Verbs (all follow the sync-house-votes template: env config, module-top PrismaClient, `runWithSyncRun`, `[verb]` log prefix, `require.main` guard with `process.exit(1)`)

1. **`backfill-legiscan-datasets`** (`apps/api/scripts/backfill-legiscan-datasets.ts`, new) —
   one-time seed + quota-exhaustion fallback. Env: `LEGISCAN_STATES` (CSV, default the 8
   priority states), `LEGISCAN_SESSIONS=current|all`. Per state: `getDatasetList` → download
   current-session ZIP (`getDataset`), unzip in `TMPDIR` (`/dev/shm` on Fargate —
   entrypoint.sh:44-46, the tsx gotcha), feed every bill JSON through the **same normalize
   function** the drain uses (S1.4), then prime `state_sync_cursor.billHashes` from the
   dataset's hashes. Dataset cost ≈ 2 queries/state/session vs ~100k `getBill` calls — this is
   why backfill-first is mandatory (parent plan §S1).
2. **`sync-legiscan-masterlist`** (new) — per state in `LEGISCAN_STATES`: `getSessionList`
   (cache result in-cursor; refresh weekly), for each non-prior session `getMasterListRaw`,
   diff `change_hash` vs `billHashes`, append changed ids to `pendingBills`, update hashes.
   Cheap: 1–3 queries/state/run.
3. **`sync-legiscan-bills`** (new) — the drain. Env `LEGISCAN_DRAIN_CAP` (default 400/run):
   pop up to cap from all cursors' `pendingBills` (round-robin by state so one busy state
   can't starve others), `getBill` each, normalize+upsert (S1.4), `getRollCall` for each vote
   stub in the payload (skip when `state_roll_call_vote` already has that
   `legiscan_roll_call_id` with same totals — votes are immutable once recorded).
4. **`sync-openstates`** (modified) — delete the bills loop (sync-openstates.ts:100-133);
   keep `/people` (:136-168). Rename nothing (the verb stays `sync-openstates`; entry
   entrypoint.sh:305 unchanged). Add `entity_crosswalk` writes: `idType='openstates_person'`,
   `entityType='state_legislator'`, `entityKey=<state_legislator.id>` once S2 re-keys people.

### S1.4 Normalize/upsert (shared by backfill + drain) — `apps/api/src/ingestion/legiscan-normalize.ts` (new)

Pure function `normalizeLegiscanBill(raw) → {bill, actions[], sponsors[], votes[], versions[], links[], calendar[]}`
keyed by DD1. Upsert transaction per bill (the house-votes pattern, :200-207) with
**per-child-table strategies chosen for watermark integrity** (verification findings — a
blanket delete-and-recreate would reset `firstSeenAt` and fabricate momentum evidence):

- `state_bill_action`: **append-only via anti-join** on `(billKey, date, orderKey)` — history
  is cumulative; existing rows (and their `firstSeenAt`) are never touched. **This invariant
  is what the SLA metric (S1.6) measures**; a spec asserts `firstSeenAt` is byte-stable
  across two drains of the same bill.
- `state_bill_sponsor`: **diff-sync** — insert new via anti-join on
  `(billKey, legiscanPeopleId)` (stamping `firstSeenAt`), delete rows absent from the payload
  (withdrawals), never blanket-recreate — preserving `firstSeenAt` on retained sponsors,
  the only honest anchor for sponsor momentum (LegiScan carries no per-sponsor add-date; S4.2).
- `state_bill_version` / `state_bill_link` / `state_bill_calendar_event`: delete-and-recreate
  (small sets, no watermark semantics).
- Votes: upserted by natural id, never deleted — they accrete.

Exported for unit tests exactly like `houseRollId`/`resolveHouseBillId` (sync-house-votes.ts:59-73).

### S1.5 Secrets, env, schedules

- **Secret (4 steps, in order — the LDA lesson is that (c) gets skipped):**
  (a) create `capiro/dev/legiscan_api_key` in Secrets Manager (no leading slash);
  (b) inline-policy grant `secretsmanager:GetSecretValue|DescribeSecret` on the migrate-family
  exec role (precedent `SyncTaskApiKeysExtra`, fed-ingestion-remediation-2026-06-05.md:34-44);
  (c) clone + register a new `capiro-dev-api-migrate` revision adding
  `{name: LEGISCAN_API_KEY, valueFrom: <arn>}` to `secrets` (out-of-band — **never**
  `cdk deploy` Compute); EventBridge auto-adopts (family-ARN targeting);
  (d) add `LEGISCAN_API_KEY` to `preflight-ingestion.ts:37-47` KEYS as `required`.
- **entrypoint.sh:** 3 new cases + usage-string entries (backfill-legiscan-datasets,
  sync-legiscan-masterlist, sync-legiscan-bills).
- **`INGESTION_JOBS` rows** (infra/cdk/lib/ingestion-schedule.ts; matrix is source of truth,
  live rules created out-of-band per docs/runbooks/out-of-band-ingestion-deploy.md):

| id                           | command                                                           | cron                                                                                                                                                                           | tier    |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `SyncLegiscanMasterlist`     | `['sync-legiscan-masterlist']`                                    | `{minute:'10', hour:'*'}` (hourly; priority states via `LEGISCAN_STATES` in the rule's containerOverrides env — the PE_ALERT_EMAIL_TENANTS trick, flips without a td revision) | daily   |
| `SyncLegiscanMasterlistWide` | `['sync-legiscan-masterlist']` + env `LEGISCAN_STATES=<other 43>` | `{minute:'25', hour:'1/6'}`                                                                                                                                                    | daily   |
| `SyncLegiscanBills`          | `['sync-legiscan-bills']`                                         | `{minute:'30', hour:'*'}`                                                                                                                                                      | daily   |
| `DeriveStateBillStatus`      | `['derive-state-bill-status']`                                    | `{minute:'50', hour:'0/6'}` (after drains; S3)                                                                                                                                 | derived |
| `EmitStateChanges`           | `['emit-state-changes']`                                          | `{minute:'55', hour:'0/6'}` (S5)                                                                                                                                               | derived |

Rule names: `capiro-dev-<kebab-id>`; target family `capiro-dev-api-migrate`; invoker role
`capiro-dev-eventbridge-sync-invoker`; failures already alarmed by
`capiro-dev-sync-task-failures` → SNS `capiro-dev-alerts` (pe-watch plan :378-382).

- **Quota math (validate in week 1, A1) — with the fan-out factors made explicit:**
  masterlist calls are per _session_, not per state: with `s` = active sessions/state (≈1.0
  off-special-season, up to 2–3 during specials), masterlists ≈ (8×24×30 + 43×4×30) × s ≈
  **11k×s/mo** + sessionList/dataset overhead ≈ 1k. Drains cost `1 + v` queries per changed
  bill, where `v` = _new_ roll calls needing `getRollCall` (we skip refetch when the
  `legiscan_roll_call_id` already exists with the same totals — votes are immutable — so `v`
  applies only to bills whose payload shows unseen votes; blended `v` ≈ 0.3–1). Steady-state
  budget at s=1, v=0.5: ~16k remaining → **~350 changed bills/day**; peak season (Jan–Apr) or
  special-session stacking (s→2) drops that to ~150–200/day and can breach the ceiling —
  exactly the parent plan's warning, now quantified. Governor: `sync-legiscan-bills` stops
  when month-to-date `queriesUsed` across cursors exceeds `LEGISCAN_MONTHLY_BUDGET` (default
  28000, headroom under the 30k hard cap) and logs `INGESTION_SKIP quota`; fallback = weekly
  `backfill-legiscan-datasets` refresh (2 q/state) instead of drains for non-priority states.
  The step-10 exit review compares actual `queriesUsed` against these factors and feeds D1
  (commercial/Push upgrade).

### S1.6 Telemetry — the SLA number

- `state_bill_action.firstSeenAt` (timestamptz, default now, set only on insert).
- Extend `diag-ingestion-health.ts` (already lists state_bill at :51): per state, report
  `p50/p95 of (firstSeenAt − action.date)` over trailing 7 d + `last-successful-sync age` from
  `sync_run` (source in the 3 new verbs). Ingestion lag, NOT legislative recency.
- Each verb already emits `INGESTION_METRIC` via `runWithSyncRun` (sync-run.helper.ts:77-91)
  → existing CloudWatch metric filter picks up `error_count` (compute-stack.ts:1111-1118).

### S1 success criteria

| #    | Criterion                                                                                                                                                                                       | How verified                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| S1-A | Backfill of 1 pilot state (TX) completes: `state_bill` rows == the dataset's bill count ±0, all with DD1 keys; `sync_run` rows status `success`                                                 | row-count vs dataset manifest; `SELECT status FROM sync_run WHERE source LIKE 'backfill-legiscan%'` |
| S1-B | Steady-state: a hash flip on LegiScan produces updated `state_bill` + new `state_bill_action` rows on the next masterlist+drain pair, and `queriesUsed` grows by ≤ (changed bills + list calls) | staging: mutate one cursor hash, run both verbs, assert diff-only fetches from logs                 |
| S1-C | SLA telemetry live: `diag-ingestion-health` prints per-state lag percentiles; priority-state p95 ≤ 60 min over a 72 h window                                                                    | run the diag verb after 72 h of scheduled operation                                                 |
| S1-D | Quota governor: with `LEGISCAN_MONTHLY_BUDGET=50` in staging, the drain stops with `INGESTION_SKIP quota` and resumes next month-bucket                                                         | unit test on the governor + one staging run                                                         |
| S1-E | Zero regression on people: `sync-openstates` still upserts legislators (count ≥ previous run) with the bills loop removed                                                                       | `sync_run` counts before/after                                                                      |

---

## 3. S2 — Schema: the state truth layer

One hand-stamped migration `20260710000000_state_truth_layer/migration.sql` (convention:
round-hour timestamp + snake_case slug, per the 5 newest migration dirs). All tables GLOBAL —
no tenant_id, no RLS (the source-table convention, schema.prisma:3698 comment style). Prisma
conventions copied from the federal mirrors (federal-truth-table audit): natural-string `@id`
for source-keyed rows, `@default(uuid()) @db.Uuid` for children, `lastSyncedAt`/`@db.Timestamptz(6)`,
`@db.Date` for calendar dates, soft refs across sources, hard FK + cascade for strict children.

### S2.1 `StateBill` — extended in place (`@@map("state_bill")` unchanged, so the Explorer read path survives)

Added: `sessionKey String @map("session_key")` (DD1), `billNumber String @map("bill_number")`
("HB1234"), `status String?` + index, `statusAt DateTime? @map("status_at") @db.Timestamptz(6)`,
`statusSource String? @map("status_source")` ('derived'), `textDate DateTime? @map("text_date") @db.Timestamptz(6)`
(latest `texts[].date` — the B2 watermark), `description String? @db.Text` (LegiScan
description → Explorer "abstract"), `legiscanBillId Int? @unique @map("legiscan_bill_id")`,
`legiscanChangeHash String? @map("legiscan_change_hash")`, `openstatesId String? @map("openstates_id")`,
`stateUrl String? @map("state_url")` (official `state_link`; existing `url` keeps the LegiScan/OpenStates link),
`sponsorCount Int @default(0) @map("sponsor_count")`, `lastSyncedAt` (rename of `syncedAt`? —
**no**: keep `syncedAt` as-is; `emit-changes` and diag reference `synced_at` today and S5
retires that read on its own schedule). `id` becomes the DD1 key (re-key, S2.4).
New indexes: `@@index([state, status])`, `@@index([legiscanBillId])`.

### S2.2 New models (fields abbreviated here; the migration carries the full DDL — mirror-source noted per table)

- **`StateBillAction`** (`state_bill_action`; mirrors CongressBillAction :2482 + `firstSeenAt`):
  `id uuid @db.Uuid`, `billKey @map("bill_key")` → FK cascade `StateBill.id`, `date @db.Date`
  (LegiScan history dates are calendar dates), `text @db.Text`, `chamber String?`,
  `importance Int?` (LegiScan's own significance bit), `orderKey Int` (stable sort within a
  day — LegiScan history array order), `firstSeenAt DateTime @default(now()) @db.Timestamptz(6)`.
  `@@unique([billKey, date, orderKey])`, `@@index([billKey, date])`, `@@index([firstSeenAt])`.
- **`StateBillSponsor`** (`state_bill_sponsor`; mirrors CongressBillCosponsor :2304):
  `id uuid`, `billKey` FK cascade, `legiscanPeopleId Int? @map("legiscan_people_id")`,
  `legislatorId String? @map("legislator_id")` (soft ref → state_legislator via crosswalk),
  `name`, `party String?`, `sponsorType String @map("sponsor_type")` ('primary'|'cosponsor',
  from LegiScan sponsor_type_id 1=primary), `sponsorOrder Int @map("sponsor_order")`,
  `firstSeenAt DateTime @default(now()) @map("first_seen_at") @db.Timestamptz(6)` (set once
  by the S1.4 anti-join — the momentum window anchor; LegiScan has no sponsorship date),
  `lastSyncedAt`. `@@unique([billKey, legiscanPeopleId])`, `@@index([legislatorId])`.
- **`StateRollCallVote`** (`state_roll_call_vote`; mirrors RollCallVote :2395):
  `id String @id` = `"<state>-rc-<legiscan_roll_call_id>"`, `billKey` soft ref + index,
  `legiscanRollCallId Int @unique @map("legiscan_roll_call_id")`, `chamber`, `date @db.Date`,
  `motion String? @db.Text` (desc), `yeas/nays/nv/absent Int @default(0)`,
  `passed Boolean?`, `sourceUrl String? @map("source_url")`, `lastSyncedAt`.
  `@@index([billKey])`, `@@index([date(sort: Desc)])`.
- **`StateMemberVote`** (`state_member_vote`; mirrors MemberVote :2429): `id uuid`,
  `voteId` FK cascade → StateRollCallVote, `legiscanPeopleId Int @map("legiscan_people_id")`,
  `legislatorId String? @map("legislator_id")` (crosswalk-resolved, null until resolved —
  the Senate-LIS lag pattern), `voteCast @map("vote_cast")` (Yea|Nay|NV|Absent from vote_text).
  `@@unique([voteId, legiscanPeopleId])`, `@@index([legislatorId])`.
- **`StateBillVersion`** (`state_bill_version`; metadata only per DD7): `id uuid`, `billKey`
  FK cascade, `legiscanDocId Int @unique @map("legiscan_doc_id")`, `versionType @map("version_type")`
  (LegiScan texts[].type: Introduced|Amended|Engrossed|Enrolled|Chaptered|Comm Sub|…),
  `date @db.Date`, `stateUrl @map("state_url")`, `mime String?`, `lastSyncedAt`.
  `@@index([billKey, date])`.
- **`StateBillLink`** (`state_bill_link`; mirrors BillRuleLink :2452, generalized):
  `id uuid`, `billKey @map("bill_key")`, `relatedBillKey String? @map("related_bill_key")`
  (null when the sasts target isn't ingested yet), `legiscanRelatedBillId Int @map("legiscan_related_bill_id")`,
  `linkType @map("link_type")` (LegiScan sasts type_id → 'same_as'|'companion'|'similar'|'replaces'|'replaced_by'),
  `lastSyncedAt`. `@@unique([billKey, legiscanRelatedBillId])`, `@@index([relatedBillKey])`.
- **`StateBillCalendarEvent`** (`state_bill_calendar_event`; mirrors CommitteeHearingBill's
  soft-link shape :3794, flattened since LegiScan events arrive per-bill): `id uuid`,
  `billKey` FK cascade, `eventType @map("event_type")` (LegiScan calendar[].type: hearing|
  executive session|floor), `date @db.Date`, `time String?`, `location String?`,
  `eventKey @map("event_key")` (`"<billKey>:<type>:<date>:<location>"` — the
  `lastSeenHearingKey` watermark value), `lastSyncedAt`.
  `@@unique([billKey, eventKey])`, `@@index([date])`. Calendar entries are replaced on each
  bill drain (delete-and-recreate child pattern).
- **`StateSession`** (`state_session`): `id String @id` = `"<state>-<session_id>"`,
  `state`, `legiscanSessionId Int @unique @map("legiscan_session_id")`, `sessionKey @map("session_key")`,
  `name`, `yearStart Int @map("year_start")`, `yearEnd Int @map("year_end")`,
  `special Boolean @default(false)`, `sineDie DateTime? @map("sine_die") @db.Date`
  (LegiScan provides it; M2 adds crossover/cutoff columns later), `prior Boolean @default(false)`,
  `lastSyncedAt`. `@@index([state])`.
- **`StateSyncCursor`** (S1.2).
- **`StateCommittee`** (`state_committee`; parent §S2 commitment — added now, thin):
  `id String @id` = `"<state>-<chamber>-<slug(name)>"`, `state`, `chamber String?`, `name`,
  `legiscanCommitteeId Int? @unique @map("legiscan_committee_id")`, `lastSyncedAt`.
  Populated from `getBill.committee` refs during the drain; roster normalization (from
  `StateLegislator.committees` Json) stays Phase 1 as the parent scopes it.
- **Deviations from parent §S2 (explicit, per the no-shortcuts bar):** `state_bill_action`
  drops the parent's `classification[]` (LegiScan history rows carry no classification —
  `importance` is what exists; status derivation uses coded status/progress instead);
  `state_bill_sponsor` drops `date`/`withdrawn` (LegiScan carries neither — `firstSeenAt`
  is the honest add-signal, withdrawal = diff-sync deletion; revisit if OpenStates
  cross-check lands); `state_session` has no `convene` (LegiScan supplies `sine_die` only;
  convene dates come from NCSL curation in M2).
- **`StateLegislator`** — extended: `legiscanPeopleId Int? @unique @map("legiscan_people_id")`
  (populated by `getSessionPeople` join on name+district+party during the drain, else by the
  weekly people sync), keep everything else as-is (people re-key NOT needed — OpenStates person
  id stays the PK; crosswalk rows carry the LegiScan id).

### S2.3 Crosswalk + shared id vocabulary

- `entity_crosswalk` rows written by S1: (`legiscan_bill`, `<bill_id>`, `state_bill`, `<DD1 key>`),
  (`openstates_bill`, `<old id>`, `state_bill`, `<DD1 key>`) during re-key, (`legiscan_people`,
  …, `state_legislator`, …), (`openstates_person`, …). Uses the existing generic model
  (schema.prisma:2373) — no schema change.
- `packages/shared` `CANONICAL_ID_TYPES` (index.ts:658-671): add `stateBillKey` with a
  validator `/^[a-z]{2}-\d{4}(x\d+)?-[a-z]+\d+[a-z]?$/` + normalizer (lowercase, strip
  whitespace/periods, "TX HB 1234" designation parser `parseStateBillDesignation(query,
state?, sessionKey?)` — the state twin of `parseBillDesignation`). Consumed by S6.

### S2.4 The re-key (safe because nothing references state ids)

Verified blast radius of changing `state_bill.id` semantics: `searchStateBills`
(meri-tools.service.ts:2824) — id is pass-through display; Explorer rows/detail
(`/api/explorer/state-bills*`) — pass-through; **no `intel_tracked_bill` state rows can exist**
(`trackBill` 404s non-federal ids today, tracker-board.service.ts:542-543); no FKs into
state_bill. Mechanic: the S2 migration **truncates** `state_bill`/`state_legislator`-dependent
new tables trivially (they're empty) and clears `state_bill` (wipe-and-resync per parent plan;
old OpenStates rows are re-created under DD1 keys by the S1 backfill the same day). Data
Explorer would otherwise show empty states for as long as each state waits its backfill turn —
so runbook step 3 runs `backfill-legiscan-datasets` for **all 50 states+DC immediately after
the migration** (~2 queries/state ≈ ~110 total — cheap), closing the gap to one same-day pass
before any sync schedules are enabled.

### S2 success criteria

| #    | Criterion                                                                                                                                 | How verified                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| S2-A | `prisma migrate deploy` clean on a scratch DB + `prisma generate` compiles; migration is additive except the documented `state_bill` wipe | CI typecheck + local migrate run                                                                                          |
| S2-B | Every new table matches its federal mirror's conventions (uuid children, timestamptz, soft/hard refs per DD table)                        | schema review against §S2.2 checklist in PR                                                                               |
| S2-C | Post-backfill TX: >99% of `state_bill_sponsor.legiscanPeopleId` join to a `state_legislator` via crosswalk; unresolved logged             | SQL join-coverage query in the runbook                                                                                    |
| S2-D | `entity_crosswalk` carries both id families for 100% of backfilled TX bills                                                               | `SELECT count(*) FROM entity_crosswalk WHERE entity_type='state_bill' AND id_type IN ('legiscan_bill','openstates_bill')` |
| S2-E | Explorer state list + detail render against the re-keyed data with zero code change (S7 upgrades come later)                              | staging click-through                                                                                                     |

---

## 4. S3 — Canonical status: `deriveStateBillStatus` (@capiro/shared)

### S3.1 Shared block (packages/shared/src/index.ts, adjacent to the federal block at :980-1103)

- `type StateBillStatus` (12 values, DD8) + `STATE_BILL_STATUS_META: Record<StateBillStatus,
{label, rank}>` (introduced 0, committee 1, reported 2, floor 3, passed_chamber 4,
  resolving 5, to_governor 6, enacted/vetoed/veto_overridden/failed/dead_by_deadline 9) +
  `stateBillStatusLabel()` — the exact federal meta pattern (:1004-1029; meta not exported,
  label fn is).
- `deriveStateBillStatus(input: { legiscanStatus?: number|null; progressEvents?: Array<{event:
number; date: string}>|null; latestActionText?: string|null; passedChamber?: boolean;
failedChamber?: boolean; vetoed?: boolean; overridden?: boolean; sessionSineDie?:
string|null; today?: string }): StateBillStatusResult`. Branch order (first match wins),
  mirroring the federal function's fact-over-regex philosophy (:1031-1089):
  1. progress 8 (Chaptered) or status 4 → `enacted`
  2. `overridden` flag or progress 7 → `veto_overridden`
  3. status 5 → `vetoed`
  4. status 6 or progress 11 (Report DNP) → `failed`
  5. status 3 (Enrolled) → `to_governor`
  6. regex `/(amendments? (between|from)|concur|conference committee|refuse[sd] to concur)/i`
     → `resolving`
  7. `passedChamber` flag or status 2 (Engrossed) → `passed_chamber`
  8. `failedChamber` flag → `failed`
  9. `sessionSineDie < today` and none of the above terminal → `dead_by_deadline`
  10. progress 10 (Report Pass) or `/reported (favorably|out of committee)/i` → `reported`
  11. regex `/(referred|committee|hearing|markup)/i` → `committee`; `/calendar|second reading|third reading|floor/i` → `floor`
  12. else `introduced`
      Note step 9 sits AFTER terminals but BEFORE committee-ish fallbacks: a dead-by-calendar bill
      with stale committee text reads dead, which is the truthful answer (the state twin of the
      H.R. 8800 lesson).
- `classifyStateVoteMotion(motion)` — passage-question classifier for vote sets ('third
  reading', 'final passage', 'on passage', 'concur', excludes 'committee'/'amendment'
  motions) — the state twin of `isPassageQuestion` (derive-bill-status.ts:38-43).
- `humanizeStateBillKey('tx-2025-hb1234') → 'TX HB 1234'` + `stateBillSessionLabel()` —
  needed by S4 evidence and S7.

### S3.2 Verb — `apps/api/scripts/derive-state-bill-status.ts` (new; template = derive-bill-status.ts three-phase shape)

1. Passage/veto sets: `state_roll_call_vote` non-null `passed`, filter
   `classifyStateVoteMotion` → `passedChamber`/`failedChamber` sets by billKey, keyed on
   each bill's MOST RECENT qualifying vote (2026-07-10 hot-fix: a bill that failed then
   was later reconsidered and passed must land in `passedChamber` only, never both —
   see `buildPassageOutcomeSets`). **Amended 2026-07-10 (D-3):** the `overridden` set is
   NOT vote-derived — `classifyStateVoteMotion`'s allowed-motion regex excludes anything
   containing "override" by design, and no override-specific roll-call classifier exists.
   The overridden signal is progress-event-7 (`legiscanProgress` code) plus a text-regex
   fallback (`OVERRIDDEN_TEXT`) only, exactly as shipped in
   `derive-state-bill-status.ts`. Building a vote-derived override set would require
   verifying override roll-calls actually appear as distinct `state_roll_call_vote` rows
   in live LegiScan data — unconfirmed from this environment — so the plan is amended to
   match the verified, shipped signal rather than the unverified one.
2. Sessions: `state_session` map for `sineDie`.
3. Recompute every bill in `LEGISCAN_STATES` scope: `deriveStateBillStatus(...)` →
   `stateBill.update({status, statusAt: latestActionDate ?? textDate ?? now, statusSource:
'derived'})`, **write only when changed** (unlike the federal verb's unconditional
   rewrite — 100k+ state rows make no-op writes worth skipping; deviation noted).
   Idempotent pure recompute; per-bill try/catch; `runWithSyncRun('derive-state-bill-status')`.

- entrypoint case + `INGESTION_JOBS` row (S1.5 table).

### S3.3 Tests

- `packages/shared` — unit spec colocated with the federal one's pattern
  (`apps/api/src/ingestion/bill-status.spec.ts` precedent): pure-function table tests for all
  12 statuses + the ordering traps (engrossed+sine-die-passed → passed_chamber? NO —
  passed_chamber is non-terminal, so step 9 fires first → `dead_by_deadline`; enrolled beats
  sine-die (to_governor is step 5): both pinned).
- `apps/api/scripts/derive-state-bill-status.spec.ts` — motion-classifier + set-building unit
  tests (exported helpers, the sync-house-votes exported-helper pattern).

### S3 success criteria

| #    | Criterion                                                                                                                                                                                                                                                                            | How verified                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| S3-A | Table-driven spec covers all 12 statuses + 6 precedence traps; green in `pnpm --filter @capiro/shared test` (or api jest suite if shared has no runner — spec placement decided in PR)                                                                                               | local jest                                    |
| S3-B | Backtest on the TX backfill: derived status agrees with LegiScan's own `status` int mapping for ≥98% of terminal-status bills (enacted/vetoed/failed); disagreements listed and explained                                                                                            | one-off SQL + script report in PR description |
| S3-C | `derive-state-bill-status` on TX (≈8–10k bills) completes < 5 min, updates only changed rows on second run (idempotency: second-run updated-count = 0)                                                                                                                               | staging run logs                              |
| S3-D | A crossover-dead fixture (real TX bill that died at a deadline with committee-ish final action) derives `dead_by_deadline` — the same fixture the S6 eval pins                                                                                                                       | shared unit spec                              |
| S3-E | Non-terminal progress-code mappings are fixture-proven, not asserted: a frozen real `getBill` payload per branch — `reported` (progress 10) and `veto_overridden` (progress 7) — derives correctly (S3-B only backtests terminals, so a wrong non-terminal map would otherwise pass) | frozen fixtures in the shared table spec      |

---

## 5. S4 — State alerts through the LegiWatch rail (intel-api)

### S4.1 intel-api migration (its own prisma/migrations, applied via `capiro-dev-intel-api-migrate`)

- `intel_bill_match`: `ALTER congress DROP NOT NULL` + `jurisdiction String @default("US")`
  (schema :187-201; congress is meaningless for state rows).
- `intel_watchlist`: `jurisdictions String[] @default([])` (DD5).
- `intel_alert_preference`: `jurisdictions String[] @default([])` (DD5).
- `intel_tracked_bill`: **no change** — `source` column (:146) + all 8 `lastSeen*` watermarks
  (:141-179) are reused verbatim.
- RLS: new columns on already-policied tables — no policy work (policies are per-table,
  migration `20260706010000_intel_full_rls_hold` + :37-41 precedent for new-table policy —
  not needed here since no new intel tables).

### S4.2 Read layer — extend `SourceDataRepository` (read-only raw SQL, same file)

New methods (shapes mirror the congress ones at source-data.repository.ts:27-91; all against
the shared physical DB, global tables, no GUC):

| Method                                    | SQL target                                                                                                                                                                                                                           | Returns                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getStateBillsByIds(keys)`                | `state_bill` ANY                                                                                                                                                                                                                     | `SourceStateBill{id, state, sessionKey, identifier, title, status, statusAt, latestActionText, latestActionDate, textDate, sponsorCount, stateUrl, url, subjects}` |
| `getStateBillById(key)`                   | `state_bill`                                                                                                                                                                                                                         | one row (track-path validation)                                                                                                                                    |
| `getStateBillActionsByIds(keys)`          | `state_bill_action` ANY, date ASC                                                                                                                                                                                                    | `SourceBillAction`-shaped (id, billId←billKey, date, text, chamber) — reuses the existing interface so `selectMaterialEvents` works unchanged                      |
| `getStateSponsorMomentum(keys, days)`     | `state_bill_sponsor` GROUP BY bill_key, window on **`first_seen_at`** (NOT `last_synced_at` — the federal analog windows on the real `sponsorship_date`, :293-310; sync time would report the whole sponsor list as "new this week") | `SourceCosponsorMomentum`-shaped (liveCount, new7d, recentNames)                                                                                                   |
| `getStateVotesForBills(keys)`             | `state_roll_call_vote` latest per bill                                                                                                                                                                                               | `{billKey, chamber, motion, yeas, nays, passed, date, sourceUrl}`                                                                                                  |
| `getUpcomingStateEventsForBills(keys)`    | `state_bill_calendar_event` WHERE date >= CURRENT_DATE, soonest per bill                                                                                                                                                             | `SourceHearingForBill`-shaped (billId←billKey, hearingId←eventKey, title←eventType, date, url←stateUrl) so the federal B3 builder works unchanged                  |
| `getMovedCompanions(keys)`                | `state_bill_link` JOIN `state_bill` on related key WHERE related `status_at` advanced                                                                                                                                                | `{billKey, relatedBillKey, relatedDisplay, relatedStatus, relatedStatusAt, linkType}`                                                                              |
| `stateKeywordCandidateIds(terms, states)` | `state_bill` WHERE state=ANY + (title ILIKE any / subjects && terms), LIMIT 300                                                                                                                                                      | `string[]` keys (S5)                                                                                                                                               |

### S4.3 Detector branch (`bill-change-detector.service.ts`)

- `runDetectionCycle` (:104): partition `rows` by `row.source` after the scan (:119-137 —
  the scan already returns `source`? **No — add `source: true` to the select at :123**).
  Congress partition: unchanged path. State partition: batch-fetch via the state reads,
  build the same `Watermark` shape (:201-209) from state fields
  (`status→lastSeenStatus, sponsorCount→lastSeenCosponsors, textDate→lastSeenTextDate,
latestActionText/Date`, `hearingKey = soonestStateEvent?.eventKey ?? row.lastSeenHearingKey`
  — the federal :201-209 pattern, so the hearing emitter both fires and advances; **only
  `fiscalId` stays null in P0**).
- **Event inventory (state):**

| Event                    | changeType                                                                                                    | triggerKey                                                                                                                                                                          | Anchor                                                                                                                                                                                                                                                                                                         | Evidence extras                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Status transition        | `state_bill_<status>` (e.g. `state_bill_passed_chamber`, `state_bill_enacted`, `state_bill_dead_by_deadline`) | status→key map: enacted/vetoed/failed/dead_by_deadline→`enactedFailed`; passed_chamber/floor/to_governor/veto_overridden/resolving→`floorVote`; reported→`committeeVote`            | `SourceStateBill.status` vs `lastSeenStatus` (the federal B5 shape, `classifyStatusChange` :138-159 generalized to a lookup table)                                                                                                                                                                             | latest passage vote tally + motion when present (`getStateVotesForBills`)                                               |
| Action text              | reuse federal `classifyChange` output classes where they match; unmatched → `bill_action` info                | per classifyChange (:26-122)                                                                                                                                                        | `latestActionText/Date` vs watermarks — same code path, state partition feeds it state rows                                                                                                                                                                                                                    | verbatim action text + `stateUrl`                                                                                       |
| Vote recorded            | `state_bill_vote_recorded`                                                                                    | `floorVote` or `committeeVote` by `classifyStateVoteMotion`                                                                                                                         | new `state_roll_call_vote` row for a tracked bill (`lastSyncedAt` > `row.lastSeenAt`; votes upsert-once so this is first-sight; 14-day changeType dedup guards re-runs) — parent's "vote tally" day-one emitter as a first-class event, so a failed floor vote that doesn't move canonical status still alerts | motion, tally, passed; **per-member breakdown deferred** to crosswalk hardening (S6.1 note) — explicit parent deviation |
| Text/version changed     | `bill_text_changed`                                                                                           | `amendment`                                                                                                                                                                         | `textDate` vs `lastSeenTextDate` (federal B2 :413-424)                                                                                                                                                                                                                                                         | latest `state_bill_version.versionType`                                                                                 |
| Sponsor momentum         | `bill_cosponsor_momentum`                                                                                     | `sponsorMomentum`                                                                                                                                                                   | `sponsorCount` vs `lastSeenCosponsors` && `new7d ≥ LEGIWATCH_COSPONSOR_MIN_7D` (B8 :394-409)                                                                                                                                                                                                                   | recent sponsor names                                                                                                    |
| Hearing/agenda scheduled | `bill_hearing_scheduled`                                                                                      | `hearing`                                                                                                                                                                           | soonest upcoming `state_bill_calendar_event.eventKey` ≠ `lastSeenHearingKey` (federal B3 :430-448, builder unchanged)                                                                                                                                                                                          | eventType, date, time, location                                                                                         |
| Companion moved          | `state_companion_moved`                                                                                       | `companion` (**first emitter ever for this key** — it's in `DEFAULT_TRIGGERS`, tracker-watchlist.service.ts:71-81 / mirrored at tracker.types.ts:25-33, but federal never emits it) | `getMovedCompanions`: related bill's `statusAt` > this row's `lastSeenAt`                                                                                                                                                                                                                                      | related display/status/link type                                                                                        |
| New match                | `bill_new_match`                                                                                              | `newMatch`                                                                                                                                                                          | S5 (new-match cycle)                                                                                                                                                                                                                                                                                           | fit, matchedTags                                                                                                        |

- All state events set `jurisdiction: <state>` in `MaterialEvent.extra` → lands in
  `evidence.jurisdiction`; `evidence.displayNum = humanizeStateBillKey(key)`;
  `evidence.sourceUrl = stateUrl ?? url` (official first).
- `writeShadowAlert` (:465-539): parameterize `sourceType` (arg, `'bill' | 'state_bill'`) in
  BOTH the create (:507) and the 14-day dedup where-clause (:474-493, sourceType at :486).
  Same for `new-match-detector.service.ts:149`.
- **All five parent-flagged `sourceType:'bill'` seams accounted for:** detector (:485/:507)
  and new-match (:149) — parameterized above; `tracker-board.service.ts:306/:415` (board
  cards' recent-alert annotations) — **must widen to `sourceType: { in: ['bill','state_bill'] }`**,
  or state rows on the board (S7.6) silently lose their change chips; `parity.service.ts:76` —
  intentionally left congress-only (parity reconciles against the legacy
  `intelligence_change` baseline, which has no state history); `bill-hearing-linker.service.ts:221`
  — out of scope (links hearing _transcription_ sessions, an O3 concern).
- First-sighting baseline + `derivedBaselined` logic (:212-226) applies unchanged — first
  state sweep baselines, never alerts (no alert storm at cutover; explicitly tested).

### S4.4 Delivery (`intel-alert.service.ts`) + prefs

- Sweep: add `'state_bill'` to the event-builder branch — the builder (:241-260) is
  field-driven off `evidence`, so the only change is `jurisdiction: ev.jurisdiction ?? 'US'`
  on the event + subject already correct via `displayNum` (`[Capiro] TX HB 1234: Passed
chamber`). Email body remains the Workstream-C shared template work (parent plan §3 S4 —
  one template, two sources; until then state emails get the same bare-subject body as federal).
  LLM enrichment on state alerts = **Tier 1 of the agentic-intelligence architecture**
  (`docs/plans/2026-07-09-agentic-intelligence-architecture.md`): the W-D internal endpoint
  takes the rail-agnostic event envelope, so state events get L1 explanation + L2 client-impact
  JSON with zero state-specific LLM code — fail-open, never blocking delivery.
- `fanOut` (:93-194): add the DD5 jurisdiction filter next to the trigger/materiality checks
  (:131-134). `claim()` idempotency + shadow path untouched.
- `LEGIWATCH_EMIT_SOURCE_TYPES`: staged flip per DD9 (feed-first; email after S4-E passes).
- Prefs API: `alert-prefs` GET/PUT (tracker-watchlist.controller.ts:53-58) + web
  `AlertPrefsPayload` (tracker-api.ts:153-165) + `prefsToIntel`/`adaptPrefs`
  (intel-tracker-api.ts:237-267) gain `jurisdictions: string[]` (S7 renders it).

### S4.5 Track path

`trackBill` (tracker-board.service.ts:535-579): detect a DD1-shaped id
(`isStateBillKey()` from shared) → validate via `getStateBillById` (404 preserved), set
`source:'state'`, `stage` from `STATE_BILL_STATUS_META` rank bucketed to the 4 board columns
(introduced/committee→In committee/passed_chamber…/enacted — the board's `BILL_STAGES`
labels, shared :804-809), seed watermarks from the state row (same fields as :560-570).

### S4 success criteria

| #    | Criterion                                                                                                                                                                                                                                                                                                         | How verified                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| S4-A | intel-api migration applies; existing federal detector specs still green (`pnpm --filter @capiro/intel-api test` locally — suite not in CI, comment ci-pr.yml:73-81)                                                                                                                                              | local jest, both apps                                                                                    |
| S4-B | Baseline-not-alert: tracking a state bill then running the detector produces ZERO alerts on first sweep, watermarks populated                                                                                                                                                                                     | new spec `state-bill-change-detector.spec.ts` (fake repo pattern from existing detector specs) + staging |
| S4-C | Each state event fires exactly once: staged fixture mutates status/textDate/sponsorCount/companion/calendar/vote in staging → 6 `intel_alert` rows `sourceType='state_bill'` with verbatim `evidence.actionText`, `jurisdiction`, `displayNum`, official `sourceUrl`; re-run detector → 0 new rows (14-day dedup) | staging replay script + SQL asserts                                                                      |
| S4-D | Feed-first: rows from S4-C appear in `GET /intel-api/clients/:id/feed?sourceType=state_bill` BEFORE any email flip                                                                                                                                                                                                | curl in staging                                                                                          |
| S4-E | Email: with `LEGIWATCH_EMIT_SOURCE_TYPES=bill,state_bill` on the intel-api enableflag/serve tds, a subscribed pref (triggers incl. the key, jurisdiction matching) receives exactly one SES email; `intel_notification_log` unique row; non-matching jurisdiction pref receives none                              | staging with seeded prefs; log + SES sandbox assert                                                      |
| S4-F | Companion first-light: the `companion` trigger key emits for a real TX same-as pair                                                                                                                                                                                                                               | staging fixture from backfilled sasts data                                                               |
| S4-G | No federal regression: federal fixture replay (the #374 staging suite) byte-identical alert output before/after the branch refactor                                                                                                                                                                               | replay diff                                                                                              |

---

## 6. S5 — Client ↔ state association

### S5.1 Watchlist → state matching (intel-api)

- `intel_watchlist.jurisdictions` (S4.1) edited via the existing PUT watchlist route
  (tracker-watchlist.controller.ts:36; `PutWatchlistInput` + compiler passthrough).
- `TrackerBoardService.getRecommendations` (:193-283): when the client's watchlist has
  jurisdictions, run a **second candidate pass** per state: `stateKeywordCandidateIds(terms,
states)` (no semantic per DD6), hydrate via `getStateBillsByIds`, score with the existing
  `scoreBillFit` (bill-fit.util.ts:40-108 — semantic component 0, so floor =
  `LEGIWATCH_STATE_FIT_FLOOR` 0.40), tag results `jurisdiction`. Geography default: if
  jurisdictions empty but the client has facilities, DO NOT auto-match (explicit opt-in only
  in P0 — predictability over magic; geography-suggested jurisdictions are a one-line
  `suggestedJurisdictions` hint on the watchlist GET, computed from
  `client_facilities.state` via a new withSystem read — the exact `suggestedIssueAreas`
  precedent, tracker-watchlist.service.ts:110-117).
- `NewMatchDetectorService.persistAndAlert` (:118-188): `billMatch.create` sets
  `congress: null, jurisdiction: <state>`; alert evidence carries jurisdiction; the
  `[clientId,billId]` unique dedup works unchanged.
- `billUrl()` (new-match-detector.service.ts:197-212): state branch returns
  `stateUrl ?? legiscan url` from the hydrated row (never a congress.gov slug).

### S5.2 `embed-state-bills` (dark in P0, DD6)

Job specced + entrypoint case added but NOT scheduled: embeds `state_bill` title+description
into `context_embeddings` with `source_type='state_bill'` (the federal embedder,
`embedText`/Titan, embedder.ts:23-25). Enabling = add the INGESTION_JOBS row + extend
`semanticBillScores` with a sourceType param (:217-226). Written down so P1 flips a switch,
not a design.

### S5.3 `emit-state-changes` (apps/api verb, new — DD4's second rail)

- Scan: `state_bill` where `status_at` advanced since the verb's `runWithSyncRun` watermark
  (`ctx.since`) AND status in the material set (passed_chamber, to_governor, enacted, vetoed,
  veto_overridden, failed, dead_by_deadline).
- Client fan-out: raw-read `intel_tracked_bill` (source='state', billId in batch) +
  `intel_bill_match` (jurisdiction != 'US') → `relatedClientIds` (precedent for apps/api
  reading intel tables: tracker-change-detector.service.ts:459-479; use apps/api
  `prisma.withSystem` for the RLS bypass GUC).
- Write `intelligence_change`: source `state_bill`, changeType `state_bill_<status>`,
  severity map (enacted/vetoed/failed→'high', passed_chamber/to_governor→'medium',
  else 'info'), title `TX HB 1234 — Passed chamber`, description = verbatim latest action,
  `dedupeKey = state_bill:<key>:<status>:<statusAt-date>` (the `intelligence_change.dedupe_key`
  unique convention, schema:3415; the date component lets a bill legitimately re-reach a
  status — e.g. `passed_chamber → resolving → passed_chamber` after conference — while
  same-window re-runs still dedup).
- **Retire the count row — as a follow-up PR, not bundled:** the `state_bill` entry at
  `emit-changes.ts:72-78` is deleted in **PR-4b**, merged only after `emit-state-changes` is
  verified in prod (S5-C + S7-D green) — "state emitters live → verify → drop the count row,"
  the Radar-cutover sequence this plan already cites in §12. Bundling the deletion with the
  replacement would remove the old signal with zero verified overlap.
- Schedule: `EmitStateChanges` row (S1.5).

### S5 success criteria

| #    | Criterion                                                                                                                                                                                                                                                                                                                                                                                                            | How verified           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| S5-A | A staging client with watchlist terms + `jurisdictions:['TX','FL']` gets ≥1 state recommendation with `fit ≥ 0.40` **in each state** and `bill_new_match` state alerts (SC-2's "2 states" exercised); same terms with `jurisdictions:[]` gets zero state rows (opt-in proven); **and an off-topic control watchlist yields zero state recs ≥ 0.40** (the lowered DD6 floor validated for precision, not just recall) | staging fixture triple |
| S5-B | `suggestedJurisdictions` returns the facility states for a client with TX facilities                                                                                                                                                                                                                                                                                                                                 | API assert             |
| S5-C | `emit-state-changes` on a status flip writes exactly one `intelligence_change` row with correct `relatedClientIds`, and a re-run writes zero (dedupeKey)                                                                                                                                                                                                                                                             | staging + SQL          |
| S5-D | The synced_at count row is gone: full re-sync of TX produces NO `intelligence_change` source='state_bill' rows without a real status transition                                                                                                                                                                                                                                                                      | staging re-sync assert |
| S5-E | Track/untrack a state bill from the API works end-to-end (`POST track {billId:'tx-2025-hb1234'}` → board row, source='state')                                                                                                                                                                                                                                                                                        | curl + board response  |

---

## 7. S6 — Meri tools + resolve_entity + the pinned eval

### S6.1 Tools (apps/api; every touch point from the discovered 9-step checklist)

| Tool                                      | Behavior (mirrors `getBillStatus` :1936-2065 / `searchFloorVotes` :2071-2227 incl. honesty notes + ambiguity contracts)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_state_bill_status` (new)             | resolve via `stateBillKey` canonical id or `parseStateBillDesignation` ("TX HB 1234"; state required — designation without a state returns a "specify the state" note); read persisted `state_bill.status` (+statusAt, latest action, sponsor, sponsorCount); parallel-fetch 15 newest `state_bill_action`, 15 newest `state_roll_call_vote`, `state_bill_link` companions with their status; honesty notes: no votes → "do NOT infer passage"; `dead_by_deadline` → "session adjourned sine die; this bill is dead absent a special session" |
| `search_state_floor_votes` (new)          | filters billKey/query/state/chamber/limit≤25; motion text search over `motion`; returns tallies + passed; no member-level filter in P0 (state member votes exist but legislator name-resolution ships with the crosswalk hardening — noted in the tool description so Meri doesn't promise it)                                                                                                                                                                                                                                                |
| `get_state_legislator` (new)              | by name+state (contains, ≤8, ambiguity → `ambiguousLegislator[]` + "ask the user which" — the searchFloorVotes contract :2094-2171) or by openstates/legiscan id via crosswalk; returns chamber/district/party/committees                                                                                                                                                                                                                                                                                                                     |
| `search_state_bills` (upgrade :2824-2870) | adds `status` filter + returns `status`/`statusLabel`/`sponsorCount`/`stateUrl` + honesty note when 0 rows; keeps `withSystem` scoping as-is                                                                                                                                                                                                                                                                                                                                                                                                  |

Touch points per tool: `TOOL_DEFINITIONS` (:70) + `anthropicToolSchemas` Record entry
(compile-enforced) + `execute` switch case (assertNever-enforced) + impl + **not** in
`SIDE_EFFECTING_TOOLS` (all read-only) + `meri-tools.registration.spec.ts` `EXPECTED_TOOLS`
(57→60) + `REQUIRED_INPUTS` (`get_state_bill_status: ['billId']`, `get_state_legislator:
['query']`) + behavior specs (`meri-state-bill-status-tool.spec.ts` — the
`Object.create(prototype)` + fake-prisma pattern from `meri-bill-status-tool.spec.ts`).

### S6.2 resolve_entity (:2281-2453)

Add `entityType 'state_bill' | 'state_legislator'`: Tier 1 = `stateBillKey` validator /
designation parse; Tier 2 = `entity_crosswalk` (`legiscan_bill`, `openstates_bill`,
`legiscan_people`, `openstates_person`); Tier 3 = name search (`state_legislator` by
name+state, `isCurrent`-equivalent = `active desc`). Update
`meri-resolve-entity.spec.ts`.

### S6.3 Orchestrator catalogs

`full-chat-read-tools.catalog.ts` + `delegated-tools.catalog.ts` (in-editor gets
`get_state_bill_status` + upgraded `search_state_bills`; full-chat gets all four) with
descriptions transcribed verbatim; `full-chat-read-tools.catalog.spec.ts` `ALL_APPS_API_TOOLS`
57→60 + expected-list updates. `readOnly: true` on all (matches SIDE_EFFECTING classification
— the gate-bypass rule, delegated-tool.ts:30-36).

### S6.4 The pinned eval

- `packages/meriv2-core/test/evals/legislation/state-bill-status.eval.ts` — category
  `'legislation'` (**no `EvalCategory` union change needed**), pure mechanism test importing
  `deriveStateBillStatus` from `@capiro/shared` dist (the bill-status.eval.ts pattern):
  asserts (1) the S3-D crossover fixture → `dead_by_deadline` (never
  `committee`); (2) `MERIV2_EVAL_SEED_FAILURE=1` flips an input to prove the gate can go red;
  (3) enrolled beats sine-die (`to_governor`); (4) `classifyStateVoteMotion` traps. Register
  in `run-evals.ts` CASES.
- **CI gap closure:** extend `.github/workflows/meriv2-evals.yml` paths with
  `packages/shared/**` — today a shared-only change does not trigger the gate (verified,
  paths at meriv2-evals.yml:10-13), which would let someone break `deriveStateBillStatus`
  (or `deriveBillStatus`!) without the eval running. **This paths fix ships in PR-2 (with
  S3), not here** — S6-D requires the workflow to fire on the S3 PR itself; S6 only adds the
  eval case.

### S6 success criteria

| #    | Criterion                                                                                                                                         | How verified                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| S6-A | Registration spec green at 60 tools; catalog coverage spec green (3 catalogs == ALL_APPS_API_TOOLS)                                               | local jest (api) + CI jest (orchestrator — this suite DOES run in CI, ci-pr.yml:82-99) |
| S6-B | `get_state_bill_status` behavior spec pins the dead-by-deadline shape (status, label /dead                                                        | sine die/i, honesty note) + designation-without-state note + explicit not-found        | new spec |
| S6-C | The eval gate runs and passes; with `MERIV2_EVAL_SEED_FAILURE=1` it fails (red-provable)                                                          | `pnpm --filter @capiro/meriv2-core eval:meriv2` both ways                              |
| S6-D | meriv2-evals workflow triggers on a `packages/shared/**`-only PR                                                                                  | CI check appears on the S3 PR itself                                                   |
| S6-E | Live smoke: full-chat Meri answers "what's the status of TX HB <fixture>?" from the tool with the verbatim latest action and no fabricated status | staging conversation transcript                                                        |

---

## 8. S7 — UI surfaces (apps/web)

### S7.1 Feed facet + prefs

- `intel-feed-api.ts`: `FeedSourceType` += `'state_bill'` (:10), `SOURCE_LABEL` += "State
  bills" (:145), `FeedBillEvidence` += `jurisdiction?` — `feedQueryString` already passes any
  sourceType (:136-143). `TrackerFeedPanel` source facet options (+1) (:463-468).
- Alert-prefs UI (`TrackerConfigPanel`): jurisdiction multi-select (state codes from
  `facilities-api.ts` `US_STATE_CODES` :175-182) bound to the new `jurisdictions` pref field;
  trigger checkboxes unchanged (keys are jurisdiction-neutral; `TRIGGER_LABELS` :221-231 get
  the two federal-worded labels neutralized: "Floor vote / passed chamber" stays fine,
  `companion` label already fits).

### S7.2 Watchlist jurisdictions

`TrackerConfigPanel` gains a "Jurisdictions" selector (empty = Federal only — copy states
this explicitly) writing through `watchlistToIntel`/`PutWatchlistInput`. Board/recs render a
state pill on state rows (`BoardBill`/`RecommendationBill` += `jurisdiction?` via `adaptBoard`
/`adaptRecs`, intel-tracker-api.ts:132-181).

### S7.3 State bill drawer

`apps/web/src/pages/explorer/state-bill-detail.tsx` (new) — mirrors `BillDetailBody`
(bill-detail.tsx:32-112) using its exported `DrillSection`/`DrillKV`/`ChipList`: KV (state,
session, identifier, title, sponsor+count, status **pill** via `stateBillStatusLabel` from
shared — web already imports shared runtime, intel-feed-api.ts:1), actions timeline
(`drill-list`, newest 15), votes list (motion, tally, passed), **versions list (versionType,
date, official link — the `state_bill_version` metadata renders cheaply; parent §S7 lists it)**,
companions, official-site link.
Served by extending the explorer endpoint (S7.4). `BillDrawer` (BillDrawer.tsx:90-108) gets a
`jurisdiction` prop switch: state ids render the state body; "Track for {client}" works
because S4.5 made the track endpoint accept state keys. No status _ladder_ in P0 (none exists
federally either — parity, not gold-plating).

### S7.4 Explorer + API

`GET /api/explorer/state-bills/:id` extended to include `status`, `actions[]` (15), `votes[]`,
`links[]` — additive response fields (explorerTypes.ts:419-423 `StateBillDetail` extended);
list columns gain a Status pill. `?bill=` deep-link stays federal-only (state deep-link =
`?source=state-bills` + row click, unchanged).

### S7.5 Needs Attention + changes inbox

`intelligence_change` rows from S5.3 flow into the existing `GET /api/intelligence/changes`
feed (HomePage.tsx:92-105). Add the `state_bill` source mapping to the chip builder
(HomePage.tsx:351-392) — icon/label "State bill", href → `/legiwatch?tab=bills&client=<id>`
(first related client). Portfolio-alerts aggregate integration is explicitly **out of P0**
(it's a per-client profile-v1 computation — parent plan's Intel-tab state section lands with
M1's district work).

### S7.6 Client profile

The `tracker` tab (labeled "LegiWatch", ClientProfilePage.tsx:447-461) already hosts
`TrackerSurface` — state rows appear there automatically once S4/S5 land (board + recs are
jurisdiction-mixed, state pill distinguishes). No new tab in P0.

### S7 success criteria

| #    | Criterion                                                                                                                                                                                                                                                                                                                                                    | How verified                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| S7-A | Feed facet filters to state-only and mixed correctly; state alert rows deep-link to the drawer with verbatim quote visible                                                                                                                                                                                                                                   | staging click-through on S4-C fixtures |
| S7-B | Watchlist editor round-trips `jurisdictions` (PUT→GET), empty = federal-only labeled                                                                                                                                                                                                                                                                         | UI + API assert                        |
| S7-C | State drawer renders status pill + actions + votes for a re-keyed TX bill; Track button creates a `source='state'` tracked row visible on the board with a state pill                                                                                                                                                                                        | staging click-through                  |
| S7-D | Needs Attention shows a chip for an S5-C transition, linking into LegiWatch                                                                                                                                                                                                                                                                                  | staging                                |
| S7-E | `pnpm --filter @capiro/web typecheck` clean (CI-enforced) + prettier clean (local gate — CI prettier covers only MeriV2 paths, ci-pr.yml:41-46); zero regressions on federal drawer/board/feed (existing pages snapshot-free, so: manual regression script listed in the PR); board change-chips render on state rows (the tracker-board :306/:415 widening) | CI + checklist                         |

---

## 9. Test plan & gates (cross-cutting)

- **Gates per PR (lint is broken repo-wide — never `pnpm lint`):** `pnpm turbo run typecheck`,
  `pnpm exec prettier --check` (CI-enforced for MeriV2 paths only, ci-pr.yml:41-46; a local
  gate everywhere else), jest for touched packages. apps/api + apps/intel-api suites
  do NOT run in CI (live-Postgres constraint, comment ci-pr.yml:73-81 — it names
  api/workspace; intel-api likewise has no CI jest step) → run locally and paste results into
  the PR description (existing team convention); meriv2-core/orchestrator/auth suites + the
  eval gate DO run in CI.
- **Worktree gotchas:** build `@capiro/shared` + `prisma generate` first; jest can find 0
  tests through reparse points → `--testMatch "**/src/**/*.spec.ts"`.
- **New spec inventory:** legiscan-normalize (fixtures from a real getBill payload + a dataset
  bill), quota governor, deriveStateBillStatus table tests, motion classifier,
  state-bill-change-detector (baseline/fire-once/dedup/jurisdiction), fanOut jurisdiction
  filter, emit-state-changes dedupe, meri registration + 2 behavior specs, catalog coverage,
  state eval. Fixture bills: pick 3 real TX bills post-backfill (one enacted, one
  dead-by-deadline, one with a companion) and freeze their JSON under
  `apps/api/scripts/__fixtures__/legiscan/`.
- **PR slicing (each independently deployable, no dark-code violations):**
  PR-1 S2 schema + S1 (backfill+syncs dark until scheduled) → PR-2 S3 shared+verb (+ the
  meriv2-evals workflow paths fix, so the gate fires on this PR) → PR-3 S4 intel-api rail →
  PR-4 S5 association + emit-state-changes → **PR-4b count-row retirement (merged only after
  runbook step 8's prod verification)** → PR-5 S6 tools/eval → PR-6 S7 web. Adversarial
  review pass on PR-3 and PR-4 (the two with cross-tenant fan-out surface), mirroring the
  #367 practice.

---

## 10. Rollout runbook (prod, ordered; each step has a rollback)

1. **Secret**: 4-step LegiScan key wiring (S1.5). _Rollback:_ remove td secret entry.
2. **Merge PR-1/2; verify `:latest` carries the merge SHA** (image-tag race memory) →
   `scripts/deploy-dev.sh` (migrate → api roll → web roll). _Rollback:_ Prisma migrations are
   forward-only — take an Aurora snapshot pre-migrate; the additive columns/tables are safe
   to leave in place, and the wiped `state_bill` data is rebuildable via step 3 (which is why
   the wipe is acceptable at all).
3. **Backfill ALL states**: one-off run-task `backfill-legiscan-datasets` with
   `LEGISCAN_STATES=all` (~2 queries/state ≈ 110 total) so the Data Explorer repopulates in
   one same-day pass; verify S1-A/S2-C/S2-D SQL on TX as the audit sample. _Rollback:_
   truncate state tables (reference data, rebuildable).
4. **Schedules ON for TX only** (`LEGISCAN_STATES=tx` in rule env): masterlist hourly, drain,
   derive. Watch 72 h → S1-C. _Rollback:_ disable rules.
5. **intel-api**: migrate task (`capiro-dev-intel-api-migrate`) STOPPED exit 0 → roll
   `capiro-dev-intel-api` (the non-negotiable ordering, capiro-intelligence-unification.md:3242).
   _Rollback:_ forward-only by design — `congress DROP NOT NULL` cannot be reversed once
   state match rows exist and doesn't need to be (nullable is strictly more permissive);
   the new `jurisdictions` columns are additive no-ops if unused. Roll the service back to
   the prior image if behavior regresses; leave the schema.
6. **Staging-tenant fixtures on prod rails** (capiro-internal): track 3 TX bills, seed a
   watchlist with jurisdictions, prefs with jurisdictions. Detector runs in its existing 6 h
   schedule → verify S4-B/C/D **feed-only** (email still `LEGIWATCH_EMIT_SOURCE_TYPES=bill`).
7. **Email flip**: set `LEGIWATCH_EMIT_SOURCE_TYPES=bill,state_bill` on intel-api serve +
   enableflag tds (out-of-band td edit). Verify S4-E against capiro-internal prefs.
   _Rollback:_ revert env (feed stays live — degradation, not outage).
8. **emit-state-changes schedule ON** + verify S5-C/S7-D in prod. Only after both are green,
   **merge PR-4b** (count-row retirement) — the old coarse signal stays alive until the new
   rail is verified. _Rollback:_ disable the schedule; the count row is still emitting.
9. **Backfill + enable remaining priority states** (repeat 3–4 batched), **FL first** — the
   Ballard week-4 walkthrough (parent plan D4) runs on FL fixtures, so FL follows TX within
   days, then the rest of the Rev-2 list (CA, NY, IL, MA, GA, VA); then the wide masterlist
   rule for the remaining states.
10. **Exit review**: parent-plan SC-1..SC-4 sign-off (freshness p95, served-client
    walkthrough, alert parity replay, eval green in CI) + quota report vs the S1.5 arithmetic
    → feeds the D1 commercial-terms decision.

---

## 11. Success-criteria roll-up

Phase exit = **all** workstream SCs above green **plus** the parent plan's phase-level four:
SC-1 freshness (p95 ≤60 min priority states) ← S1-C; SC-2 served client — satisfied in P0 by
the client-profile **LegiWatch tab** (board + feed with state rows), Needs-Attention chips,
and tracked state bills for a 2-state client ← S4-D + S5-A (2-state fixture) + S7-C/D; the
_Intelligence-tab_ state section deliberately lands with M1's district data (parent SC-2
amended Rev 2 to say so — this plan does not claim it); SC-3 alert parity (exactly-once,
verbatim evidence, idempotent) ← S4-C/E + S5-C; SC-4 pinned eval in CI ← S6-C/D.

## 12. Risks & edge cases (with mitigations)

- **LegiScan `bill_number` variance** ("HB1234" vs "HB 1234" vs "HJR12A"): normalizer
  lowercases + strips spaces/periods; validator allows a trailing letter; fixtures include a
  resolution + an alpha-suffixed number.
- **Session ambiguity** (year_start collision on special sessions): DD1's `x<session_id>`
  disambiguator; `state_session` is the authoritative map; masterlist walks sessions by id,
  never by "current".
- **Amended-after-sine-die / carryover bills** (NJ/VA carry over across years): status
  recompute is pure — when LegiScan reopens the session or moves the bill, `dead_by_deadline`
  self-heals on the next derive. Pinned in the shared spec.
- **Alert storm at cutover**: impossible by construction — first-sighting baseline (S4-B) +
  14-day dedup + feed-first rollout.
- **Quota exhaustion mid-backfill**: dataset seeding costs ~2 q/state; the governor (S1-D)
  hard-stops drains; fallback = weekly dataset refresh.
- **Detector volume**: sweep cap 5000 (intel-alert.service.ts:234) + detector scan is
  tracked-bills-only (not corpus-wide) — state adds rows only as clients track/match.
- **Two-rail drift** (intel_alert vs intelligence_change disagree): both derive from the same
  `state_bill.status` transition; emit-state-changes runs after derive in the schedule chain;
  S5-C asserts equivalence on the fixture.
- **`companion` key UX**: first-ever emitter for a default-ON trigger — existing subscribers
  will start receiving companion alerts for _state_ bills only (federal still has no emitter);
  release note this.
- **Windows/OneDrive dev friction** (worktree reparse points, `TMPDIR`): documented in §9;
  CI unaffected (Linux).
