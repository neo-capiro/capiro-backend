# Band B — ingestion / source-adapter cluster · independent §6.2 review

**Reviewer:** an independent agent. Not the agent that implemented, deployed, or
handed off any phase in this cluster. No file in this cluster was authored,
edited, or reviewed by this reviewer before this pass.

**Convention followed:** `docs/runbooks/phase-2-independent-live-validation.md`
— different reviewer than implementer, read-only verification, a verdict that is
exactly one of two strings, a dated approval record.

**Pinned commit:** `d800dcfde51f6cf21a4b54b511006b9001fd6d2b`
(`feat(x-feed): configurable X Intelligence dashboard feed (#948)`,
Thu Aug 13 2026). Every path and line number below is at that commit. Read via
`git show d800dcfde5:<path>` from `C:\dev\capirov2` and via the read-only
detached worktree `C:\dev\capiro-fo-ga-review-wt` (verified at the same SHA,
`git status --porcelain` empty). `C:\dev\capirov2`'s working tree was never
touched.

**Scope — a CLUSTER, reviewed at its SEAMS.** P14 (Tango provider adapter),
P15 (snapshot/crosswalk/checkpoint/usage schema), P17–P18 (capability probe,
rate-limit/retry/health controls), P19 (reviewed-UEI entity shadow sync),
P22 (vehicles/past-performance), P24 (agency forecast), P27 (Tango↔SAM
crosswalk), P28 (notice history), P29–P30 (attachments / extracted text),
P40 (DIBBS), P42 (SBIR/STTR). The subaward adapter
(`20261001010000_tango_subaward_intelligence`) is not on that list but is the
newest member of the same adapter family and the direct comparison point
`tango-dibbs.client.ts`'s own header names; it is reviewed here and flagged as
adjacent-to-scope rather than silently included or silently dropped.

**Nothing was fixed.** This document is the queue.

---

## Verdict

```
BAND_B_INGESTION_ADAPTERS_REJECTED
```

(The two permitted strings for this band, by the §6.2 convention:
`BAND_B_INGESTION_ADAPTERS_INDEPENDENTLY_APPROVED` /
`BAND_B_INGESTION_ADAPTERS_REJECTED`.)

Rejected on **B-1** (P0) alone. **B-2**, **B-3** and **B-4** are independently
sufficient to withhold approval. Approval of this band requires B-1 through B-4
closed and B-5 through B-8 either closed or recorded in the decision log with a
stated reason, per the convention that a deviation is acceptable only when it is
written down.

**This is a code and schema review at a pinned commit.** It is not a live-AWS
validation: every scheduled job in this cluster ships `enabled: false` or is not
declared at all (see B-7), so there is no running behaviour to observe. Where a
finding depends on runtime behaviour, the evidence cited is the program's own
recorded live runs (D-36, D-41/42/43, D-45, D-65, D-71, D-75/76/77/78), not a
new run by this reviewer.

---

## Answers to the five commissioned questions, up front

| # | Question | Answer |
|---|---|---|
| 1 | Do later sync scripts use P18's shared rate-limit/breaker mechanism consistently? | **No.** Three distinct regimes, and one adapter has none at all. D-65's fix was applied to DIBBS/SBIR for 429 only and never generalised; the subaward adapter, written *after* D-65, reproduces D-65's defect verbatim. → **B-2, B-3, B-4** |
| 2 | Is the `tango_sync_checkpoint.resource_type` boundary clean? | **Yes — clean, and verified exhaustively.** No write path, no coercion. See "Verified clean" below. This is the one seam that holds. |
| 3 | Does every synced row carry the D-02 provenance set? | **No.** Content hash is absent from all four DIBBS/SBIR tables and from `tango_procurement_forecast` — the exact three datasets D-02 names as provider-exclusive. The omission is nowhere documented. → **B-5** |
| 4 | Is the "throw on a 200 with no `results`" envelope check applied consistently? | **No.** Only the two clients scrutinised during P17 throw. The base gateway (six endpoints, five phases) and the subaward client both coerce silently to an empty page. → **B-6** |
| 5 | Any sync whose success is evidenced only by an internal log line, with no live real-provider proof? | **Yes — P27, P28, P29, P30, and the SBIR sync.** And structurally, *every* sync in the cluster: none exits non-zero on a partial, throttled, or ceilinged run, and no CloudWatch metric filter or alarm reads any of their log tokens. → **B-8**, detailed in the dedicated section |

---

## Findings, severity-ranked

### B-1 · **P0** · P19 converts every P18 containment signal into a green "complete" run

`apps/api/scripts/sync-tango-entities.ts`

`runEntitySync` wraps the per-client body in a catch-all
(`sync-tango-entities.ts:205`) that swallows **every** exception into
`errored += 1` plus a `lastError` stamp on the client row. That catch is
indiscriminate: it also swallows the three errors `TangoResilienceService`
exists to raise — `TangoRequestCeilingExceededError`,
`TangoCircuitOpenError`, and `TangoAuthRejectedError`.

The loop then advances the cursor unconditionally
(`sync-tango-entities.ts:217`) and writes the checkpoint with
`completeness: isLastBatch ? 'complete' : 'in_progress'`, where
`isLastBatch = batch.length < batchSize || processed >= options.limit` — a
purely structural test that never consults `errored`. `main()` prints
`TANGO_SYNC_DONE {...}` and exits 0.

Concretely, three failure modes all produce a run that is byte-for-byte
indistinguishable from a healthy one except for counters inside one log line:

- **Key rejected.** `TangoAuthRejectedError` fires on client #2 and every
  client after it, with no network call. The whole client table is walked in
  seconds, every row gets a `lastError`, the cursor reaches the end, and the
  checkpoint is stamped `complete`. Note D-66's still-open item: *"the Tango
  API key was pasted into a chat transcript on 2026-08-08 and still needs
  rotating."* A rotation that is not mirrored into Secrets Manager produces
  exactly this run.
- **Request ceiling reached.** Same shape. Every remaining client is marked
  errored and skipped; the cursor advances past them; next run resumes *after*
  them. Those clients are silently never synced.
- **Circuit breaker open.** Same shape.

This is a seam defect, not a phase defect. P18's own class doc
(`tango-resilience.service.ts:44`) names P19 as *"the first real consumer"* —
and P19 was written before the ceiling-handling idiom existed, so it never got
it. **Every later resilience-wrapped sync did:** `sync-tango-vehicles.ts:230`,
`sync-tango-forecasts.ts:195`, `sync-tango-opportunity-notices.ts:262`, and
`sync-tango-opportunity-shadow.ts:247` each catch
`TangoRequestCeilingExceededError` explicitly, set `ceilingReached = true`, and
force `completeness: 'in_progress'` so the checkpoint is preserved rather than
falsely closed. P19 is the only one of the five that does not — the earliest
consumer, left behind by a pattern the four that followed it all adopted. A
single-phase reviewer of P19 sees a defensive try/catch; a single-phase reviewer
of P18 sees three well-designed error classes. Only the pair is wrong.

**Why this is P0 rather than P1.** D-76/D-77/D-78 establish that this account
has an undocumented coarse quota tier that blocks account-wide for hours
(D-76 logged a `retryAfterSec` countdown from 13,007s). That block is
account-wide, and `ingestion-schedule.ts` puts five Tango jobs on the same
account within 85 minutes of each other (`SyncTangoEntities` 12:05,
`SyncTangoVehicles` 12:40, `SyncTangoForecasts` 12:50, `SyncTangoDibbs` 13:10,
`SyncTangoSbir` 13:30). So the first thing that happens after P50's enablement
is the condition that makes B-1 fire, on a scheduled unattended job, with a
`complete` checkpoint and exit 0 as the only record.

**Not proposing the fix here** (this is a queue, not a patch), but the shape is
already in the repo four times over: re-throw or specially handle the three
resilience errors before the generic catch, and gate `completeness: 'complete'`
on something other than batch geometry.

---

### B-2 · **P1** · DIBBS/SBIR retry 429 only — the `transient` half of D-65's own fix was never applied

`apps/api/scripts/sync-tango-dibbs.ts:296`,
`apps/api/scripts/sync-tango-sbir.ts:316`

```ts
const rateLimited = error instanceof TangoDibbsHttpError && error.isRateLimited;
if (!rateLimited || attempt >= maxRetries) throw error;
```

`isRateLimited` is `status === 429` and nothing else
(`tango-dibbs.client.ts:75`, `tango-sbir.client.ts:102`). The shared mechanism
retries a strictly larger set: `tango.errors.ts:50-53` declares
`RETRYABLE = { rate_limit, transient }`, and `classifyStatus`
(`tango.errors.ts:233-247`) maps **all 5xx**, **408**, and **a null status
(i.e. a network failure or timeout)** to `transient`.

Both REST clients raise `TangoDibbsHttpError(0, …)` / `TangoSbirHttpError(0, …)`
for an `AbortError` timeout and for any other thrown error
(`tango-dibbs.client.ts:289-292`, `tango-sbir.client.ts:321-324`). Status `0`
is not 429, so it is not retried. Neither is a 502, a 503, or a 504.

The consequence is precisely the one D-65 wrote up and believed it had closed:

> *"A 429 would have propagated out of `walkEndpoint` and **killed the entire
> run — all three endpoints, not just the throttled one**."*

That is still true today for every transient failure. `walkEndpoint`'s catch
(`sync-tango-dibbs.ts:383`) special-cases only `isRateLimited`; anything else
re-throws, propagates through the `for (const endpoint of endpoints)` loop in
`runDibbsSync` uncaught, and aborts the run. One TCP reset on page 400 of the
RFQ walk discards the RFP and award walks entirely.

**This is the answer to commissioned question 1 in its sharpest form.** D-65 was
found by a live run, so it was fixed exactly as wide as the live run's evidence
— 429 — and the shared mechanism's already-broader policy was not consulted.
The reimplementation did not merely duplicate the shared mechanism; it
duplicated a *narrower* version of it.

---

### B-3 · **P1** · Two rate-limit subsystems, one provider account, zero shared accounting

The account has one quota. Two independent mechanisms consume it, and neither
can see the other's consumption.

| | Resilience path (P19/P22/P24/P27/P28) | DIBBS/SBIR path (P40/P42) |
|---|---|---|
| Per-run request ceiling | `DEFAULT_REQUEST_CEILING = 5_000` (`tango-resilience.service.ts:198`), env-overridable | **none** — bounded only by `MAX_PAGES_PER_ENDPOINT = 10_000` per endpoint (`sync-tango-dibbs.ts:98`), i.e. up to 30,000 requests for a 3-endpoint `--full` walk |
| Circuit breaker | yes, `TANGO_CIRCUIT_BREAKER_THRESHOLD` / `_COOLDOWN_MS` | **none** |
| Auth fast-path | yes | **none** — a rejected key produces a full 401 round trip per page |
| `tango_api_usage` row per attempt | yes (`recordUsage`, `tango-resilience.service.ts:421`) | **none** |
| Retry set | `rate_limit` + `transient` | `rate_limit` only (see B-2) |
| Backoff cap | `MAX_DELAY_MS = 8_000` | `MAX_PROVIDER_WAIT_MS = 120_000` |

The code names this gap itself, in `sync-tango-dibbs.ts:100-117`, as the reason
a real 4.5-hour production stall was un-diagnosable after the fact:

> *"this call path writes no row to `tango_api_usage` (that table belongs to the
> unrelated 8-method resilient gateway), so nothing captured it."*

D-75 repeats it. The bounded-sleep symptom was fixed; **the accounting gap that
made it unrecoverable was recorded and left open.** `tango_api_usage`'s own
migration comment calls it *"the shape P18's health check and rate-ceiling logic
both need"* — and `diag-tango-health` / `TangoStoreService.getUsageHealth`, the
cross-process health answer an operator actually reads, are therefore blind to
the two adapters that generate the largest request volume in the program.

Combined with B-1, this is the cluster's central structural problem: the
subsystem with the containment controls cannot see the traffic, and the
subsystem with the traffic has no containment controls.

---

### B-4 · **P1** · The subaward adapter reproduces D-65's defect verbatim, written after D-65

`apps/api/scripts/sync-tango-subawards.ts`,
`apps/api/src/external/tango/tango-subaward.client.ts`

Adjacent to the commissioned phase list; squarely inside the cluster. Migration
`20261001010000_tango_subaward_intelligence` postdates D-65 (2026-08-08).

- **No rate-limit handling of any kind.** No `429`, no `Retry-After`, no
  retry, no throttle, no ceiling, no breaker. A grep for
  `429|isRateLimited|retry|sleep|backoff|throttle|circuit|breaker|ceiling`
  across `sync-tango-subawards.ts` returns nothing. This is D-65's Defect 1
  word for word, in a file written after D-65 was recorded.
- **`Retry-After` is not merely unused, it is unrecoverable.**
  `TangoSubawardHttpError` (`tango-subaward.client.ts:36-44`) carries only
  `status` and `message` — no `rate` field, unlike its DIBBS and SBIR siblings
  which were given one *because of* D-65. The client parses rate headers into a
  `TangoRateMetadata` on the success path (`rateOf`, line 68) and discards them
  on the failure path.
- **It cannot run in the deployed container.** There is no
  `sync-tango-subawards` verb in `apps/api/scripts/entrypoint-dispatcher.inc`
  (0 occurrences) and no EventBridge declaration in
  `infra/cdk/lib/ingestion-schedule.ts`. The script is reachable only from a
  developer shell.
- **Its tables are invisible to Prisma.** `tango_subaward` and
  `tango_subaward_sync_checkpoint` exist only in raw SQL; neither appears in
  `apps/api/prisma/schema.prisma`, and the sync uses `$queryRaw` / `$executeRaw`
  throughout (`sync-tango-subawards.ts:283-330`).

Ironically, `tango_subaward` is the **only** later-phase table that carries the
full D-02 provenance set (`source_url`, `provider_modified_at`,
`content_sha256` — migration lines 46-48), which the DIBBS/SBIR tables do not
(B-5). The adapter that got provenance right got rate limiting worst.

---

### B-5 · **P2** · The D-02 provenance invariant is unmet on the exact three datasets D-02 names

`decision-log.md:36-37` states the invariant for provider-exclusive datasets —
*"agency forecasts, DIBBS, SBIR/STTR"* — as: *"original source system, provider,
fetched timestamp, provider update timestamp, content hash, and source URL."*

`apps/api/prisma/schema.prisma`, spot-checked across six tables:

| Table (phase) | source system | source URL | provider update ts | fetched ts | **content hash** | raw payload |
|---|---|---|---|---|---|---|
| `tango_resource_snapshot` (P15) | `resource_type` | `source_url` | `source_updated_at` | `provider_fetched_at` | **`content_sha256`** | `normalized_jsonb` |
| `tango_opportunity_notice` (P28) | table name (D-03) | `source_url` | `provider_updated_at` | `first/last_synced_at` | **`content_hash`** | `snapshot` |
| `tango_procurement_forecast` (P24) | `source_system` | `source_url` (always null, documented) | `provider_modified_at` | `first/last_synced_at` | **absent** | `snapshot` |
| `tango_dibbs_solicitation` (P40) | table name | `document_url` | absent | `first/last_synced_at` | **absent** | **absent** |
| `tango_dibbs_award` (P40) | table name | **absent** | `last_mod_posting_date` (a DATE) | `first/last_synced_at` | **absent** | **absent** |
| `tango_sbir_solicitation` / `tango_sbir_topic` (P42) | table name | `sol_download_url` / `topic_url` | absent | `first/last_synced_at` | **absent** | **absent** |

Reading this fairly, three of the six elements are defensible where absent:

- *Source system* — D-03 makes the `tango_*` table name itself the provenance
  carrier. Acceptable.
- *Provider update timestamp* on DIBBS/SBIR — neither endpoint publishes one.
  `dibbs-sbir-rest-contract.md` lists no `modified`/`updated` field on any of
  the five endpoints. Genuinely unavailable.
- *Source URL* on the two SBIR tables and DIBBS solicitations — present under
  provider-specific names. Acceptable.

**The content hash is not defensible, and it is missing everywhere it matters.**
It is computed locally from data already in hand
(`computeContentHash`/`sha256Hex` already exist and are exported,
`tango-store.service.ts`), so no provider limitation prevents it. Its absence
means:

1. There is no evidence a stored row still matches what the provider sent.
2. An upsert cannot distinguish a no-op refresh from a real change — for
   `tango_dibbs_*` and `tango_sbir_*` this is compounded by there being **no
   `snapshot` column either**, so the hash cannot be recomputed retroactively.
   The observation is not recoverable; only the mapped projection survives.
3. `tango_dibbs_award` carries neither a source URL nor a content hash nor a raw
   payload — for a table whose own model doc forbids aggregation, the row is
   unverifiable against its source by any means.

**No decision-log entry, handoff, or schema comment acknowledges this.** A grep
for `content hash|content_sha|contentHash` across the plan directory returns
D-02 (stating the invariant) and D-22 (P15 implementing it) — and nothing from
P24, P40, or P42. D-46 justifies `tango_procurement_forecast` not being a
versioned snapshot table, which explains why it needs no *natural-key* hash; it
does not address D-02's independent provenance requirement, and it does not
cover P40/P42 at all.

This is a direct hit on commissioned question 3: the invariant degrades
monotonically with phase number, and the drop was never recorded.

---

### B-6 · **P2** · The loud-envelope discipline exists only on the two clients P17 happened to probe

`tango-dibbs.client.ts:264-269` and `tango-sbir.client.ts:296-301` both throw a
dedicated `…EnvelopeError` when a 200 carries no `results` array, with an
excellent rationale in each file header:

> *"An empty page is indistinguishable from a clean end-of-walk — a wrong
> envelope would end every run with '0 records, complete', which is the quietest
> possible way to be wrong."*

That reasoning is correct and it is **not applied anywhere else in the cluster.**

- `apps/api/src/external/tango/tango.client.ts:591` —
  `for (const raw of response.results ?? [])`. This is the shared `page()`
  helper behind **all six SDK-backed list endpoints** (`listEntities`,
  `listOpportunities`, `listNotices`, `listForecasts`, `listVehicles`,
  `listVehicleAwardees`), i.e. every network read P19, P22, P24, P27 and P28
  make. A response without `results` yields `items: []`.
  Worse in combination with line 610, `nextCursor: response.next ? … : null`:
  if `results` is missing and `next` is absent, the walk reports
  `completeness: 'complete'` with zero rows — the exact "0 records, complete"
  outcome the DIBBS/SBIR headers name as the failure mode to prevent.
- `tango-subaward.client.ts:150-155` — `Array.isArray(parsed.results) ? … : []`.
  Same silent coercion. `tango-dibbs.client.ts:18-25` explicitly notes it
  differs from the subaward client *"in exactly one deliberate way"* — so this
  divergence is known and was left as a per-client choice rather than a
  cluster-wide rule.

**Counter-argument, stated fairly:** the SDK types `results` as a required
array, so `?? []` is nominally unreachable. That argument is worth exactly what
this program's own history says it is worth — D-35 (SDK field names that
round-trip through neither the SDK nor the server), D-41 (a field the SDK
declares that the server does not have), D-42 (the SDK's `.cursor` documented as
usable and unconditionally null in practice), D-45 (the SDK's own client-side
schema gate hiding three real server fields). The SDK's type is a compile-time
claim about a server this program has caught the SDK being wrong about four
separate times. `?? []` is the runtime behaviour when that claim fails, and it
is the quiet one.

The asymmetry has a plain cause and it answers commissioned question 4 exactly:
the two clients that got the loud check are the two that were being written at
the moment P17's probe made the envelope a live, open question. The five phases
whose envelope nobody was actively worrying about kept the quiet default.

---

### B-7 · **P2** · P27–P30 have runnable verbs and no schedule; P48's ordering comment points at a job that does not exist

`infra/cdk/lib/ingestion-schedule.ts` declares Tango rules for exactly five
syncs: `SyncTangoEntities`, `SyncTangoVehicles`, `SyncTangoForecasts`,
`SyncTangoDibbs` (+`ReconcileTangoDibbsFull`), `SyncTangoSbir`
(+`ReconcileTangoSbirFull`), plus `ProcessTangoEvents`.

`apps/api/scripts/entrypoint-dispatcher.inc` additionally exposes runnable verbs
for `sync-tango-opportunity-shadow` (line 677),
`sync-tango-opportunity-notices` (line 692),
`sync-tango-opportunity-attachments` (line 702) and
`sync-tango-opportunity-text` (line 710) — **none of which has an EventBridge
declaration at all**, not even one marked `enabled: false`. Every other Funding
Opportunities job in that file is declared-and-disabled, with a comment
explaining the posture. P27, P28, P29 and P30 are simply absent.

The consequence is already written into the file. `ProcessTangoEvents`'s own
comment (`ingestion-schedule.ts:724`):

> *"ORDER MATTERS: this reads what `sync-tango-opportunity-notices` holds and
> does not fetch inline, so it is scheduled AFTER that sync."*

It is ordered after a job that has no schedule. When P50 enables the declared
rules, P48's event drain will run daily against `tango_opportunity_notice`,
which nothing scheduled populates. The drain will report success — it will
correctly find no changes — indefinitely.

All four of these phases are marked **`deployed`** in `completion-matrix.md`.

---

### B-8 · **P2** · No sync signals failure to anything but a log line, and nothing reads the log lines

Checked across all ten sync scripts in the cluster: `process.exitCode = 1` is
set **only** for missing `TANGO_API_KEY`, malformed arguments, and an escaped
throw. No script exits non-zero for:

- `rateLimited: true` (DIBBS/SBIR — the endpoint gave up mid-walk)
- `ceilingReached: true` (P22/P24/P27/P28)
- `errored > 0` (P19 — including the B-1 total-failure case)
- `completeness: 'in_progress'` on any of them

Each emits one structured line — `TANGO_SYNC_DONE`, `TANGO_VEHICLE_SYNC_DONE`,
`TANGO_FORECAST_SYNC_DONE`, `TANGO_NOTICE_SYNC_DONE`, `TANGO_OPP_SHADOW_DONE`,
`TANGO_DIBBS_SYNC_DONE`, `TANGO_SBIR_SYNC_DONE`, `TANGO_SUBAWARD_SYNC_DONE`,
`FO_TEXT_SYNC_DONE` — and returns 0.

There is **no CloudWatch metric filter and no alarm on any of these tokens**
anywhere in `infra/cdk/lib/`. A grep for `tango` intersected with
`alarm|metric` across that directory returns nothing. So the ECS task succeeds,
EventBridge is satisfied, and the only artifact distinguishing a complete run
from a fully failed one is a JSON blob in a log group that nothing watches.

To P19's credit, its `TANGO_SYNC_DONE` line does include
`health: gateway.getHealth()`, which carries `authRejected`, `breakerState` and
`requestsIssuedThisRun` — an operator who reads the line can diagnose B-1. That
is the entire detection surface for this cluster.

---

### B-9 · **P3** · `sync-tango-opportunity-attachments.ts` contains a literal NUL byte and is binary to every text tool

`apps/api/scripts/sync-tango-opportunity-attachments.ts:171` uses a raw `U+0000`
as a delimiter in a dedupe key:

```ts
const key = `${row.id}\x00${url}`;   // the byte is literal in the source, not an escape
```

The intent (a separator that cannot occur in either component) is sound; the
encoding is not. `file` reports the source as `data`, `grep` reports
`Binary file … matches` and refuses to print context, and git treats it as
binary — so this file produces **no textual diff in any PR or review tool**. It
is the file that drives P29's SSRF-guarded fetch loop, i.e. among the last in
this cluster that should be invisible to review. `\u0000` or `\x00` as an escape
sequence is byte-identical at runtime and keeps the file text.

### B-10 · **P3** · The dispatcher's own usage string has stopped covering 46 verbs, 14 of them Tango

`apps/api/scripts/entrypoint-dispatcher.inc` dispatches 128 verbs; its
`Unknown command: … (expected: …)` string lists 82. Missing Tango/FO verbs:
`diag-tango-capabilities`, `diag-tango-health`, `sync-tango-entities`,
`generate-tango-enrichment-candidates`, `review-tango-enrichment-candidate`,
`sync-tango-vehicles`, `sync-tango-forecasts`, `sync-tango-dibbs`,
`sync-tango-sbir`, `sync-tango-opportunity-shadow`,
`diag-tango-opportunity-parity`, `sync-tango-opportunity-notices`,
`sync-tango-opportunity-attachments`, `sync-tango-opportunity-text`.

This is D-69's own generalisation recurring one layer out — *"a hand-maintained
list of things to check silently stops covering the newest thing"* — here on the
error path, which is also D-69's *"lives on the failure path… printed
approximately never"* observation. Cosmetic in isolation; noted because the
program has now hit this exact shape three times (D-19, D-24, D-69).

---

## Verified clean — recorded so a later reader does not re-litigate them

**Commissioned question 2 — the checkpoint boundary is clean.** Checked
exhaustively, in both directions:

- The CHECK admits exactly six values and has never been widened:
  `20260821010000_tango_source_substrate/migration.sql:173-174`. It is the only
  migration in the repository that mentions
  `tango_sync_checkpoint_resource_type_chk`.
- The TypeScript vocabulary matches it exactly, value for value:
  `tango.types.ts:48-55`.
- `TangoStoreService.writeCheckpoint` guards every write with
  `assertKnownResourceType` (`tango-store.service.ts:424`, definition at
  `227-234`), which throws a `BadRequestException` on anything outside the set —
  so even an untyped caller cannot reach the CHECK.
- Every call site passes a string literal from the allowed set:
  `'entity'` (`sync-tango-entities.ts:150,167,222`),
  `'vehicle'`/`'vehicle_awardee'` (`sync-tango-vehicles.ts:172,209,219,245`),
  `'forecast'` (`sync-tango-forecasts.ts:159,228`),
  `'notice'` (`sync-tango-opportunity-notices.ts:231,309`),
  `'opportunity'` (`sync-tango-opportunity-shadow.ts:204,271,316`,
  `diag-tango-opportunity-parity.ts:315,319`).
- **DIBBS and SBIR never write a checkpoint row of any kind.** Their only
  references to `tango_sync_checkpoint` are the file-header comments explaining
  why not (`sync-tango-dibbs.ts:22-40`, `sync-tango-sbir.ts:24-41`), and both
  correctly cite the CHECK and the absence of a provider `modified_after`
  filter. Their resume strategy is a high-water mark derived from the rows the
  sync itself wrote.
- Subawards uses a separate table (`tango_subaward_sync_checkpoint`) keyed on
  `sync_key`, with no `resource_type` column at all.

**No write path exists that could hit the CHECK, and no coercion path exists
that could produce a wrong-but-successful write.** This is the one seam in the
cluster that is exactly as clean as its documentation claims.

Also verified sound and left alone:

- Rate-header parsing (`rateOf`) is byte-identical across the DIBBS, SBIR and
  subaward clients — no drift.
- Secret redaction on the error path is present and correct in all three REST
  clients; the DIBBS/SBIR variant (`rawText.split(key).join('[REDACTED]')`)
  handles repeated occurrences, which the subaward variant
  (`.replace(key, …)`, single occurrence) does not — noted, not filed, since
  a bounded 500-char slice makes the practical difference negligible.
- `MAX_PROVIDER_WAIT_MS = 120_000` (D-75's fix) is present at **both** call
  sites in **both** DIBBS and SBIR — the pre-emptive application to SBIR held.
- `TangoResilienceService`'s breaker semantics match `config.schema.ts`'s
  pre-existing description exactly, including the half-open-failure-reopens
  rule (D-32).

---

## Mandatory question 5, in full: what rests on synthetic-fixture-only confidence

**Real-provider evidence that exists, by dataset:**

| Dataset | Entitlement proven live | Envelope proven live | Record contents validated against real data | Sync script itself run live |
|---|---|---|---|---|
| entities (P19) | P17 `not_attempted`; proven by D-36's run | via SDK | D-35 found a real field incompatibility | **yes** — D-36, `--commit` |
| vehicles / awardees (P22) | vehicles `supported`; awardees `not_attempted` in P17, exercised by D-41 | via SDK | D-41/D-42/D-43 | **yes** |
| forecasts (P24) | `supported` | via SDK | D-45, three confirmed field findings | **yes**, two commit runs |
| opportunities / crosswalk (P27) | `supported` | via SDK | **no** | **no record of one** |
| notices (P28) | `supported` | via SDK | **no** | **no record of one** |
| attachments (P29) | P17 returned **`not_found`** | n/a (reads SAM.gov, not Tango) | **no** | **no record of one** |
| extracted text (P30) | P17 returned **`not_found`** | n/a — makes no provider call by design | n/a | n/a |
| DIBBS (P40) | D-65 `supported` | D-65 | **yes** — D-71, 5 records × 3 endpoints, pinned as fixtures | **yes**, D-75/76 — but **never completed successfully** |
| SBIR (P42) | D-71 (first ever call) | D-71 | **yes** — D-71, 5 records × 2 endpoints, pinned as fixtures | **no** |

**Direct answer.** D-71's contract validation covers DIBBS and SBIR *and nothing
else*. It does not extend to forecasts, vehicles, notices, or attachments.

But the honest picture is not "everything except DIBBS/SBIR is synthetic" — it
is split differently, and the split is worth stating precisely because it is not
the one the question anticipated:

- **P19, P22, P24 are the best-evidenced phases in the cluster.** Each was run
  live with a real key against a real database, and each *found real defects
  that way* (D-35, D-41, D-42, D-43, D-45). Their mapper-level fixtures are
  synthetic, but their live runs were substantive, not smoke tests.
- **P40 and P42 have the best *record-level* evidence** — real captures pinned
  as permanent regression fixtures in `__fixtures__/real-captures/`, exempted
  from the synthetic-fixture rule with a written justification. But the DIBBS
  *sync* has never completed a successful full walk (D-75 stalled, D-76/77/78
  blocked on quota), and the SBIR *sync* has never been run at all.
- **P27, P28, P29 and P30 are the real gap.** All four are marked `deployed` in
  the completion matrix. All four are `*self-verified only — no independent
  reviewer*`. None has a recorded live-key run of its own sync script. Their
  "Live acceptance" cells name a code property or a bug found by reading
  (`Exactly-one-match → linked`; a `description` dimension fix; the SSRF
  canonicalisation hole; the SDK's semantic-search limitation) — real work, but
  none of it is real-provider-data evidence that the sync produces correct rows.
- **P29 and P30 are additionally the two capabilities P17 could not reach at
  all** (`not_found` on both `attachment_metadata` and `extracted_text`). P17's
  own report asks for follow-up in as many words: *"P29/P30 should investigate
  directly with a real query before assuming either 'broken' or 'fine' — a 404
  from a search endpoint is unusual enough to be worth a deliberate look."* No
  decision-log entry records that investigation. P30 sidesteps it honestly by
  making no provider call and seeding explicit `not_entitled`/`pending` statuses
  — the phase is correct about what it does not know. P29 does not need Tango at
  all (it reads `sam_opportunity.raw`), so P17's `not_found` is arguably moot
  for it — but that reasoning is not written down anywhere either, and the
  open question P17 raised is still open on paper.
- **The subaward adapter has no live-run record in the plan documents at all**,
  and cannot be run from the container (B-4).

And structurally, per **B-8**: for *every* dataset in this cluster, including the
best-evidenced ones, a scheduled run's success is evidenced by a log line and
nothing else. No exit code, no metric, no alarm. So the answer to the literal
question — "is there any sync job whose success is only ever evidenced by an
internal log line" — is: **all of them**, once they are running unattended.

---

## What an approval would require

1. **B-1** — P19 must distinguish a containment stop from a per-client failure,
   and must not write `completeness: 'complete'` for a batch it did not
   successfully process. Four sibling scripts already show the shape.
2. **B-2** — DIBBS/SBIR retry must cover the same set the shared mechanism
   defines as retryable, or the divergence must be recorded with a reason.
3. **B-3** — the DIBBS/SBIR path must either record `tango_api_usage` rows or
   the plan must record that account-level accounting is deliberately partial,
   naming what that costs the next D-75.
4. **B-4** — subawards needs rate-limit handling equivalent to its siblings; if
   the adapter is dormant, it should be marked dormant rather than left runnable
   from a shell with none.
5. **B-5 through B-8** — closed, or written into the decision log with a stated
   reason. The program's own standard (D-15, D-46, D-52, the SBIR topic model's
   "no column, because a column nothing can populate reads as 'we have this and
   it is null'") is that an omission is acceptable when it is *recorded*. None
   of these five is recorded anywhere.

---

## Approval record

**Verdict: `BAND_B_INGESTION_ADAPTERS_REJECTED`** — 2026-08-13, by an
independent agent (not the agent that implemented, deployed, or handed off any
phase in this cluster), reviewing at pinned commit `d800dcfde5`, read-only,
against `docs/runbooks/phase-2-independent-live-validation.md`'s §6.2
convention.

Rejected on B-1 (P0). B-2, B-3, B-4 are independently sufficient.

Worth stating plainly for the record: **this is the first §6.2 independent
review any phase in this cluster has received.** `completion-matrix.md` carries
`*pending*` in the Review column for P14–P25 and `*self-verified only — no
independent reviewer*` for P26–P51. P40's row is the sole exception and only
partially — *"read by Neo 2026-08-08 — the first human review any phase in this
program has had; §6.2's independent tester still has not run."* D-55 and D-61
both record this gap. Four of the ten findings above (B-1, B-2, B-5, B-6) are
cross-phase by construction: each is invisible from inside any single phase and
becomes obvious only when two phases are read against each other. That is the
argument for the convention, made empirically.

No file was modified. Nothing was staged, committed, or pushed.
