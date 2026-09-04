# Band B — alerting / observability, independent §6.2 review

**Verdict: `BAND_B_ALERTING_OBSERVABILITY_REJECTED`**

**Reviewed:** 2026-08-13, by an independent reviewer who did not write, review, or
deploy any phase of this program. Read-only: nothing in this review ran a command
against `capiro-dev`, edited a document, or touched a working tree other than to
write this file. No fix was applied; every finding below is queued, not resolved.

**Pinned to:** `d800dcfde51f6cf21a4b54b511006b9001fd6d2b` (`main`, 2026-08-13 16:40
-0400). Every quotation is `git show d800dcfde5:<path>`, not a working-tree read.

**Verdict vocabulary** (following `docs/runbooks/phase-2-independent-live-validation.md`
§8, the program's established two-string convention):

```
BAND_B_ALERTING_OBSERVABILITY_INDEPENDENTLY_APPROVED
or
BAND_B_ALERTING_OBSERVABILITY_REJECTED  (list every failing check)
```

**Scope:** the six `diag-tango-*` / `diag-funding-opportunities-*` diagnostics; the
CloudWatch metric/alarm surface backing this program; and the
`TANGO_DIBBS_SYNC_DONE` / `TANGO_SBIR_SYNC_DONE` / `INGESTION_METRIC` log lines the
zero-rows investigation has been leaning on as evidence.

**The failure mode swept for**, per this program's own two confirmed incidents — a
real failure (wrong table/column, thrown exception, timeout, uninstrumented call
path) being silently coerced into a value that reads as *no data* / *healthy* /
*nothing to report* rather than *the check itself is broken*.

---

## Summary

The six diagnostic scripts are, as a group, **better than the brief's premise
assumed.** The P49 `QUERY FAILED` fix is real, correctly applied, and pinned by
name-specific regression tests. The `rate_limited` fix is real. Four of the six
scripts surface a thrown exception as its own distinct, labelled state. I found no
third instance of the original bug inside the diagnostic scripts themselves.

The failures are one layer down, and they are worse:

1. **Every `sync-tango-*` job is invisible to the only ingestion alarm that
   exists** — none of them emits the log line the metric filter reads.
2. **None of the 8 named alarms exists as a resource.** They are a markdown table.
   The runbook's instruction to force each one's condition has never been executed
   because there is nothing to force.
3. **DIBBS and SBIR API calls are recorded nowhere**, so the two diagnostics whose
   stated job is to report throttling structurally read zero during the ~19.7-hour
   account-wide block this program spent three sessions chasing.

The scripts are honest. The system they report on is largely uninstrumented, and
the gap between those two facts is what this band rejects.

---

## Findings, severity-ranked

### B-1 · P0 · Every Tango sync job is invisible to the only ingestion alarm

The single alarm covering scheduled ingestion is `capiro-{env}-ingestion-error`
(`infra/cdk/lib/alarms-stack.ts:279`), fed by `IngestionErrorMetricFilter`
(`infra/cdk/lib/compute-stack.ts:1545`) which matches `{ $.error_count = * }` on the
`/capiro/{env}/api-sync-jobs` log group. That JSON is emitted only by
`emitMetricLine` inside `runWithSyncRun` (`apps/api/src/ingestion/sync-run.helper.ts:80`).

**Not one `sync-tango-*` script calls `runWithSyncRun`, and not one emits
`INGESTION_METRIC`.** Verified directly:

```
git grep -ln "runWithSyncRun"    d800dcfde5 -- "apps/api/scripts/*tango*"   → no matches
git grep -ln "INGESTION_METRIC"  d800dcfde5 -- "apps/api/scripts/*tango*"   → no matches
```

That covers all twelve: `sync-tango-entities`, `-vehicles`, `-forecasts`, `-dibbs`,
`-sbir`, `-subawards`, `-opportunity-notices`, `-opportunity-shadow`,
`-opportunity-text`, `-opportunity-attachments`, `process-tango-events`,
`reconcile-tango-webhook-alerts`. Each can fail on every scheduled run, forever,
with the alarm reading `OK`.

Compounding it: the filter sets `defaultValue: 0`, so the metric publishes a literal
zero for every log event that does not match. The alarm is not merely missing data
that `treatMissingData: NOT_BREACHING` would wave through — it is affirmatively,
continuously green.

The two producers added in D-79 (`generate-dibbs-opportunity-candidates`,
`generate-sbir-opportunity-candidates`) *do* use the helper — but only under
`--commit`; a dry run emits nothing.

This is the band's central finding. It is the same shape as the two known bugs at
the infrastructure layer: a real failure renders as the value that means healthy.

### B-2 · P0 · None of the 8 named alarms exists in CDK; none has ever been tested

The 8 live in `docs/runbooks/funding-opportunities-rollout.md:1968-1977` as a
three-column markdown table — Last success age, Error / degraded run, Checkpoint
incompleteness, 429 / breaker, Webhook signature failures, Queue age, Poison events,
Alert volume. They are named, their signals are named, and their rationale is
written. Nothing more.

I enumerated every `new cloudwatch.Alarm(...)` under `infra/cdk/lib/`:

- `alarms-stack.ts` — Alb5xx, ApiTarget5xx, {Api,Web,Marketing}Unhealthy,
  {Api,Web,Marketing}RunningCount, AuroraCpu, AuroraConnections, PeSyncError,
  PeSyncStaleBySource, PeSyncDuration, IngestionError
- `constructs/scheduled-memory-projection-worker.ts`
- `engagement-api/engagement-api-alarms.ts`
- `meriv2-control-stack.ts`

**Not one is Tango or Funding-Opportunities.** The nearest neighbours are
Program-Element-specific by namespace (`Capiro/ProgramElementSync`), and
`IngestionError`, which B-1 shows cannot see these jobs.

The runbook's own next sentence (`funding-opportunities-rollout.md:1979`):

> Test each alarm by forcing its condition once. An untested alarm is a hypothesis.

I searched `decision-log.md` (2800+ lines), `completion-matrix.md`, all seven
`HANDOFF-*.md`, `funding-opportunities-rollout.md` and
`funding-opportunities-makegov-canary.md` for any record of an alarm being created,
fired, forced, or observed in any state. **Zero evidence, for any of the eight.**
The instruction has not been executed, and could not have been: the resources do
not exist. These are not untested alarms. They are eight sentences.

**Two brief corrections, recorded so the next reviewer is not misled.** First, the
eight are §33's, program-wide, not P48's — P48 contributes at most Queue age, Poison
events and Alert volume. Second, the eight `OK` alarms in
`phase-2-independent-live-validation.md` §1 (Cpu, DatabaseConnections,
FatalBootstrap, HealthyHosts, InvalidShadowPosture, LatencyP95, Memory, Target5xx)
belong to **engagement-api**, a different program on the same account. The
coincidence of the number 8 is exactly the kind of thing that gets a green
screenshot pasted under the wrong heading.

### B-3 · P0 · DIBBS/SBIR calls are recorded nowhere, so both throttling diagnostics read zero during a real block

`tango_api_usage` is written only by `TangoResilienceService.recordUsage`
(`tango-resilience.service.ts:361,375`) → `TangoStoreService.recordUsage`
(`tango-store.service.ts:479`).

`TangoDibbsClient` and `TangoSbirClient` contain **no reference** to the store, the
resilience service, or usage recording of any kind. `sync-tango-dibbs.ts` and
`sync-tango-sbir.ts` construct those clients directly and are absent from the list of
scripts touching `TANGO_RESILIENT_GATEWAY` / `TangoResilienceService` (that list is
`sync-tango-entities`, `-forecasts`, `-opportunity-notices`, `-opportunity-shadow`,
`-vehicles`, plus `diag-tango-health`).

Two consequences, both of them the failure mode in scope:

- `diag-tango-health.ts` prints
  `TANGO_HEALTH_NOTE No usage recorded in the last N minute(s).` — which reads as
  *quiet* / *idle* / *nothing happening* — during a window in which DIBBS and SBIR
  calls were being issued and hard-blocked.
- The canary's `rate-limited (429)` measurement
  (`WHERE "status" = 'rate_limit'`) returns a genuine, non-failed `0`. That zero is
  indistinguishable from *the provider never throttled us*.

This is not hypothetical. D-76, D-77 and D-78 record an account-wide block on
exactly these two clients: ~3.6h, then ~19.7h, then the day's budget gone almost
immediately — chased across three sessions. **The two diagnostics whose stated job
is to report throttling could not have seen any of it,** and §33's "429 / breaker"
alarm would have had no data to fire on even if it existed.

**Explicitly checked and clean:** the status vocabulary itself is correct.
`tango_api_usage.status` is CHECK-constrained to `'success'` plus the seven
`TANGO_ERROR_KINDS` (`schema.prisma:6475-6478`), and `rate_limit` — the literal used
by both the canary SQL and `getUsageHealth`'s `byStatus.rate_limit` — is the real
kind name. This is **not** a repeat of the `agrees`/`agreement` bug. The query is
right; the instrumentation never reaches the code that fails.

### B-4 · P1 · `complete: true` is a default, not a measurement — and the cited log line has four indistinguishable causes

This is the direct answer to the brief's question 2.

**First, credit where it is due.** `error_count` *is* backed by a real per-row
try/catch. `generate-dibbs-opportunity-candidates.ts` wraps each (client ×
solicitation) evaluation in `catch (err) { counts.errors += 1; console.warn(...) }`,
and a genuine throw out of the keyset walk propagates through
`generateDibbsCandidates` → `execute()` → `runWithSyncRun`'s inner catch →
`emitErrorMetricOnce()` → `error_count: 1`. The brief's specific worry — *the entire
candidate query throwing before any row is attempted* — is **handled**:
`readClientProfileFactsMany` or `tangoDibbsSolicitation.findMany` throwing does
produce `error_count: 1`, not `0`. The W4.3 `emitErrorMetricOnce` guard
(`sync-run.helper.ts:143`) genuinely closes the setup-failure hole it claims to.

**Now the problem.** `emitMetricLine` renders completeness as:

```ts
complete: counts.complete !== false,
```

`emptyCounts()` returns `{inserted:0, updated:0, skipped:0, errors:0}` and sets no
`complete` field at all. `undefined !== false` is **`true`**. So *a job that never
forms an opinion about its own coverage asserts full coverage.* That is the em-dash
bug's exact shape, relocated into the metric layer: absence of a claim renders as an
affirmative healthy claim.

The cited line —

```
INGESTION_METRIC {"rows_inserted":0,"rows_updated":0,"error_count":0,"complete":true}
```

— is byte-identical across at least four states:

1. **`resolveTenantIds` returned `[]`** — no tenant has the `funding_opportunities`
   flag enabled. The `for (const tenantId of options.tenantIds)` body never
   executes; `clientWalkOutcome` stays `null`; `undefined === 'INCOMPLETE'` is false,
   so coverage resolves to `completeCoverage(0, 0)` → COMPLETE. **This is the
   documented live state** — D-79 records the whole sync→producer chain as dormant
   end-to-end, schedules `enabled: false`, nothing enabled on `capiro-dev`.
2. Flag enabled, but the client query returns zero clients.
3. Clients exist, but `tango_dibbs_solicitation` holds zero rows matching
   `activeSolicitationWhere`. **Also the documented state** — DIBBS/SBIR ingestion
   never completed (D-75 through D-78).
4. A genuinely complete run over a real corpus in which nothing cleared the floor.

**What that line actually evidences:** the job process started, connected to
Postgres, and exited without throwing. **It does not evidence that any tenant, any
client, or any solicitation was ever examined.** The numbers that would separate
(1)–(3) from (4) — `evaluated=`, `clients=`, `solicitations=` — are printed on the
`[dibbs-candidates]` stdout line, which is not JSON and is captured by no metric
filter. Any conclusion the zero-rows investigation drew from `error_count:0,
complete:true` about pipeline health is over-read; the line is fully consistent with
the job having had no scope, no corpus, and no tenants.

Two further ambiguities in the same line's absence:

- The `INGESTION_SKIP` path returns `emptyCounts()` and emits **no metric line at
  all** — while `sync-run.helper.ts:143`'s own comment asserts the skip path is one
  of those that "emit their own line and set the flag." The comment is wrong about
  the code directly beneath it. Absence of the line is therefore also ambiguous.
- `runWithSyncRun` is invoked only under `--commit`. A dry run emits nothing.

### B-5 · P1 · Both new producers reproduce the `geocode-facilities` bug their own helper's docblock exists to prevent

`apps/api/src/ingestion/embed-watermark.ts:46-58` documents why `errorMessage`
exists, naming the incident: a job that caught per-row failures and returned
`errors: N` landed as `success_with_errors` with a null message, which is how
`geocode-facilities` failed the same row on nine consecutive nights (2026-07-21 to
2026-07-30) with no way to see the cause without reading raw task logs.

`generate-dibbs-opportunity-candidates.ts` and
`generate-sbir-opportunity-candidates.ts` both catch per-row, increment
`counts.errors`, `console.warn` the reason to stderr, and **never set
`errorMessage`** — `GenerateResult` does not carry the field. Both therefore land as
`success_with_errors` with `error_message = NULL`: the nine-nights shape exactly.

Verified this is a deviation, not a universal gap — `errorMessage` is set by
`geocode-facilities.ts:124` and eight other scripts, and by neither of these two.

### B-6 · P2 · The P49 canary detects its own query failures, then discards the signal

`hasQueryFailure()` (`diag-funding-opportunities-makegov.ts:179`) is exported,
correct, and asserted by two spec tests. **It is never called by `main()`** — the
only non-spec reference in the tree is its own definition.

So the canary exits `0` whether zero queries failed or all twenty did. The
`QUERY FAILED — <reason>` lines *are* printed and visible to a human reading stdout,
so this is not a return of the em-dash bug. But any automated caller, CI step, or
`&&` chain reads success. The helper that distinguishes broken-from-empty exists and
is then not consulted at the one point where the distinction becomes an exit code.

### B-7 · P2 · `sync-tango-dibbs.ts`'s per-row catch discards the reason entirely

In `walkEndpoint`:

```ts
try {
  await deps.upsertAward(row);
} catch {
  summary.errored += 1;
  summary.written -= 1;
}
```

Bare `catch {}` — no binding, nothing logged. Same for `upsertSolicitation`. The
count survives; the cause does not. A constraint violation on every row yields
`errored: N` with zero information about why and no log line to correlate against.
This is the mirror image of B-5: there, the count is kept and the message dropped at
the SyncRun layer; here it is dropped at the source.

Secondary: in dry-run (`--commit` false), `summary.written += 1` counts rows that
were never written and `errored` stays `0` by construction. `TANGO_DIBBS_SYNC_DONE`
does carry `commit: false` alongside, so it is recoverable by a careful reader — but
`written` is the wrong word for it, and a reader scanning the summary for a health
signal sees a success-shaped number.

### B-8 · P2 · The `rate_limited` fix — one of the two known incidents — has zero test coverage

`tango-capability-probe.service.ts:501-508` classifies `rate_limit` as its own
`'rate_limited'` status rather than folding it into `'error'`, with a twelve-line
comment recording the 2026-08-08 incident and why collapsing the two misled a reader
into seeing a P44 regression that did not exist.

`tango-capability-probe.service.spec.ts` is 549 lines and contains **zero**
occurrences of `rate_limited`. `diag-tango-capabilities.spec.ts` covers CLI parsing
and `formatSummary` only. The fix is correct today, and nothing in the suite would
catch its removal or regression.

### B-9 · P3 · `diag-tango-health.spec.ts` tests only CLI flag parsing

Four tests, one `describe('CLI parsing')`, nothing else. The report path — the part
that could mislead — has no script-level coverage.

Mitigating: `getUsageHealth` itself is well covered (`tango-store.service.spec.ts`,
8 tests) and is genuinely well-built. `successRate` is `null`, not `0`, when there
are no calls, with the reasoning stated in a comment: *"0% success" and "no calls
happened" are different facts an operator should not confuse.* That is the right
instinct, applied correctly. B-3 is what defeats it — the table it reads is empty for
the two clients that were actually failing.

### B-10 · P3 · Two latent string-vocabulary couplings with no test pinning the literals

Not bugs today; both verified correct against the current schema. Both are the same
class as the `agrees`/`agreement` bug, and neither has a test that would catch drift:

- `diag-tango-opportunity-parity.ts`:
  `resolutionCounts.get('unreviewed') ?? 0` and `byAgreement['ambiguous'] ?? 0`.
  If either DB vocabulary drifts, the count silently becomes `0` and the
  operator-set threshold can never breach — a wrong literal rendering as *nothing to
  report*.
- `diag-tango-webhook-contract.ts`: `hasTypeKey` is computed from `idKeys`. That
  variable is `[...sample.envelopeKeys, ...sample.eventKeys]`, which is the union
  both checks want, so it is functionally correct — but the name makes it read as a
  copy-paste bug, and a future edit narrowing `idKeys` to id-only keys would
  silently break the event-type check with no test failing.

---

## What passes — stated explicitly, so it is not re-litigated

- **`diag-tango-capabilities.ts` / `tango-capability-probe.service.ts` is the
  strongest of the six.** Seven distinct outcomes (`supported`, `tier_gated`,
  `not_found`, `rate_limited`, `error`, `unsupported`, `not_attempted`), each
  carrying an explicit `reason`. An auth failure on the version preflight
  short-circuits the rest *and is labelled as such* via `TANGO_PROBE_WARN`, so the
  resulting `not_attempted` results cannot be misread as capability findings. No
  coercion toward healthy anywhere in the file.
- **The P49 fix pattern is real and correctly applied.** `Measured` and `failure()`
  do what they claim; `safeCount` even treats "a COUNT returned no row" as a failure
  rather than as zero. The three previously-broken queries are corrected *and*
  pinned by name-specific regression tests, including
  `expect(double.sql.some(q => q.includes('tango_entity_profile'))).toBe(false)` —
  a test that asserts the absence of the specific wrong table.
- **`diag-tango-opportunity-parity.ts` does not swallow.** Any reader failure
  propagates out of `Promise.all` → `TANGO_OPP_PARITY_ERR` + exit 1. And "the sync
  has never completed a run" explicitly *breaches* a staleness threshold rather than
  reporting fresh, with the reasoning in a comment.
- **`diag-tango-webhook-contract.ts` gives "not configured" its own exit code**
  (`EXIT_NOT_CONFIGURED = 2`), distinct from both agreement (0) and mismatch (1).
  Unconfigured cannot read as agreeing. It also refuses to adopt the provider's
  value on mismatch — correct, that would be taking security config from the network.
- **`diag-tango-contract-capture.ts`** refuses to overwrite an existing capture,
  double-redacts every error string, and records-and-skips a failed endpoint rather
  than letting one dead endpoint cost the other four.
- **`isDirectRun` guards** are present and correct on all six, so importing a module
  for its pure exports cannot fire a real DB connection or network call.

---

## The mandatory question: how many lines to make one of these always report success?

| Script | Lines | The edit |
|---|---|---|
| `diag-tango-capabilities.ts` | **1** | final ternary `: 'error'` → `: 'supported'`. Every failed probe reports supported; `formatSummary` just prints `p.status`. |
| `diag-tango-webhook-contract.ts` | **1** | `agrees: providerHeader.toLowerCase() === …` → `agrees: true`. Renders "All checked assumptions agree with the provider sample", exits 0. |
| `diag-tango-contract-capture.ts` | **1** | in `captureOne`'s catch, set `ok: true`. Prints `dibbs/rfqs  ok  records=0` — with `documented`/`undocumented` computed from an empty record set, there is no MISSING or UNDOCUMENTED suffix, so the line is identical to a legitimately-empty endpoint. |
| `diag-tango-opportunity-parity.ts` | **1** | delete `if (report.breaches.length > 0) process.exitCode = 1;`. Report still prints; exit is always 0. |
| `diag-funding-opportunities-makegov.ts` | **2** (1 suffices) | `safeCount`'s `catch (e) { return failure(e); }` → `catch { return 0; }`; `safeValue`'s → `catch { return null; }`. **Either one alone restores the exact P49 bug.** |
| `diag-tango-health.ts` | **0** | It already always exits 0 — its two warnings are `console.error` advisories with no exit-code consequence. To corrupt the *numbers* you must edit `tango-store.service.ts`. It is the only one of the six whose honesty is not locally editable, because it delegates. |

**One line in four of the six, two in a fifth, zero in the last.** And in the canary
that single line sits *inside the function that exists solely as the remediation for
the previous incident.*

**Stated plainly, as the brief asks:** this is fragile, and the fragility is
structural rather than stylistic. Each of these reports is a single unreplicated
narrator. There is no checksum on the output, no cross-check against an independent
source, and — for five of the six — no test that forces a failure end-to-end and
asserts the rendered output says so. Both of this program's confirmed bugs of this
shape were caught by a human reading raw SQL, and nothing in the tree has changed
that. B-1 and B-2 are the same observation at the infrastructure layer: the alarms
that would constitute a second, independent signal do not exist, so the diagnostics
are not merely the best evidence available — they are the *only* evidence available,
and they are one line each from lying.

The cheapest structural remedy is one fixture-driven test per script that forces a
failure and asserts the rendered output contains the distinct failure token. The
canary already has precisely that test — `reports a MISSING table as a FAILURE, and
still finishes the report` — and it is why B-6 was the only thing left to find there.
The other five have no equivalent.

---

## What would move this to `BAND_B_ALERTING_OBSERVABILITY_INDEPENDENTLY_APPROVED`

Every P0 closed, and the P1s either fixed or explicitly accepted in the decision log
with reasoning:

1. **B-1** — `sync-tango-*` jobs emit `INGESTION_METRIC` (adopt `runWithSyncRun`, or
   an equivalent the existing metric filter matches), so a failing Tango job is
   capable of turning the one existing alarm red.
2. **B-2** — the 8 alarms exist as CDK resources, and each has been forced once with
   the observation recorded, per the runbook's own instruction. An alarm that has
   never fired is not evidence of anything.
3. **B-3** — DIBBS and SBIR calls record to `tango_api_usage` (or the two
   throttling diagnostics state, in their own output, that these two sources are
   outside their coverage — an honest gap beats an invisible one).
4. **B-4** — `complete` is set explicitly by every job rather than defaulting to
   `true`, and the zero-scope path is distinguishable in the metric line from a
   completed run. Until then, no reviewer should cite `error_count:0, complete:true`
   as evidence about anything other than "the process exited without throwing."
5. **B-5** — both producers set `errorMessage`, per their own shared helper's docblock.

None of the above is blocked on anything external. B-4 and B-5 are single-field
changes; B-1 is a wrapper adoption; B-2 and B-3 are the real work.

**A note on what this verdict does and does not say.** It does not say the
diagnostics are badly written — four of the six handle failure better than the brief
assumed, and the P49 remediation is a genuinely good piece of work that held up
under a hostile read. It says that the observability *system* around them is close
to absent, that three of its load-bearing claims are unsupported by any resource or
instrumentation, and that the one log line this investigation has leaned on carries
substantially less information than it has been read to carry.
