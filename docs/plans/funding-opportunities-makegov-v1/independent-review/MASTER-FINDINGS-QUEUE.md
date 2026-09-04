# Master findings queue — Funding Opportunities + MakeGov/Tango independent review

**Consolidated from all 15 review files in this directory.** Pinned commit for every
underlying review: `d800dcfde51f6cf21a4b54b511006b9001fd6d2b`.

**This is an inventory, not a remediation plan.** No fix is proposed here. Each finding
carries a *classification* of what kind of decision it needs — (a) documentation, (b) code
or infrastructure, (c) a human/business judgement — and nothing more. Choosing what to do
about any of it is the reader's call, not this document's.

**Nothing in this file was fixed, staged, committed, or deployed.** It was written into the
detached review worktree only.

---

## EXECUTIVE SUMMARY

**118 distinct findings** across 15 independent reviews, after deduplication (the raw
count across the 15 files is ~135; 17 were merged because two or more reviewers found the
same thing from different angles).

| Severity | Count |
|---|---:|
| **P0** — blocking; ships broken, loses data, or defeats a stated control | **13** |
| **P1** — high probability of silent loss, or a phase's own stated acceptance disproven | **27** |
| **P2** — the evidence does not support the claim; real but narrower | **39** |
| **P3** — real, narrow, or cosmetic-with-consequence | **27** |
| **P4** — informational; recorded so it is not re-derived | **12** |
| **Total** | **118** |

By **primary** classification: **(a) documentation-only, no risk to change — 49**;
**(b) code or infrastructure change — 63**; **(c) needs a human or business decision — 6**.
A further **10** findings carry a secondary (c) component — i.e. **16 of the 118 cannot be
closed without somebody deciding something** (P0-3, P0-6, P0-7, P0-8, P0-9, P1-1, P1-4,
P1-11, P1-16, P1-20, P1-22, P1-26, P2-38, P4-2, P4-8, P4-11).

**Review coverage: 43 of 52 phases now carry a real independent verdict; 9 do not.**
Before this effort the matrix recorded **zero** §6.2 verdicts across all 52 rows (26
`*pending*`, 26 `*self-verified only*` in some form — counted mechanically in
`band-a-p51-ga-closeout.md` §2). The 9 phases still with no independent review of any kind
are **P05, P20, P21, P31, P37, P38, P39, P44, P45**.

**Of the 15 reviews, 12 returned a rejection**, 2 returned an approval
(`band-b-lifecycle-events`, `band-a-d79-producer-wiring`), and 1 returned a split verdict
(`flag-ui-reconciliation`). `band-c-attestation` confirmed both of its phases (P00, P09) as
genuinely inert/presentation-only.

### The one paragraph, if you read nothing else

**This program cannot tell a working run from a run that did nothing, and six independent
reviewers found that same fact from six different directions** — the ingestion metric line
defaults `complete` to `true` when no job ever formed an opinion, `statusFromCounts` ignores
rows written entirely, not one `sync-tango-*` job emits the log line the only ingestion
alarm reads, none of the 8 alarms the rollout runbook requires exists as a resource,
DIBBS/SBIR API calls are recorded in no usage table so both throttling diagnostics read zero
during a real 19.7-hour provider block, and the canary's flagship tripwire is satisfied
*more easily* when the step under test did nothing. That is the exact mechanism behind the
zero-rows incident that triggered this whole effort, it is systemic rather than local, and
it is unrelated to the two matching defects (B-1/B-2 in `band-b-matching-scoring.md`) that
independently guarantee DIBBS fans out across the entire open corpus and SBIR produces zero
rows forever once the chain is enabled. Separately and urgently: one finding is a **live
breakage right now** — `capiro-dev-api-admin-migrate:13` and `:14` export a `DATABASE_URL`
whose password is the literal string `***`, so the canonical migration path for `capiro-dev`
fails authentication on its next run (P1-9).

### Severity normalisation

The 15 reviews used four different severity vocabularies (`P0–P4`, `HIGH/MEDIUM/LOW`,
`P1–P3`, `High/Medium/Low/Info`). They are normalised here to `P0–P4`. **Where two
reviewers rated the same finding differently, the higher rating is used and both are
shown.** No finding's severity was invented; every one traces to a rating a reviewer
assigned.

### Where reviewers independently confirmed each other

Twelve findings were reached by more than one reviewer working from a different angle. That
is the strongest confidence signal in this inventory and each is marked `[CONFIRMED ×N]`
below. The clusters:

| Cluster | Reviewers | Angles |
|---|---:|---|
| A no-op run is indistinguishable from a healthy one (P0-1) | **6** | producer instrumentation, SyncRun status, CloudWatch, sync scripts, canary checklist, route-level assertions |
| Fake-backed tests hide real-DB / real-interop behaviour (P2-31, P2-33, and throughout) | **5** | P08 service, D-79 producers, scorers, keyset walks, webhook signing |
| DIBBS/SBIR rails have no server-side capability gate (P1-1) | **3** | UI/flag reconciliation, guard trust boundary, canary flag table |
| The 8 required alarms do not exist (P0-2) | **2** | live CloudWatch sweep (50 alarms), CDK source enumeration |
| DIBBS/SBIR calls recorded nowhere → diagnostics blind (P0-3) | **2** | adapter side, diagnostic side |
| `Capiro-dev-Compute` blast radius / drift (P0-7) | **2** | EventBridge collision analysis, stack resource census |
| Program jobs have no live EventBridge rule; P27–P30 have no declaration (P1-10) | **2** | live rule inventory, CDK schedule file |
| `funding_opportunities_tango_shadow` gates nothing (P0-9, P3-26) | **2** | canary runbook, guard flag table |
| Stale "P40–P43 blocked on the provider" text (P1-18, P1-19, P1-26) | **2** | closeout audit, canary runbook audit |
| Hand-maintained lists silently stop covering the newest thing (P1-12, P3-8) | **2** | CI migration guard list, dispatcher usage string |
| `intel_feature_flag` invisible to this repo's schema/migrations/CI (P3-21) | **2** | producer execution, migration replay |
| Two migration-related claims in the matrix that D-70 already disproved (P2-36) | **2** | closeout audit, infra migration record |

### One recorded disagreement between reviewers

`band-a-flag-guard.md` §3.3 **explicitly contradicts** `flag-ui-reconciliation.md` §3 and is
the later, better-evidenced read: the producer's CLI is *not* "the only control", because
`resolveTenantIds()` selects tenants by the **master** `funding_opportunities` flag and the
scheduled command passes no `--tenant`. The blast radius is every master-flag tenant, not
one. Folded into P1-1 with the correction recorded.

---

## P0 — 13 findings

### P0-1 · A run that did nothing is indistinguishable from a healthy run `[CONFIRMED ×6]`

The headline systemic finding. Six reviewers, six angles, one mechanism: absence of a claim
renders as an affirmative healthy claim.

- **Sources:** `band-b-alerting-observability.md` B-4 (P1) · `band-a-d79-producer-wiring.md`
  F2 (HIGH) · `band-b-lifecycle-events.md` F-1 (Medium) · `band-a-p07-p08.md` §5 / F-5
  (Medium) · `band-b-ingestion-adapters.md` B-8 (P2) · `band-a-p49-canary.md` "Mandatory
  question"
- **Affected:** `apps/api/src/ingestion/sync-run.helper.ts:80,143` (`emitMetricLine`,
  `complete: counts.complete !== false`) · `apps/api/src/ingestion/embed-watermark.ts:64`
  (`statusFromCounts` reads only `complete` and `errors`, never `inserted`/`updated`) ·
  `apps/api/scripts/generate-dibbs-opportunity-candidates.ts` and
  `generate-sbir-opportunity-candidates.ts` (`counts.skipped` computed then discarded twice)
  · all ten `apps/api/scripts/sync-tango-*.ts` (none exits non-zero for `rateLimited`,
  `ceilingReached`, `errored > 0`, or `completeness: 'in_progress'`) ·
  `apps/api/scripts/diag-funding-opportunities-makegov.ts` (no decision/action write
  counter) · `docs/runbooks/funding-opportunities-makegov-canary.md` acceptance checklist
- **The evidentiary point:** `INGESTION_METRIC {"rows_inserted":0,...,"complete":true}` is
  byte-identical across four states — no tenant had the flag, no client matched, no corpus
  row matched, and a genuinely complete run. It evidences only that the process started,
  connected, and exited without throwing.
- **Class: (b) code.**

### P0-2 · Every `sync-tango-*` job is invisible to the only ingestion alarm that exists

`capiro-{env}-ingestion-error` is fed by a metric filter matching `{ $.error_count = * }`,
emitted only by `runWithSyncRun`. Not one of the twelve Tango scripts calls it. The filter's
`defaultValue: 0` makes the metric publish a literal zero for every non-matching event, so
the alarm is not merely blind — it is affirmatively, continuously green.

- **Sources:** `band-b-alerting-observability.md` B-1 (P0); corroborated from the opposite
  direction by `band-b-ingestion-adapters.md` B-8 (no CloudWatch metric filter or alarm on
  any `TANGO_*_DONE` token anywhere in `infra/cdk/lib/`)
- **Affected:** `infra/cdk/lib/alarms-stack.ts:279` · `infra/cdk/lib/compute-stack.ts:1545`
  · `apps/api/src/ingestion/sync-run.helper.ts:80` · all twelve `apps/api/scripts/*tango*`
- **Class: (b) code/infra.**

### P0-3 · None of the 8 alarms the rollout runbook requires exists `[CONFIRMED ×2]`

Rollout §33 opens *"Create these before enabling, not after"* and instructs the operator to
force each alarm's condition once. Both reviewers found there is nothing to force.

- **Sources:** `band-b-alerting-observability.md` B-2 (P0) — enumerated every
  `new cloudwatch.Alarm(...)` under `infra/cdk/lib/`; none is Tango or Funding
  Opportunities · `band-a-p50-schedule-enablement.md` F5 (P1) — enumerated all **50** live
  CloudWatch alarms in `us-east-1` on account `967807252336`; **0 of 8** correspond
- **Affected:** `docs/runbooks/funding-opportunities-rollout.md:1968-1979` ·
  `infra/cdk/lib/alarms-stack.ts`
- **Also:** 5 of the 8 rows describe **database predicates**, not CloudWatch metrics, and no
  metric is emitted for any of them. §33 gives no namespace, dimension, threshold, period,
  or `put-metric-alarm` command.
- **Class: (b) code/infra for 3 of 8; (c) decision for the 5 DB-predicate rows** — what
  emits them, and whether §33 is a design requirement or a checklist.

### P0-4 · DIBBS/SBIR calls are recorded nowhere, so both throttling diagnostics read zero during a real block `[CONFIRMED ×2]`

`tango_api_usage` is written only by `TangoResilienceService.recordUsage`. `TangoDibbsClient`
and `TangoSbirClient` reference the store, the resilience service, and usage recording
**not at all**. D-76/D-77/D-78 record an account-wide block on exactly these two clients
(~3.6h, then ~19.7h) chased across three sessions — which the two diagnostics whose stated
job is to report throttling could not have seen.

- **Sources:** `band-b-alerting-observability.md` B-3 (P0) · `band-b-ingestion-adapters.md`
  B-3 (P1) — reached as "two rate-limit subsystems, one provider account, zero shared
  accounting"
- **Affected:** `apps/api/src/external/tango/tango-dibbs.client.ts`,
  `tango-sbir.client.ts` · `apps/api/scripts/sync-tango-dibbs.ts:98,100-117`,
  `sync-tango-sbir.ts` · `apps/api/scripts/diag-tango-health.ts` ·
  `docs/runbooks/funding-opportunities-makegov-canary.md` (the `rate_limited (429)` count)
- **Additionally on the DIBBS/SBIR path:** no per-run request ceiling (bounded only by
  `MAX_PAGES_PER_ENDPOINT = 10_000` per endpoint, i.e. up to 30,000 requests for a 3-endpoint
  `--full` walk), no circuit breaker, no auth fast-path. The code names this gap itself as
  the reason a real 4.5-hour production stall was un-diagnosable after the fact.
- **Class: (b) code**, or **(c)** a decision to state the coverage gap honestly in the
  diagnostics' own output instead.

### P0-5 · P19 converts every P18 containment signal into a green `complete` run

`runEntitySync`'s catch-all swallows `TangoRequestCeilingExceededError`,
`TangoCircuitOpenError` and `TangoAuthRejectedError` into `errored += 1`, then advances the
cursor unconditionally and writes `completeness: 'complete'` from a purely structural batch
test that never consults `errored`. A rejected key, an exhausted ceiling and an open breaker
all produce a run byte-for-byte indistinguishable from a healthy one. Four sibling scripts
(`sync-tango-vehicles`, `-forecasts`, `-opportunity-notices`, `-opportunity-shadow`) already
handle this correctly; P19, the earliest consumer, was left behind.

- **Source:** `band-b-ingestion-adapters.md` B-1 (P0) — the band's sole rejection ground
- **Affected:** `apps/api/scripts/sync-tango-entities.ts:205,217`
- **Why P0 not P1:** `ingestion-schedule.ts` puts five Tango jobs on the same
  rate-limited account within 85 minutes of each other, so the first thing that happens after
  P50's enablement is the condition that makes this fire, unattended.
- **Class: (b) code.**

### P0-6 · P46: every delivery body the provider's own SDK documents is rejected → 400 → permanently lost

`readEnvelope` resolves the delivery id from `[body.delivery_id, body.deliveryId, body.id,
deliveryHeader]`. Both body shapes `@makegov/tango-node@1.1.0` documents carry none of the
three body keys. Executed against P46's own exported `readEnvelope`: both documented shapes
→ `REJECTED missing_delivery_id` → HTTP 400 → *"will never succeed as sent. Stop retrying."*
This is the identical failure class PR #834 fixed for `missing_event_type`, still open for
`missing_delivery_id`, in the same function.

- **Source:** `band-a-p46-webhooks.md` F1 (P0) — registration-blocking
- **Affected:** `apps/api/src/webhooks/tango-webhook.service.ts` · `readEnvelope`
- **Class: (b) code + (c)** — the id source is a contract question that needs a real sample
  or a provider conversation.

### P0-7 · P46: the one surviving delivery-id path is an unsigned, undocumented header

`x-tango-delivery-id` appears nowhere outside Capiro's own source — verified by `git grep`
repo-wide (3 hits, all Capiro) and by grepping the entire vendor SDK, which documents exactly
one delivery header, `X-Tango-Signature`. Given P0-6, this is the *only* path that can ever
fire. Either it does not exist (P0-6 in full), or it does and the migration's *"whole replay
defence"* is keyed on attacker-controlled input. Executed: one captured signed body replayed
under three forged headers produced three distinct rows the unique index would allow.

- **Source:** `band-a-p46-webhooks.md` F2 (P0) — registration-blocking
- **Affected:** `apps/api/src/webhooks/tango-webhook.service.ts` ·
  `TANGO_DELIVERY_HEADER` · `apps/api/prisma/migrations/20260905010000_tango_webhook_deliveries/migration.sql`
- **Class: (b) code + (c).**

### P0-8 · The `cdk deploy Capiro-dev-Compute` prohibition understates its own blast radius by a wide margin `[CONFIRMED ×2]`

§34's entire warning is three lines. Measured live on 2026-08-13:

- **58 of the 94** jobs in `INGESTION_JOBS` produce a rule name that already exists live,
  including `capiro-dev-sync-congress`, `-sync-legiscan-bills`, `-sync-bea`, all ENABLED and
  targeting per-job families CDK does not know about.
- The stack owns **zero** `AWS::Events::Rule` resources, so CloudFormation would CREATE and
  fail `already exists` on the first collision — rolling back a stack that has been
  `UPDATE_ROLLBACK_COMPLETE` since 2026-07-25T04:47:08Z.
- That rollback deleted **76** `IngestionSchedules*` rules plus `ApiSyncJobsTaskDef`,
  `ApiSyncJobsLogs` and both its IAM roles, and the same failed update **attempted to delete
  and recreate the production Route53 A/AAAA records for `capiro.ai`, `app.capiro.ai` and
  `*.app.capiro.ai`**, which this stack owns.
- A "clean" deploy would **disable 8 currently-enabled** rules, **enable 2 deliberately
  disabled** ones (both `flush-tracker-digests-*`), and **create 36 new rules, 21 of them
  enabled**.

- **Sources:** `band-a-p50-schedule-enablement.md` F1 (P0) · corroborated by
  `band-b-infra-deploy.md` F-3/F-4 (MEDIUM) — the stack census (51 resources, 0 Events::Rule,
  live `capiro-dev-api` at rev **144** while CFN knows rev 17), and the separate finding that
  the stack is **no longer stuck** (`UPDATE_ROLLBACK_COMPLETE`, i.e. updatable), so the
  condition that made a destructive deploy impossible has been removed while both reasons it
  would be destructive remain
- **Affected:** `docs/runbooks/funding-opportunities-rollout.md` §34 ·
  `infra/cdk/DRIFT-FINDINGS.md` (status header records `UPDATE_ROLLBACK_FAILED`, stale) ·
  `infra/cdk/lib/constructs/scheduled-ingestion-jobs.ts` · `infra/cdk/lib/compute-stack.ts:1586`
  · `completion-matrix.md:27`
- **Class: (a) documentation** for the runbook and drift doc; **(c)** for whether and when to
  reconcile the stack at all.

### P0-9 · Part J cannot be followed at all for the seven jobs this program is about

All seven — `SyncTangoDibbs`, `ReconcileTangoDibbsFull`, `SyncTangoSbir`,
`ReconcileTangoSbirFull`, `ProcessTangoEvents`, `GenerateDibbsOpportunityCandidates`,
`GenerateSbirOpportunityCandidates` — exist in CDK with `enabled: false` and dispatch
correctly as verbs, and **none has a live EventBridge rule** (verified against the full
90-rule inventory). §32's per-job record and its Disable command both return
`ResourceNotFoundException`; §34's rollback step 2 is likewise inapplicable. Grepping §30–34
for EventBridge verbs returns only `list-targets-by-rule`, `describe-rule` and `disable-rule`
— no `put-rule`, no `put-targets`, no `enable-rule`. The only in-repo mechanism that creates
them is the `cdk deploy` P0-8 forbids.

- **Source:** `band-a-p50-schedule-enablement.md` F2 (P0)
- **Affected:** `docs/runbooks/funding-opportunities-rollout.md` §31, §32, §34 (and Part G
  §25's `put-rule ... --state DISABLED ...` fragment, which ends in a literal `...`)
- **Class: (a) documentation + (c)** — the sanctioned out-of-band mechanism is a decision
  nobody has recorded.

### P0-10 · The canary's first enabled capability is gated by a flag no code reads `[CONFIRMED ×2]`

`git grep "tango_shadow"` returns exactly two hits repo-wide: a migration comment and the
runbook line itself. Enabling `funding_opportunities_tango_shadow` changes nothing, anywhere
— so the "counts should change only for the dataset you just enabled" rule is evaluated
first against a no-op, §17.1's blanket claim that every tenant-visible capability fails
closed with a 404 is false for this row, and the step "succeeds" regardless.

- **Sources:** `band-a-p49-canary.md` F1 (P0) · `band-a-flag-guard.md` F-6 (LOW-MEDIUM) and
  its §2 flag table row 3
- **Affected:** `docs/runbooks/funding-opportunities-makegov-canary.md:79` ·
  `apps/api/prisma/migrations/20260821010000_tango_source_substrate/migration.sql:23`
- **Class: (a) documentation, or (b) code** — the two reviewers agree either wiring it or
  striking it is acceptable; which one is a decision.

### P0-11 · The canary's containment story for its first live-data step is fictitious

`sync-tango-entities --client=<id>` and `sync-tango-vehicles --client=<id>`: neither
`parseArgs` reads `--client`. Unknown arguments are dropped silently, so the operator gets a
summary that looks exactly like a successful scoped run. And the scope is not the internal
tenant — `sync-tango-entities.ts`'s own header says *"For every client with a UEI — across
ALL tenants"*, and `sync-tango-vehicles.ts` does `findMany({ where: { uei: { not: null } } })`
with no tenant predicate. This contradicts the runbook's own first line, **"Scope: the
internal tenant only"**. Add `--commit` and it is an unbounded cross-tenant provider walk
against a rate-limited account.

- **Source:** `band-a-p49-canary.md` F2 (P0)
- **Affected:** `apps/api/scripts/sync-tango-entities.ts:88-95` ·
  `sync-tango-vehicles.ts:87-94,271-284` ·
  `docs/runbooks/funding-opportunities-makegov-canary.md` §5, §6
- **Class: (b) code + (a) documentation.**

### P0-12 · The canary's flagship tripwire is inert, and its stated pass criterion is unachievable

§16's two quiet passes are billed as *"the acceptance step most likely to fail, and the one
worth the most."* Both commands are dry-run by default and §16 invokes neither with
`--commit`, so no baseline is persisted and pass 2 recomputes from byte-identical state,
reporting the *same* number as pass 1 — never zero unless pass 1 was zero. The criterion
*"The second pass must report no new alerts"* is one the code cannot satisfy. §16 also omits
the prerequisite rollout §29 states (run the notice sync FIRST), without which both passes
report 0, the box gets ticked, and nothing was tested. Rollout §29 already states the
correct form.

- **Source:** `band-a-p49-canary.md` F3 (P0)
- **Affected:** `docs/runbooks/funding-opportunities-makegov-canary.md` §16 ·
  `apps/api/scripts/process-funding-opportunity-lifecycle.ts:517-526` ·
  `process-tango-events.ts:558-562`
- **Class: (a) documentation.**

### P0-13 · The canary's exit-3 claim is wrong, so §14 cannot answer the question §4 says it answers

§4 tells the operator `webhook_write_apis` is unresolved and *"step 14 is where it finally
gets answered."* §14 step 3 says exit 3 means the tier refuses webhook **writes**. Reading
`reconcile-tango-webhook-alerts.ts`: a dry run returns `EXIT_DRIFT` (**5**) when there is
work, or `EXIT_OK` (0); exit **3** on a dry run is reachable from one place only, a tier
denial on the **READ** APIs — the opposite of what the operator is told. The write-tier
denial lives inside the commit loop and is unreachable without
`--commit --endpoint-id --confirm-callback`, an invocation §14 never gives. §14 also never
mentions exits 2, 4 or 5, and `resolveEndpoint` returns `EXIT_ENDPOINT_UNRESOLVED` (4) when
the account has more than one endpoint. Rollout §28 has the full five-row exit table; the
canary compressed it to one row and compressed it wrong.

- **Source:** `band-a-p49-canary.md` F4 (P0)
- **Affected:** `docs/runbooks/funding-opportunities-makegov-canary.md` §4, §14 ·
  `apps/api/scripts/reconcile-tango-webhook-alerts.ts:137-161,190-206,225-233,265-280`
- **Class: (a) documentation.**

---

## P1 — 27 findings

### P1-1 · Cross-capability exposure: DIBBS/SBIR/forecast rows are served ungated by the inbox API `[CONFIRMED ×3]`

The inbox service contains **zero flag logic of any kind** — a grep of the entire 1,362-line
file returns nothing. `list()`'s Prisma `where` carries a rail predicate only when the caller
supplies `?source=`; `parseSource()` accepts all five `INBOX_SOURCES` values with no flag
check. The route carries only the two coarse guards. Suppression happens in the browser.
`funding_opportunities_dibbs` returns **zero matches repo-wide, docs included** — there is no
constant to import at any layer; `funding_opportunities_sbir` exists in `apps/web` only. It
is a literal violation of D-07 (*"every tenant-visible capability is separately flag-gated
and dark by default"*), and `funding_opportunities_sbir` is the only tenant-visible
capability flag in the entire repository whose sole enforcement is client-side — every other
flag checked (`district_nexus_v2`, `hearing_watch`, `bill_360`, `tracker_v2`, every other FO
flag) has a real server-side guard.

**Latency and the aggravator.** Zero rows exist today, so the gap is undetectable from
outside. It becomes live — silently, with no flag flip and no deploy — the instant the first
candidate row is written. **Correcting the earlier read:** the producers select tenants by
`SELECT DISTINCT tenant_id FROM intel_feature_flag WHERE feature = funding_opportunities`,
i.e. the **master** flag, and the scheduled command passes no `--tenant`, so flipping that
schedule fans DIBBS rows out to **every master-flag tenant's clients** at once. No per-rail
canary is possible.

- **Sources:** `band-a-flag-guard.md` F-1/F-1a/F-2/F-4 (HIGH/HIGH/MEDIUM) ·
  `flag-ui-reconciliation.md` §2/§3 · `band-a-p49-canary.md` F8 (P1, confirming the flag
  table has no DIBBS or SBIR row)
- **Affected:** `apps/api/src/funding-opportunities/funding-opportunity-inbox.service.ts:76,774-975,998-1002`
  · `funding-opportunities.controller.ts:491,524-525` ·
  `apps/web/src/pages/intelligence/opportunities/FundingOpportunityInbox.tsx:60-77,266-277` ·
  `apps/web/.../funding-opportunities-api.ts:419` ·
  `apps/api/scripts/generate-dibbs-opportunity-candidates.ts:258-269` (SBIR twin at `:257-268`)
  · `infra/cdk/lib/ingestion-schedule.ts:543-550`
- **Class: (b) code + (c)** — whether to introduce `funding_opportunities_dibbs` or record a
  reviewed, explicit exception to D-07 naming DIBBS is a decision, not an implementation
  detail. Both reviewers say what must not persist is an invariant the code silently does
  not meet.

### P1-2 · No negative test anywhere that a tenant lacking a rail flag is denied that rail's data

175 tests pass across `funding-opportunities.boundaries.spec.ts` and
`funding-opportunity-inbox.spec.ts`, and none of them is this one. Every rail test asserts
rows **are** returned; none asserts any row is **withheld** for a tenant lacking a
capability, because no such behaviour exists to test. The §4.6 discipline was applied to
*tenant* scope (where it holds, verifiably) and never extended to *capability* scope. The
existing web tests do assert the withheld behaviour — of the browser, which is the layer that
cannot enforce it.

- **Source:** `band-a-flag-guard.md` F-3 (HIGH) — "the sharpest one in this review"
- **Affected:** `apps/api/src/funding-opportunities/funding-opportunities.boundaries.spec.ts:114-179`
  · `funding-opportunity-inbox.spec.ts` throughout
- **Class: (b) code.**

### P1-3 · P08's idempotency guarantee is false under concurrency — reproduced twice against real Postgres

The guard is a `findFirst`-then-`create` with no lock and no unique constraint, and
`withTenant` passes no `isolationLevel`, so it runs at READ COMMITTED. Reproduced with real
`@prisma/client` 5.22.0 against a 263-migration replay: two concurrent invocations produced
**two** `engagement_tasks` rows for one derived idempotency key; eight genuinely parallel
invocations **with no injected delay** produced duplicates too. Postgres then refused to
build a unique index on `(tenant_id, source_type, source_id)` because of those duplicates
(`23505`). The service docblock and the P08 matrix row both assert the opposite as an
accepted guarantee.

- **Source:** `band-a-p07-p08.md` §3 / F-1 (High) — one of the two rejection grounds
- **Affected:** `apps/api/src/funding-opportunities/funding-opportunity-actions.service.ts`
  (`act()`) · `engagement_tasks` (no unique index on `(tenant_id, source_type, source_id)` in
  any migration or in `schema.prisma`)
- **Note the reviewer records:** duplicates may already exist in production, so an index
  build needs checking first. Mitigated in the browser by `confirmLoading`, but the guarantee
  is stated as a server-side property covering retried and replayed requests.
- **Class: (b) code.**

### P1-4 · P41's only live floor-clearing signal is not scoped to the item being scored — every open DIBBS item becomes a `pursue`

`hasPriorCageAward` has **no item predicate at all** — no NSN, no part number, no
nomenclature — and the boolean is cached per client and reused for every solicitation on
every page. The scorer's own user-facing prose for that branch reads *"A prior DLA award to
this client's own CAGE code on this kind of item."* Measured against the repository's own
real capture fixture: client with CAGE `81873` (a real awardee, one prior award for a
shipping cover) produced a floor-clearing `pursue` row for **10 of 10** open items —
including fibrous rope, machine bolts and multi-leg slings recommended to an
actuation-systems manufacturer. Row count is bounded only by corpus size × clients with a
CAGE; the real DIBBS bid board carries tens of thousands of open RFQs.

- **Source:** `band-b-matching-scoring.md` B-1 (P1) — proven by executing the real producer
  against real Postgres seeded from `__fixtures__/real-captures/`
- **Affected:** `apps/api/scripts/generate-dibbs-opportunity-candidates.ts:284-294,389-401,445,458`
  · `apps/api/src/funding-opportunities/dibbs-relevance.ts:127` (field comment, item-agnostic)
  vs `:276-289` (branch prose, item-scoped)
- **Class: (b) code + (c)** — the field comment and the branch prose describe two different
  signals; which one the product means is a decision.

### P1-5 · P43 can never clear the suggestion floor with real data — the mechanical explanation for zero SBIR rows

The real SBIR source publishes agency as the acronym `DOD`; `federal_award` stores
USAspending-shaped names (`Department of Defense`, `DEPT OF THE NAVY`). `normAgency`
normalises but does not expand acronyms, by explicit design, so `priorAgencyHistory` — the
only live path to `clearsSuggestionFloor: true` — is permanently `false`. Measured: a
realistic UEI-backed client with genuine prior DoD contract history produced **0** rows; an
otherwise identical client whose award row literally reads `'DOD'` produced **5**. The
producer spec's fixtures all give the topic a full agency *name*, so the test built to guard
this comparison uses the one input shape that cannot expose the problem.

- **Source:** `band-b-matching-scoring.md` B-2 (P1)
- **Affected:** `apps/api/scripts/generate-sbir-opportunity-candidates.ts:432-453` ·
  `apps/api/src/funding-opportunities/sam-opportunity-relevance.ts:241-248` ·
  `generate-sbir-opportunity-candidates.spec.ts` (~line 363)
- **This should be treated as confirmed, not as a hypothesis awaiting live data** — it holds
  independently of the Tango rate-limit blockage and of the schedules shipping disabled. Its
  counterpart prediction: P1-4 means DIBBS will produce not zero rows but a fan-out across
  the entire open corpus.
- **Class: (b) code.**

### P1-6 · P46 rejects a signature form the provider's own verifier accepts → 401 → never retried

The SDK's `parseSignatureHeader` documents acceptance of *"both the canonical `sha256=<hex>`
form and a bare hex string for forward/legacy compatibility."* P46 hard-requires the prefix
and classifies bare hex as `malformed_signature` → 401 → *"stop retrying."* Executed, same
bytes, same secret: SDK `verifySignature` → `true` for both; P46 → `{"ok":false,
"rejection":"malformed_signature"}` for the legacy form. A 401 reads in the logs as an
attack, not a contract mismatch, so it would be triaged in exactly the wrong direction.

- **Source:** `band-a-p46-webhooks.md` F3 (P1) — registration-blocking
- **Affected:** `apps/api/src/webhooks/tango-webhook.service.ts` (`verifyTangoSignature`,
  `SIGNATURE_PREFIX`)
- **Class: (b) code.**

### P1-7 · The mitigation chosen for P46's "unverified header" risk is strictly weaker than a free one, and the recorded risk is factually wrong

Both `HANDOFF-P46-P51.md` §5 and `diag-tango-webhook-contract.ts`'s header state the
signature header *"comes from the plan document"* and is unconfirmed. The provider's SDK — an
already-pinned dependency — exports `SIGNATURE_HEADER = "X-Tango-Signature"` and
`SIGNATURE_PREFIX = "sha256="` directly, plus `verifySignature`/`generateSignature`. Executed:
`SIGNATURE_HEADER.toLowerCase() === TANGO_SIGNATURE_HEADER.toLowerCase()` → `true`. Nothing
in `apps/api` imports any of those SDK symbols, so the correspondence is real but **unpinned**
— an SDK bump breaks the receiver silently with no failing test. The chosen mitigation defers
to a live network probe requiring a credential nobody has.

- **Source:** `band-a-p46-webhooks.md` F4 (P1) — and the review's own headline conclusion:
  *"before declaring an assumption unverifiable, read the vendor package you already depend on"*
- **Affected:** `docs/plans/funding-opportunities-makegov-v1/HANDOFF-P46-P51.md` §5 ·
  `apps/api/scripts/diag-tango-webhook-contract.ts` (header comment)
- **Class: (a) documentation + (b) code** (an offline parity assertion).

### P1-8 · Rollout §30b is stale in a way that misdirects

The claim is verbatim correct: `capiro-dev-api-admin-migrate:9` does run
`migrate resolve --rolled-back … || true` unconditionally. But revision 9 has not been the
latest for five days — the line was removed at revision **10** (2026-08-08T15:06:02Z) and is
absent from every revision since, including the current latest ACTIVE, **revision 14**
(2026-08-09T03:54:54Z). §30b's remediation instruction reads as outstanding work; an operator
acting on it registers a redundant 15th revision, and is invited to believe the family is
healthy — which P1-9 shows it is not.

- **Source:** `band-a-p50-schedule-enablement.md` F3 (P1), live-verified
- **Affected:** `docs/runbooks/funding-opportunities-rollout.md` §30b
- **Class: (a) documentation.**

### P1-9 · LIVE BREAKAGE — `capiro-dev-api-admin-migrate:13` and `:14` build a `DATABASE_URL` with the literal password `***`

Not in any runbook, not in any prior investigation. Revisions 13 and 14 compute
`ENCODED_PASSWORD` and then do not use it; the exported URL contains the literal
three-character string `***` where the password belongs. Established without printing any
secret: occurrence counts and command lengths (rev 12 = 330 chars with
`${DB_USER}:${ENCODED_PASSWORD}@`; revs 13/14 = 314 chars with `:***@`; the 16-char delta is
exactly `${ENCODED_PASSWORD}` minus `***`). Revision 14's secret bundle is byte-identical to
12's and contains no `DATABASE_URL` secret to fall back on. `scripts/deploy-dev.sh:49`
resolves this family by name and takes the latest ACTIVE revision.

**Consequence: the canonical migration path for `capiro-dev` is broken right now** and will
fail Aurora authentication on the next run. The obvious workaround under time pressure —
switching `MIGRATE_TD` to `capiro-dev-api-migrate` — is precisely the 16-job de facto deploy
§30 exists to prevent. The `***` shape suggests a task-definition JSON was hand-assembled
from masked output and re-registered, so revision 13's provenance is worth checking for the
same pattern elsewhere.

- **Source:** `band-a-p50-schedule-enablement.md` F4 (P1) — new, found while verifying P1-8
- **Affected:** ECS task-definition family `capiro-dev-api-admin-migrate`, revisions 13 and
  14 · `scripts/deploy-dev.sh:49` · `docs/runbooks/funding-opportunities-rollout.md` §30a
- **Class: (b) infrastructure** — this is the most time-sensitive item in the queue.

### P1-10 · The enablement-order table names jobs that cannot be enabled, and four phases have verbs with no schedule declaration at all `[CONFIRMED ×2]`

Of §31's seven rows: rows **3** (`sync-tango-opportunity-shadow`) and **4**
(`sync-tango-opportunity-notices`) have no live rule **and no CDK declaration**, so not even
the forbidden `cdk deploy` would create them — runnable by hand, schedulable by nobody. Row
**7** (`process-tango-events`) has no rule. The table's own bolded cell says row 4 feeds *"the
event processor"*, making row 7 unreachable; an operator working top-to-bottom stalls at row
3. From the other side: `entrypoint-dispatcher.inc` exposes verbs for
`sync-tango-opportunity-shadow` (`:677`), `-notices` (`:692`), `-attachments` (`:702`) and
`-text` (`:710`) — **none has an EventBridge declaration, not even one marked
`enabled: false`**, unlike every other FO job in that file. All four phases (P27–P30) are
marked `deployed` in the matrix. `ProcessTangoEvents`'s own comment orders it after a job
that has no schedule, so the event drain will report success indefinitely against a table
nothing scheduled populates.

- **Sources:** `band-a-p50-schedule-enablement.md` F6 (P1) · `band-b-ingestion-adapters.md`
  B-7 (P2)
- **Affected:** `docs/runbooks/funding-opportunities-rollout.md` §31 ·
  `infra/cdk/lib/ingestion-schedule.ts:724` · `apps/api/scripts/entrypoint-dispatcher.inc:677,692,702,710`
- **Class: (a) documentation + (b) code/infra.**

### P1-11 · Aurora max-ACU drift that `cdk diff` structurally cannot see

Three-way disagreement: `infra/cdk/lib/config.ts:237` says `4`; the deployed
`Capiro-dev-Data` template says `4`; the **live cluster is `16.0`**. The cluster was scaled
out-of-band after 2026-07-25, so any CFN update of `Capiro-dev-Data` reverts 16 → 4 — a 4×
reduction in maximum database capacity on the cluster serving `app.capiro.ai`. Because the
deployed template already says `4`, **`cdk diff` reports no difference** — and
`infra/cdk/DRIFT-FINDINGS.md` Step C instructs the operator to run exactly that check and
concludes *"A future diff should no longer shrink Aurora."* Both sentences are now false, and
the prescribed safety check is the thing that will fail to catch it. `auroraMinAcu` (0.5) and
`auroraBackupRetentionDays` (35) still match live.

- **Source:** `band-b-infra-deploy.md` F-1 (HIGH) — one of the two rejection grounds
- **Affected:** `infra/cdk/lib/config.ts:237` · `infra/cdk/lib/data-stack.ts:124` ·
  `infra/cdk/DRIFT-FINDINGS.md` Step C · live cluster
  `capiro-dev-data-auroracluster23d869c0-ltmz40k47ewv`
- **Class: (c) decision** (which number is correct) **+ (a) documentation** (Step C's claim).

### P1-12 · D-69's guard-list remediation was incomplete — 6 of 27 migrations still uncovered `[CONFIRMED ×2 as a class]`

The CI "was it applied" assertion list contains 21 names; this program has added 27
migrations. Six are absent, **two of which create tenant-scoped tables with RLS policies**
(`client_profile_enrichment_candidate`, `client_relevant_vehicle`). Attribution is not
inferred — the first four name their own phase in line 1 of the SQL. The sharpest detail:
the two subaward migrations are the *exact two* D-69's own experiment used as its reference
point and quoted by name in the same session the list was edited. Same shape as D-69's own
finding, one layer out: a fix applied to the noticed instance rather than to the class.

- **Source:** `band-b-infra-deploy.md` F-2 (HIGH) — the other rejection ground · same class
  as `band-b-ingestion-adapters.md` B-10 (the dispatcher's usage string, P3-8)
- **Affected:** `.github/workflows/funding-opportunities-ci.yml` · missing:
  `20260822010000_client_tango_entity_sync_status`,
  `20260823010000_client_profile_enrichment_candidates`,
  `20260824010000_client_relevant_vehicle`, `20260825010000_tango_procurement_forecasts`,
  `20261001010000_tango_subaward_intelligence`,
  `20261001011000_tango_subaward_reobservation_freshness`
- **Class: (b) code.**

### P1-13 · Rail staleness is structurally unrepresentable for 3 of the 5 rails, and the empty state blames the filter

`readFreshness()` lists two rails; `OpportunitySourceFreshness.source` is typed
`OpportunitySource` = `'grants_gov' | 'sam_gov'`, so `agency_forecast`, `dibbs` and
`sbir_sttr` are excluded **by the type** — `neverSynced`, `lastRunStatus`, `lastFailureAt`
and `hoursSinceLastSuccess` cannot be expressed for them at all. Composed with an
`InboxEmptyState` source branch that is unchanged P11-era copy (*"The other rail is not
counted here"* — singular, when there are now five; never names the filtered rail; fires
before the `totalHere === 0` branch), a rail that has **never been ingested** renders as
*there is nothing on the DLA bid board for you* — a claim about the data, when the truth is a
claim about Capiro's sync. This is the UI half of the live symptom that started this
investigation.

- **Source:** `band-b-ui-triage.md` B-1 (P1) — the band's primary rejection ground
- **Affected:** `apps/api/src/funding-opportunities/funding-opportunities.service.ts:2071-2078`
  · `funding-opportunities.types.ts:221-222` ·
  `apps/web/src/pages/intelligence/opportunities/FundingOpportunityInbox.tsx:925-933,946,950-952`
- **Also in the same acceptance line:** "profile data is thin" has no inbox branch at all —
  `InboxResponse` carries none of `emptyReason`/`emptyExplanation`/`missingProfileFields`,
  which the catalog response does carry, so the *default* surface cannot say what the Explore
  view can.
- **Class: (b) code.**

### P1-14 · Both new producers reproduce the `geocode-facilities` bug their own helper's docblock exists to prevent

`embed-watermark.ts:46-58` documents why `errorMessage` exists, naming the incident by name:
a job catching per-row failures and returning `errors: N` lands as `success_with_errors` with
a null message — which is how `geocode-facilities` failed the same row on nine consecutive
nights with no way to see the cause. Both new producers catch per-row, increment
`counts.errors`, `console.warn` to stderr, and never set `errorMessage` — `GenerateResult`
does not carry the field. Verified as a deviation rather than a universal gap:
`errorMessage` is set by `geocode-facilities.ts:124` and eight other scripts.

- **Source:** `band-b-alerting-observability.md` B-5 (P1)
- **Affected:** `apps/api/scripts/generate-dibbs-opportunity-candidates.ts` ·
  `generate-sbir-opportunity-candidates.ts` · `apps/api/src/ingestion/embed-watermark.ts:46-58`
- **Class: (b) code.**

### P1-15 · DIBBS/SBIR retry 429 only — the `transient` half of D-65's own fix was never applied

`isRateLimited` is `status === 429` and nothing else. The shared mechanism's `RETRYABLE` set
is `{rate_limit, transient}`, and `classifyStatus` maps all 5xx, 408, and a null status (a
network failure or timeout) to `transient`. Both REST clients raise status `0` for an
`AbortError` timeout — not 429, so not retried; nor is a 502, 503 or 504. `walkEndpoint`'s
catch special-cases only `isRateLimited`; anything else propagates uncaught through the
endpoint loop and **aborts the run**. One TCP reset on page 400 of the RFQ walk discards the
RFP and award walks entirely — exactly the consequence D-65 wrote up and believed it had
closed. The reimplementation did not merely duplicate the shared mechanism, it duplicated a
*narrower* version of it.

- **Source:** `band-b-ingestion-adapters.md` B-2 (P1)
- **Affected:** `apps/api/scripts/sync-tango-dibbs.ts:296,383` · `sync-tango-sbir.ts:316` ·
  `apps/api/src/external/tango/tango-dibbs.client.ts:75,289-292` ·
  `tango-sbir.client.ts:102,321-324` · `tango.errors.ts:50-53,233-247`
- **Class: (b) code, or (a)** if the divergence is recorded with a reason.

### P1-16 · The subaward adapter reproduces D-65's defect verbatim, written after D-65

No rate-limit handling of any kind — a grep for
`429|isRateLimited|retry|sleep|backoff|throttle|circuit|breaker|ceiling` across
`sync-tango-subawards.ts` returns nothing. `Retry-After` is not merely unused but
unrecoverable: `TangoSubawardHttpError` carries no `rate` field, unlike its DIBBS and SBIR
siblings which were given one *because of* D-65. It cannot run in the deployed container (no
dispatcher verb, no EventBridge declaration), and its two tables exist only in raw SQL,
absent from `schema.prisma`. Ironically it is the only later-phase table carrying the full
D-02 provenance set — the adapter that got provenance right got rate limiting worst.

- **Source:** `band-b-ingestion-adapters.md` B-4 (P1) — adjacent to scope, flagged rather
  than silently included or dropped
- **Affected:** `apps/api/scripts/sync-tango-subawards.ts:283-330` ·
  `apps/api/src/external/tango/tango-subaward.client.ts:36-44,68` ·
  `apps/api/prisma/migrations/20261001010000_tango_subaward_intelligence`
- **Class: (b) code + (c)** — if the adapter is dormant, deciding to mark it dormant is the
  cheaper resolution.

### P1-17 · P51's own row repeats a claim the same document formally retracted five days earlier

`completion-matrix.md:86`, P51's **Live acceptance** column, still states *"P40-P43 blocked
on the provider."* `completion-matrix.md:221`, 135 lines later, states *"P40–P43 | NOT
blocked — this row previously said otherwise and was wrong (D-62)."* D-62's own opening names
*"the project closeout"* as one of the five places to correct — **P51's row IS the project
closeout, and it was not corrected.** It is now also contradicted by outcomes: P40 merged
with `dibbs: supported`, P41–P43 code-complete, D-71 contract-validated both rails against a
real capture, ~14,769 real DIBBS rows in `capiro-dev` as of 2026-08-12.

- **Source:** `band-a-p51-ga-closeout.md` F-01 (HIGH) — "the highest-severity finding because
  it sits inside the GA phase's own acceptance evidence"
- **Affected:** `completion-matrix.md:86` (Live acceptance)
- **Class: (a) documentation — pure, no risk.**

### P1-18 · P41's row asserts "no live DIBBS response has ever been observed", contradicted three ways, and carries no D-79 note

`completion-matrix.md:76` still says *"Still no live DIBBS response has ever been observed."*
Contradicted at the same SHA by P40's own row four lines above (*contents
CONTRACT-VALIDATED (D-71)*), by D-71 itself (now pinned as fixtures in
`tango-dibbs.mapper.spec.ts`), and by `HANDOFF-2026-08-11-dibbs-sbir-ingestion-resume.md:14-16`
(13,625 rfq rows, 1,144 rfp rows at 100% `complete: true`, verified by direct DB query
2026-08-12). The row also still says *"parts 1–2 merged; part 3 in PR #873"*, and carries no
D-79 note at all even though `generate-dibbs-opportunity-candidates.ts` shipped explicitly
"for P41". **The asymmetry is the tell:** the D-79 commit changed exactly one line of the
matrix — P43's row — leaving P41's, describing the other half of the same change, untouched.

- **Source:** `band-a-p51-ga-closeout.md` F-02 (HIGH); the staleness of the same underlying
  claim independently confirmed by `band-a-p49-canary.md` F8
- **Affected:** `completion-matrix.md:76` (Status, Live acceptance, Deploy columns)
- **Class: (a) documentation — pure, no risk.**

### P1-19 · The closeout phase-range table says P41 and P42 are "unbuilt"

`completion-matrix.md:221` reads *"P41 is unblocked but unbuilt; P42 is buildable but
unbuilt, its entitlement `not_attempted` rather than refused; P43 depends on P42."*
Contradicted by the phase rows in the same file (`:76` P41 built, `:77` P42 code-complete,
`:78` P43 "every phase that is CODE, is complete"), and P42's entitlement is no longer
`not_attempted` since D-71's live capture. **This is the second consecutive time this exact
table has been wrong about P40–P43** — it said "blocked", was corrected by D-62 on
2026-08-08, and its replacement text was stale within 24 hours. The closeout summary is what a
reader consults to answer "is the program done."

- **Source:** `band-a-p51-ga-closeout.md` F-03 (HIGH)
- **Affected:** `completion-matrix.md:221`
- **Class: (a) documentation — pure, no risk.**

### P1-20 · "Design-partner acceptance" is a GA gate with no definition anywhere in the program

The string "design partner" / "design-partner" appears in this program's entire document
corpus **exactly once** — `completion-matrix.md:86`, P51's Deploy cell. There is no named
client, no acceptance artifact, no named authority, and no definition of what "accepted"
means; `docs/product/funding-opportunities.md`, P51's own named deliverable, contains zero
occurrences of "GA", "general availability", "acceptance" or "criteri*". Other Capiro
programs do name theirs (the state-legislation plan resolves its D4 as "Ballard Partners"
with an explicit demo gate). **As written the criterion is unfalsifiable in both directions:
no evidence could establish it was met, and none could establish it was not.** It is also
the one gate that disappears from both summary tables — `:86` names three conditions, `:240`
and `:320` name two (recorded separately as F-12).

- **Source:** `band-a-p51-ga-closeout.md` F-08 (HIGH) + F-12 (LOW)
- **Affected:** `completion-matrix.md:86`, `:240`, `:320` ·
  `docs/product/funding-opportunities.md`
- **Class: (c) HUMAN / BUSINESS DECISION.** Either it is a real gate needing a named partner,
  artifact and authority, or it is aspirational language that should not sit in a Deploy cell
  alongside two blockers that do have owners. This is the flagship (c) in this queue.

### P1-21 · No handoff exists for D-79 / PR #943, and the brief it was built from still reads as outstanding work

`git show --stat aebec3b32 -- docs/` returns exactly two modified files: one line of
`completion-matrix.md` and 100 lines of `decision-log.md`. No handoff was added or updated
for a change spanning 22 files, +2,680/−4,826, two new producer scripts, 27 lines of new CDK
schedule declarations and the deletion of a 9-file web directory. **Every other merged phase
in this program has one** — seven are committed in this directory, and the convention is
stated and defended twice (*"A program whose institutional memory lives on one laptop has no
institutional memory"*). Compounding it, `HANDOFF-2026-08-11-dibbs-sbir-matching-producer.md`
still opens *"the scoring logic is built and tested; **nothing calls it**"* — false as of
D-79, and not updated by it, even though the program has an established convention for
exactly this (`HANDOFF-P40-part3.md` was updated in place once its work landed). A reader
arriving at this directory today would conclude the producers do not exist.

- **Source:** `band-a-p51-ga-closeout.md` F-09 (HIGH) + F-06 (MEDIUM)
- **Affected:** this directory (no D-79 handoff) ·
  `HANDOFF-2026-08-11-dibbs-sbir-matching-producer.md:1-20,23`
- **Class: (a) documentation.**

### P1-22 · The matrix records no GA ingestion bar at all, and every surrounding document frames the goal as full-catalog completeness

The correctness-not-completeness bar (≥1 dataset per rail at ~100%, the zero-rows defect
closed, real candidates verified end-to-end for ≥1 client) appears **nowhere** at
`d800dcfde5`. The matrix is not merely silent — the silence reads as the stricter bar,
because every artifact around it does: the ingestion handoff is titled *"full-catalog
ingestion"* and tracks Rows/Target/% against 75,339 rfqs / 185,518 awards / 22,480 topics;
the matching-producer brief makes 100% the reference point; D-79 cites incompleteness as the
reason to defer. **Same data, opposite conclusion, entirely because of which bar the document
states** — under the correctness bar `tango_dibbs_solicitation` is at ~100% `complete: true`
and `tango_sbir_solicitation` at ~72% `complete: true`, one confirmed complete dataset per
rail; under the full-catalog framing the same facts read "18% / 0% / 0% / 72%" and look like
a program nowhere near GA. Two further consequences: the zero-rows condition is tracked
nowhere as a GA criterion, and "real candidates verified end-to-end for ≥1 client" has no
home either — though the canary runbook's §15 and Acceptance checklist are already
correctness-shaped, i.e. **already closer to the real bar than the completion matrix is**.

- **Source:** `band-a-p51-ga-closeout.md` F-10 (HIGH)
- **Affected:** `completion-matrix.md` (no such section), `:241`, `:321` ·
  `HANDOFF-2026-08-11-dibbs-sbir-ingestion-resume.md:1,14-19` ·
  `HANDOFF-2026-08-11-dibbs-sbir-matching-producer.md:23` · `decision-log.md:2794` (D-79)
- **Class: (c) decision** on what the GA bar is, **then (a) documentation** to record it.

### P1-23 · The canary's rollback returns to the wrong digests, and the pre-canary state is never recorded

§3 says to record the digests "resolved from the merge SHA" and that *"they are what a
rollback returns to"* — but those are the **canary's own** digests, so §17.2 points at the
build being backed out of. Nothing in the runbook captures the pre-canary task-definition
revision or running digest. Rollout §26 does this correctly and by the mechanism ECS actually
offers (`--task-definition capiro-dev-api:<previous-rev>`); note also that "roll to a digest"
is not an ECS operation — you roll to a *revision*, so §17 gives an operator a noun they
cannot act on.

- **Source:** `band-a-p49-canary.md` F5 (P1)
- **Affected:** `docs/runbooks/funding-opportunities-makegov-canary.md` §3, §17 ·
  `completion-matrix.md:84` (P49's Rollback cell repeats the same "prior immutable digests
  recorded in canary step 3")
- **Class: (a) documentation.**

### P1-24 · The canary has no remediation for the client-visible alerts it produces

§17.3 offers *"Additive data remains"* as reassurance, but the canary deliberately writes
`clio_proactive_alert` and `tango_event_alert` rows. Turning flags off and rolling code back
does not withdraw an alert a user already received. Rollout §26 covers exactly this, with the
dedupe reasoning and the query; §17 does not — even though §14 and §16 are the two steps most
likely to generate them, and `tango-event-processor.service.ts:286-294` warns that a first
drain over an existing history could "page a whole tenant."

- **Source:** `band-a-p49-canary.md` F6 (P1)
- **Affected:** `docs/runbooks/funding-opportunities-makegov-canary.md` §17
- **Class: (a) documentation.**

### P1-25 · The canary's flag table does not match the codebase, in both directions

In the table but read by nothing: `funding_opportunities_tango_shadow` (P0-10). Defined in
code, never mentioned by the runbook, and **required by the runbook's own §15**: the master
`funding_opportunities` (class-level guard on the whole controller — nothing in §15 is
reachable without it), `funding_opportunities_client_inbox` (§15's first acceptance item),
`funding_opportunities_pipeline_v2` (§15's "One full workflow. Pursue → … Monitor … Pass"),
and `funding_opportunities_sbir`. So the human browser-acceptance section depends on at least
three flags §5–13 never turns on, and the "one flag at a time" discipline silently breaks at
the section where a person is actually looking at the product.

- **Source:** `band-a-p49-canary.md` F7 (P1); the complete 17-flag inventory it should be
  reconciled against is `band-a-flag-guard.md` §2
- **Affected:** `docs/runbooks/funding-opportunities-makegov-canary.md` §5–13, §15 ·
  `apps/api/src/funding-opportunities/funding-opportunities-flag.guard.ts:6,16,94`
- **Class: (a) documentation.**

### P1-26 · The canary has no DIBBS/SBIR section, and its stated reason is stale

`funding_opportunities_dibbs` has zero matches repo-wide; `funding_opportunities_sbir` is
web-only; **neither appears anywhere in the canary runbook** and the §5–13 table has no row
for either. §4's justification — *"P40–P43 are blocked on the provider… there is nothing to
entitle"* — is quoted essentially verbatim from `diag-tango-capabilities.ts`'s header: true
about the SDK's method surface, stale about what is shippable. At this SHA all four scripts
exist and are wired as container verbs, both migrations are applied, and
`funding-opportunities-entrypoint.spec.ts` describes the two producers as *"the ONLY path to
visibility for DIBBS/SBIR."* Urgency rather than cosmetics: `sync-tango-dibbs.ts`'s own header
says **"NOTHING HERE HAS EVER SEEN A REAL RESPONSE"** and demands a separately authorized live
contract-validation run — which is exactly what a canary is for, and P49 has no step for it.
Also wrong: *"Skip step 13 for those two datasets"* — step 13 is risk/budget context, a stale
cross-reference to a renumbered step.

- **Source:** `band-a-p49-canary.md` F8 (P1)
- **Affected:** `docs/runbooks/funding-opportunities-makegov-canary.md` §4, §5–13
- **Class: (a) documentation + (c)** — whether the first live DIBBS/SBIR contract-validation
  run belongs in the canary is a decision.

### P1-27 · The canary's §14 step 2 points at a CDK deploy the program forbids, with no warning

*"Set `externalSecretArns.tangoWebhookSecret` and roll API serve."* Getting that value onto a
live task definition normally means deploying `Capiro-dev-Compute`, which the rollout runbook
forbids in three separate places including *"under any circumstances, including rollback."*
§14 says "roll API serve" with no mechanism, no cross-reference and no warning, on the cluster
that serves `app.capiro.ai` — the single instruction in the document most likely to cause an
operator to do the forbidden thing, with user-facing blast radius. Rollout §27 also carries a
detail §14 drops: setting the ARN before the secret exists makes every new serve task fail to
start.

- **Source:** `band-a-p49-canary.md` F9 (P1); blast radius quantified by P0-8
- **Affected:** `docs/runbooks/funding-opportunities-makegov-canary.md` §14 ·
  `infra/cdk/lib/compute-stack.ts:306-311,538-539`
- **Class: (a) documentation.**

---

## P2 — 39 findings

| # | Finding | Source(s) | Affected | Class |
|---|---|---|---|---|
| P2-1 | `diag-tango-webhook-contract`'s `KNOWN_ID_KEYS` does not match the receiver's (`external_id` accepted by the diagnostic, not by `readEnvelope`), the envelope-shape check is hardcoded `agrees: true` so it can never fail, and it checks the header **name** only | p46 F5 | `apps/api/scripts/diag-tango-webhook-contract.ts` | (b) |
| P2-2 | No test exercises the real HTTP path or the raw-parser mount; if the mount is removed, reordered after `json()`, or its path drifts, every delivery is answered 400 `missing_body` with a fully green suite. The SDK ships the exact offline supertest recipe | p46 F6 | `tango-webhook.spec.ts`, `configure-api-http-app.spec.ts` | (b) |
| P2-3 | The webhook tests re-implement the signing algorithm they are testing, proving internal consistency rather than interop; using the SDK's `generateSignature` would have surfaced P1-6 immediately | p46 F7 | `apps/api/src/webhooks/tango-webhook.spec.ts` | (b) |
| P2-4 | The P46 matrix live column (*"Applied to capiro-dev 2026-08-08"*) is the **migration**; the receiver has never been live and no real provider payload has ever reached the code. Verified four independent ways | p46 F10 | `completion-matrix.md:81` | (a) |
| P2-5 | §30's own verification sweep cannot reproduce §30's own numbers: `*api-migrate*` also matches `api-admin-migrate`, `Targets[0]` ignores targets 2–5, and `State` is never read so "16 enabled" is underivable | p50 F7 | rollout §30 | (a) |
| P2-6 | `capiro-dev-api-sync-jobs` is at revision **12**, not 1 (revs 2–5 INACTIVE, deregistered by the 2026-07-25 rollback), and **three ENABLED rules already pin it at `:1`** — 11 revisions stale, the exact failure mode §30c warns about, already live | p50 F8 | rollout §30c | (a) |
| P2-7 | Part G §25 and Part J §31 give two different enablement orders, uncross-referenced; §25 stops before the event drain, the one job that turns provider events into client-visible alerts | p50 F9 | rollout §25, §31 | (a) |
| P2-8 | "Two clean manual commit runs per job" — the strongest requirement in Part J — has no `run-task` invocation form anywhere; the container name differs by family (`api` vs `api-sync-jobs`) and getting it wrong produces a task that starts, runs the default command and exits 0 | p50 F10 | rollout §32 | (a) |
| P2-9 | No `aws ecs run-task` invocation form appears anywhere in the canary; every command is a bare container verb and the runbook cross-references the rollout runbook exactly once. An operator handed only this document cannot execute step 0 | p49 F10 | canary runbook, all sections | (a) |
| P2-10 | The canary never gives a flag enable/disable command, and the one obvious script is the wrong one: `set-tenant-flag.ts` writes `tenants.settings_jsonb.clioFeatureFlags` while the FO guards read the `intel_feature_flag` table — different stores | p49 F11 | canary §5–13, §17; `apps/api/scripts/set-tenant-flag.ts`; `funding-opportunities-flag.guard.ts:139-152` | (a) + (b) |
| P2-11 | Three of the nine capability steps write to tables the canary's only instrument cannot see (vehicles, attachments, and any DIBBS/SBIR step), so baseline and post-step output are identical whether the sync worked perfectly or did nothing | p49 F12 | `apps/api/scripts/diag-funding-opportunities-makegov.ts:191-196,210-218` | (b) |
| P2-12 | `diag-tango-capabilities` is presented under a `# read-only` comment; it makes live HTTP calls against the real MakeGov account, requires `TANGO_API_KEY`, and its own header records the measured limit (25 req / ~31s). Spending the window here silently can invalidate the rest of the session | p49 F13 | canary §0, §4 | (a) |
| P2-13 | Purpose-built diagnostics the canary never runs: `diag-tango-opportunity-parity` (step 8 is literally titled "Opportunity parity and history") and `diag-tango-webhook-contract` (§14 is the webhook section) | p49 F14 | canary §8, §14 | (a) |
| P2-14 | `alertsWritten` is emitted by only one of the two commands §16 names — `process-funding-opportunity-lifecycle` prints `alerts=<n> would create` and has no field of that name | p49 F15 | canary §16 | (a) |
| P2-15 | §16 omits `suppressions` entirely, so "quiet" is not distinguishable from "swallowed"; rollout §29 documents an 8-row reason table and warns that a nonzero `volume_capped` on a first drain is expected (D-58) | p49 F16 | canary §16 | (a) |
| P2-16 | Step 13's command column (*"`sync` verbs, if entitled"*) is not a command — two flags, no verb names, an unexplained conditional, against every other row naming a concrete verb | p49 F17 | canary §13 | (a) |
| P2-17 | Two different capability-text semantics under one signal name: forecast uses `containsWholeToken`, DIBBS and SBIR use a bare `includes()` duplicated byte-for-byte in both producers. Measured: `rope` matches `EUROPEAN`, `plate` matches `TEMPLATE`, `air` matches `AIRPORT` — the exact false positives `containsWholeToken`'s docblock exists to prevent. The DIBBS corpus literally contains `ROPE,FIBROUS` | matching B-3 | `forecast-opportunity-read.service.ts:222`; `generate-dibbs-opportunity-candidates.ts:181`; `generate-sbir-opportunity-candidates.ts:181` | (b) |
| P2-18 | A third, private `normAgency` whose docblock claims parity it does not have — its local `norm` collapses non-alphanumerics before the parenthetical-stripping regex runs, making that rule a no-op. Measured: `DEFENSE HEALTH AGENCY (DHA)` → SAM `true`, forecast `false`, from the same P01 profile | matching B-4 | `forecast-opportunity-read.service.ts:261`; `sam-opportunity-relevance.ts:220-222` | (b) |
| P2-19 | `relevanceScore` carries two different meanings in one column surfaced to the inbox: a weighted 0–100 measurement for SAM/grants, a three-valued confidence proxy (`{high:90, medium:60, low:30}`) for DIBBS/SBIR. Every row created in both live runs scored exactly `60` | matching B-5 | `client_funding_opportunity.relevance_score`; `funding-opportunity-inbox.service.ts:932` | (b) or (a) |
| P2-20 | The D-02 provenance invariant is unmet on exactly the three datasets D-02 names as provider-exclusive: **content hash absent** from all four DIBBS/SBIR tables and from `tango_procurement_forecast`, and DIBBS/SBIR have no `snapshot` column either, so it cannot be recomputed retroactively. `tango_dibbs_award` has neither source URL, content hash, nor raw payload. **No decision-log entry, handoff or schema comment acknowledges any of it** | ingestion B-5 | `apps/api/prisma/schema.prisma` (six tables); `decision-log.md:36-37` | (b) or (a) |
| P2-21 | The loud-envelope discipline exists only on the two clients P17 happened to probe. `tango.client.ts:591`'s shared `page()` helper — behind **all six** SDK-backed list endpoints, i.e. every network read P19/P22/P24/P27/P28 make — does `response.results ?? []`, and with `next` absent reports `completeness: 'complete'` with zero rows: the exact "0 records, complete" outcome the DIBBS/SBIR headers name as the failure mode to prevent | ingestion B-6 | `apps/api/src/external/tango/tango.client.ts:591,610`; `tango-subaward.client.ts:150-155` | (b) |
| P2-22 | The canary diagnostic detects its own query failures and then discards the signal: `hasQueryFailure()` is exported, correct, and asserted by two spec tests — and **never called by `main()`**. The canary exits 0 whether zero queries failed or all twenty did | alerting B-6 | `apps/api/scripts/diag-funding-opportunities-makegov.ts:179` | (b) |
| P2-23 | `sync-tango-dibbs.ts`'s per-row `catch {}` is bare — no binding, nothing logged — so a constraint violation on every row yields `errored: N` with zero information about why. Secondarily, in dry-run `summary.written` counts rows never written while `errored` stays 0 by construction | alerting B-7 | `apps/api/scripts/sync-tango-dibbs.ts` (`walkEndpoint`) | (b) |
| P2-24 | The `rate_limited` fix — one of the program's two known "broken reads as healthy" incidents, carrying a twelve-line comment about the 2026-08-08 misdiagnosis — has **zero test coverage**; the 549-line spec contains no occurrence of `rate_limited` | alerting B-8 | `tango-capability-probe.service.ts:501-508`; `tango-capability-probe.service.spec.ts` | (b) |
| P2-25 | The P16 secret boundary is verified correct **live and exhaustively** (227 task-definition families swept; exactly one carries `TANGO_API_KEY`; the IAM layer holds independently) — but the code enforcing it is undeployed. `capiro-dev-api-sync-jobs` is not a CloudFormation resource at all, and its execution role carries 18 ad-hoc inline policies. The boundary holds by manual convention, and nothing re-asserts it | infra F-3 | `infra/cdk/lib/compute-stack.ts:275-295`; `capiro-dev-syncjobs-execution-role` | (a) + (b) |
| P2-26 | `DRIFT-FINDINGS.md` records `Capiro-dev-Compute` as `UPDATE_ROLLBACK_FAILED` in both its original and its re-verification; it is now `UPDATE_ROLLBACK_COMPLETE` — stable and **updatable**. Step A has effectively happened while Steps B and C remain undone, so the condition that made a destructive deploy impossible is gone and nothing in the repo reflects it | infra F-4 | `infra/cdk/DRIFT-FINDINGS.md` | (a) |
| P2-27 | A fully-withheld page hides the pager entirely, stranding every later page: `fo-pager` lives only in the non-empty branch, so a page of results entirely withheld by a capability flag renders the empty state with a non-null `nextCursor` and no Next button. The existing test asserts the notice and the empty state and says nothing about the pager | ui-triage B-2 | `FundingOpportunityInbox.tsx:267-269,355,447-481` | (b) |
| P2-28 | The drawer's forecast branch skips the flag check the full page requires and explicitly justifies. A shared `?detail=agency_forecast:…` link opens the drawer for a tenant without the flag and renders a three-way hedge (*"…or agency forecasts may not be enabled for this workspace"*) — precisely the presentation the full page's comment rejects, in the frame a reader most often arrives in | ui-triage B-3 | `FundingOpportunityDrawer.tsx:121`; `FundingOpportunityDetail.tsx:540-548` | (b) |
| P2-29 | DIBBS and SBIR rows have **no path to the source record** from the inbox: no detail body (correct), and the source-document links are nested inside an action row the inbox structurally never renders. The data is on the wire and simply not rendered; the two design rules being applied are each individually right and their composition is a dead end | ui-triage B-4 | `DibbsOpportunityCard.tsx:282-300`; `SbirOpportunityCard.tsx:298-324` | (b) |
| P2-30 | P08's "same value" date invariant breaks on the reuse path: `dueDate` is recomputed fresh each call while the reused task keeps its original, so a moved source deadline drifts the two apart — the exact drift the phase says it prevents. `ownerUserId` diverges the same way. The unit test only checks the fresh-create path | p07-p08 §4 / F-2 | `funding-opportunity-actions.service.ts` (`act()`) | (b) |
| P2-31 | P08's suite is entirely fake-backed, and the two tests named as proof of the phase's core property assert the fake's own hand-written rollback (`catch { created.length = 0 }`). They would pass even if `withTenant` opened no transaction whatsoever. No P08 test ever executes SQL | p07-p08 F-3 | `funding-opportunity-actions.spec.ts` | (b) |
| P2-32 | The CHECK-rejection proof for P07 exists only as prose in the matrix. CI asserts the constraints *exist* (`count(*) = 1`) but never that they reject, and does not assert their **definitions** — a later migration could re-add a same-named constraint as `CHECK (true)` and CI would stay green | p07-p08 F-4 | `.github/workflows/funding-opportunities-ci.yml`; `funding-opportunity-decision.spec.ts` (a text-regex read of the migration file) | (b) |
| P2-33 | Neither D-79 producer has a single test that touches a real database — 56 green tests against a `makeFake` with a hand-written 15-line `where` interpreter that cannot observe the CHECK constraint, the partial unique index, RLS, the real raw-SQL column names, VarChar truncation, or Prisma `select` semantics. The reviewer closed the gap by hand and the code passed, so this is an assurance gap, not a latent defect | d79 F1 | both `generate-*-opportunity-candidates.spec.ts` | (b) |
| P2-34 | Each rail has exactly one live gate and it is documented nowhere the operator will look: DIBBS requires a recorded `cageCode` **and** a matching `tango_dibbs_award` row, so while award ingestion has not run the producer is structurally guaranteed to create zero rows regardless of how many solicitations are synced. SBIR's Rule 4 is entirely unreachable | d79 F3 | `generate-dibbs-opportunity-candidates.ts`; `dibbs-relevance.ts` Rule 4; `sbir-relevance.ts` Rules 4–5 | (a) + (b) |
| P2-35 | Multi-tenant coverage and the resume cursor are both wrong across tenants: `clientWalkOutcome` is reassigned each iteration so an `INCOMPLETE` walk on tenant A is erased by a `COMPLETE` walk on tenant B (letting the watermark advance over an unevaluated tail), and `startCursor` is applied to **every** tenant's walk. **Inherited, not introduced** — `generate-sam-opportunity-candidates.ts` has the identical shape | d79 F4 | both new producers; `generate-sam-opportunity-candidates.ts:370-377,608-612` | (b) |
| P2-36 | Two closeout tables still say a migration remains unapplied; D-70 proved a clean `capiro-dev-api-migrate:55` run reported *"256 migrations found / No pending migrations to apply"*. D-70's corrections were applied to the phase rows for P36/P40/P42 and **not** to the closeout tables | p51 F-04 | `completion-matrix.md:222`, `:235` | (a) |
| P2-37 | The "Two things a reader should not have to rediscover" list carries a hazard D-70 proved has **inverted**: those 16 rules were already dead and failing every fire, and registering rev 55 RESTORED them. D-70's own generalisable lesson is about exactly this — *"a documented hazard describes the system on the day it was written"* — and it was not applied to the document stating the hazard D-70 had just inverted. The most operationally consequential staleness instance | p51 F-05 | `completion-matrix.md:245-247`, and the same pre-D-70 framing at `:75`, `:77`, `:235` | (a) |
| P2-38 | The original plan document is confirmed absent from the repository — **in this commit and in all history, on any branch** (three independent searches). §6.2, §6.3, §6.1 and §4.6, including whatever defines "program completion", are readable only through second-hand quotation with no primary source and no way to check a transcription. For P51 this means there is no checked-in authority against which "the program is complete" can be evaluated | p51 F-11 | `README.md:6` names `funding-opportunities-makegov-shippable-microphase-plan.md`; the file has never existed in this repo | (a) + (c) |
| P2-39 | The forecast rail has the same ungated-inbox shape as DIBBS/SBIR and has since P26: `funding_opportunities_forecasts` guards the forecast **detail** route (404 when off) but does not filter forecast rows out of the inbox JSON. Lower than P1-1 only because forecasts have a real guard on a dedicated route | flag-guard F-5 | `funding-opportunity-inbox.service.ts`; `funding-opportunities.controller.ts:556` | (b) |

---

## P3 — 27 findings

| # | Finding | Source(s) | Affected | Class |
|---|---|---|---|---|
| P3-1 | The 1 MB raw cap turns an oversized authenticated batch into a terminal 413 — a 4xx, which under this receiver's own retry contract means stop retrying, so the delivery is lost as permanently as P0-6's. D-56's sizing used "minimal event objects"; the SDK's documented event carries arrays of matched records | p46 F8 | `configure-api-http-app.ts:136` | (b) |
| P3-2 | The global `ThrottlerGuard` governs `/webhooks/tango` undeclared (no `@SkipThrottle` anywhere under `apps/api/src/webhooks`), so a provider burst gets 429 — a sixth status reachable from outside the carefully-written retry contract that enumerates five | p46 F9 | `app.module.ts` | (b) or (a) |
| P3-3 | A JSONB poison pill (`\u0000` in authenticated scraped federal text) makes the insert throw a non-`P2002` error → correctly rethrown → 503 → provider retries → fails identically, forever, with an `error` log per retry and no terminal state | p46 F11 | `tango-webhook.service.ts` (`payload: parsed as never`) | (b) |
| P3-4 | §30's hazard fired again **during the review**: `capiro-dev-api-migrate` reached revision 60 at 2026-08-13T21:10:57Z, silently re-imaging all 16 unpinned+enabled rules including three jobs this program is about. Worth citing as a dated fact rather than a hypothesis | p50 F11 | rollout §30 consequence 2 | (a) |
| P3-5 | Two latent double-counts in P41: `exactNsnMatch`/`exactPartNumberMatch` are correctly collapsed in the outcome logic but push **separate** entries into `reasonCodes`, which are persisted verbatim as the row's entire evidence record; and `priorCageAwardHistory`/`buyerHistory` would necessarily read the same rows while sitting in different strength buckets | matching B-6 | `dibbs-relevance.ts:247-248,279` | (b) |
| P3-6 | The brief's premise that all four scorers share `recommendationConfidence` + `clearsSuggestionFloor` is false, and two of the four legitimately differ — P23 is a client-posture truth table, not a relevance scorer; P25 is a read path with no producer, so a floor would be dead surface. Neither is drift | matching B-7 | — | (a) |
| P3-7 | `sync-tango-opportunity-attachments.ts:171` contains a **literal NUL byte** as a dedupe-key delimiter, so `file` reports the source as `data`, `grep` refuses to print context, and **git treats it as binary — it produces no textual diff in any PR or review tool.** It is the file driving P29's SSRF-guarded fetch loop | ingestion B-9 | `apps/api/scripts/sync-tango-opportunity-attachments.ts:171` | (b) |
| P3-8 | The dispatcher's own usage string has stopped covering 46 of its 128 verbs, 14 of them Tango/FO. D-69's generalisation recurring one layer out, on the failure path — the third time the program has hit this exact shape (D-19, D-24, D-69) | ingestion B-10 | `apps/api/scripts/entrypoint-dispatcher.inc` | (b) |
| P3-9 | `diag-tango-health.spec.ts` tests only CLI flag parsing — four tests, one `describe`. The report path, the part that could mislead, has no script-level coverage | alerting B-9 | `apps/api/scripts/diag-tango-health.spec.ts` | (b) |
| P3-10 | Two latent string-vocabulary couplings with no test pinning the literals, both the same class as the known `agrees`/`agreement` bug: `resolutionCounts.get('unreviewed') ?? 0` / `byAgreement['ambiguous'] ?? 0`, and `hasTypeKey` computed from a variable named `idKeys` | alerting B-10 | `diag-tango-opportunity-parity.ts`; `diag-tango-webhook-contract.ts` | (b) |
| P3-11 | No durable per-environment record of applied migrations. `verify-migrations.ts` is the right tool and is **directory-driven, not list-driven**, so it cannot go stale — but it is on-demand only, not scheduled, not a required check, and produces no persisted artifact. "Applied to capiro-dev" exists only as prose someone typed, which is the exact failure D-70 named | infra F-5 | `apps/api/scripts/verify-migrations.ts` | (b) + process |
| P3-12 | The inbox **list** dispatch keeps the negative-fallback polarity D-67 removed from the drawer and the full page: the catalog card is the unnamed default branch, and `InboxRowCard` takes the wide `InboxRow` so a sixth rail would render with a Deadline row and an Eligibility row with no compiler error. Applied to the two detail frames and not to the surface a reader actually spends time on | ui-triage B-5 | `FundingOpportunityInbox.tsx:392-445,765-770` | (b) |
| P3-13 | The web's `INBOX_SOURCES` mirror is a hand-copied flat literal while the API's is a spread pinned by regex *specifically because a hand-kept copy could drift* — and no test under `apps/web/src/**/*.test.tsx` references it at all. Drift would silently make a rail's deep links undecodable with no failing test | ui-triage B-6 | `apps/web/.../funding-opportunities-api.ts:373-379` | (b) |
| P3-14 | No inbox test ever renders a `grants_gov` row — the uncovered rail is the **oldest**, not the newest. Four rails have realistic fixtures with content assertions; `grants_gov`'s one rail-specific behaviour (a tag colour) is unexercised | ui-triage B-7 | `FundingOpportunityInbox.test.tsx` | (b) |
| P3-15 | P08's validation reads (`describeForAction`, `assertOwnerAssignable`) each run in their own transaction *before* the write transaction opens, so pursuability and owner membership are checked on a different snapshot than the one that writes | p07-p08 F-6 | `funding-opportunity-actions.service.ts` | (b) or (a) |
| P3-16 | Two false premises in the P07/P08 review brief itself — it described P07 as adding RLS policies (the migration deliberately adds none, inheriting them) and a "unique-constraint-guarded first-decision race" (no such constraint exists anywhere). Verifying them as stated would have produced two false PASSes. Whatever source they came from will mislead the next reviewer | p07-p08 §0 / F-7 | the review brief's source document | (a) |
| P3-17 | Full cross product with the source corpus re-walked once per 500-client page, and one interactive transaction per written row. At a realistic corpus (~17,900 active SAM notices) with a few hundred clients this is millions of scorer calls. Inherited from the SAM producer's shape | d79 F5 | both new producers | (b) |
| P3-18 | "N rows scanned" reports 0 when the **client** walk found nobody, because the corpus variables are only assigned inside the client walk's `onPage` — a false statement about the source corpus, and the first line an operator reads | d79 F6 | both new producers | (b) |
| P3-19 | Producers are scheduled 5 minutes after their source syncs (13:10→13:15, 13:30→13:35); a sync running longer scores a partially-synced corpus and marks the remainder as having no candidate. Forward-looking only — both ship `enabled: false` | d79 F7 | `infra/cdk/lib/ingestion-schedule.ts` | (b) |
| P3-20 | `intel_feature_flag` is invisible to this repo's schema, migrations and CI — it appears in none of the 264 migrations and not in `schema.prisma`, so `resolveTenantIds` cannot be executed in any local or CI environment (the reviewer had to create the table by hand). Its `tenant_id` is TEXT while every consumer feeds it into a `@db.Uuid` filter, a contract recorded only in a comment inside an unrelated guard documenting a six-week outage caused by getting it wrong. **The bypass idiom itself was checked specifically and is correct** | d79 F8; lifecycle F-5 | `resolveTenantIds` in both producers and the lifecycle script | (b) |
| P3-21 | Test-evidence cells for P26–P32 do not carry the counts the matrix's own legend requires: P26 is a retrospective backfill equal to P33's figure, **P27 is an unfilled placeholder** (`api 53→ suites, +tests`), and P28–P32 are a pointer rather than a count. With Actions `startup_failure` repo-wide since 2026-07-31, the recorded counts are the only test evidence that exists | p51 F-07 | `completion-matrix.md:61-67` | (a) |
| P3-22 | The closeout text misstates the program's own review baseline: two places assert every phase is `*self-verified only*`, and **both are false for exactly half the program** — P00–P25 are `*pending*`, which the Deviations table defines as a distinct and weaker state. The number to beat was not "52 self-verified" but "26 self-verified, 26 with nothing recorded, 0 independently reviewed" | p51 F-13 | `completion-matrix.md:260-261`, `:315` | (a) |
| P3-23 | P49, P50 and P51 are the only rows violating the matrix's own *"Code = a SHA, not 'done'"* rule — their Code cells hold deliverable descriptions and the merge SHA has migrated into the Status cell. Effect: **P51 records no test evidence at all**, and the three phases most in need of a precise pointer at closeout are the three whose Code column has none | p51 F-14 | `completion-matrix.md:84-86` | (a) |
| P3-24 | Two canary flags gate nothing and **do not exist at all**: `funding_opportunities_tango_entities` and `funding_opportunities_tango_webhooks` have **zero occurrences repo-wide**, docs included. (The `_tango_shadow` half is P0-10.) The runbook instructs an operator to advance rollout by enabling flags no code reads, creating a false record that a capability was gated | flag-guard F-6 | canary runbook; `funding-opportunities-flag.guard.ts` | (a) or (b) |
| P3-25 | Duplicated `eventIndex` alias in P48's `claimBatch` RETURNING — projected twice, once qualified and once bare. Postgres accepts it and Prisma collapses them, so it is harmless today, but if the two expressions ever diverge one silently wins, and widening the `claimed` CTE turns a cosmetic duplicate into a hard failure | lifecycle F-2 | `apps/api/scripts/process-tango-events.ts:376` | (b) |
| P3-26 | The headline 4,001×501 completeness tests run with `commit: false` — they prove the **walk** is exhaustive and write nothing. The commit-path assertion is a separate test against a one-grant/one-client fixture, so nothing anywhere asserts that `created` scales with `evaluated`. The same blind spot as P0-1, one layer up | lifecycle F-3 | both producer specs | (b) |
| P3-27 | The `fpds` guard's own comment describes it as *"a real federal system this program has never proposed ingesting"* — true for this program, not true of the repository: two MeriV2 plan documents schedule a `sync-fpds` verb. The `not.toContain` guard still fails loudly if it ever became legal, but the comment's claim is broader than it should be | ui-triage advisory | `funding-opportunity-inbox.spec.ts:1020-1035` | (a) |

---

## P4 — 12 findings (informational; recorded so they are not re-derived)

| # | Finding | Source |
|---|---|---|
| P4-1 | `provider_event_at` will be systematically null for one of the two real webhook body shapes — the SDK's documented single-event body carries `checked_at`, which is not in `readEnvelope`'s timestamp candidate list. P47/P48 should not read anything into that absence | p46 F12 |
| P4-2 | `prisma.service.ts` states the runtime role `capiro_app` *"BYPASSES Postgres row-level security, so the RLS policies never fire"*, in tension with `FORCE ROW LEVEL SECURITY`, which subjects even the owner to RLS. One of the two is wrong, and either way the matrix's "RLS still ENABLED + FORCED" line asserts a net that may not be the one catching anything at runtime. Pre-existing (P00), outside P07/P08's scope | p07-p08 F-8 |
| P4-3 | The contract award rail is never exercised in the grant producer's spec — the `$queryRaw` double returns a row for `federal_assistance_award` and falls through to `[]` for `federal_award`, so the contract branch and the `contractAgencies`/`awarding_sub_tier` handling are uncovered by that file. Both statements were executed independently and are structurally valid | lifecycle F-4 |
| P4-4 | Replaying only `apps/api/prisma/migrations` produces a **false positive** that looks exactly like the never-executed-SQL bug: `intel_feature_flag` is created by `apps/intel-api`'s migrations, both apps share one database, and the database must be named `capiro`. Recorded so the next reviewer does not lose time to it | lifecycle F-5 |
| P4-5 | Three UI nits: withheld counts are per-page but worded as if per-queue; the drawer's unnamed-rail fallback has zero test coverage (nothing renders it because all five rails are named, which is correct but leaves the safety net unverified); `drawerTitle` defaults to "Opportunity detail" above a body saying there is no view for the rail | ui-triage B-8 |
| P4-6 | No precedent exists for UI-only gating in this codebase — `district_nexus_v2`, `hearing_watch`, `bill_360` and `tracker_v2` all have real server-side guards. Recorded so P1-1/P1-2 are not later mistaken for an accepted house convention, and so a future reviewer does not have to re-derive the search | flag-guard F-7 |
| P4-7 | D-79's two new CDK schedule declarations sit in a file imported by the `Capiro-dev-Compute` stack this matrix forbids deploying, so they cannot reach live EventBridge through the tracked CDK path. The alternative (`gen-ingestion-schedules.ts` generating hand-runnable `aws events` commands from the same source of truth) exists and is documented, so this is not a blocker — but the answer is implicit in a CDK import graph rather than written anywhere a closeout reader would look. **Raised as context, explicitly not as a finding, because no document at this SHA states it incorrectly** | p51 §4 |
| P4-8 | **P32 looks like a plausible additional Band C candidate** — its diff touches zero files under `apps/api`, and its `funding-opportunities-api.ts` change is constant maps keyed on the pre-existing `MachineRecommendation` type, framed as a card-vs-drawer label parity fix. A lead, not an attestation: `OpportunityAssessmentPanel.tsx` was not read in full | band-c |
| P4-9 | Negative result worth recording: **P01, P02, P06, P23 and P25 are individually sound.** Every finding in the matching/scoring band sits on a boundary *between* phases rather than inside one, and the confidence vocabulary shared by P41 and P43 is consistent and genuinely cross-comparable — the defects are entirely in what feeds it | matching, "What was checked and found sound" |
| P4-10 | Negative result worth recording: **the `tango_sync_checkpoint.resource_type` boundary is clean**, verified exhaustively in both directions — the CHECK admits six values and has never been widened, the TS vocabulary matches value-for-value, every write is guarded by `assertKnownResourceType`, every call site passes a literal from the allowed set, and DIBBS/SBIR never write a checkpoint row at all. No write path exists that could hit the CHECK and no coercion path exists that could produce a wrong-but-successful write | ingestion, "Verified clean" |
| P4-11 | Open confirmation item: the live 5-rail dropdown is best read as evidence that `funding_opportunities_forecasts` **and** `funding_opportunities_sbir` both have enabled rows for the viewed tenant and that a bundle at-or-after `4a1a0331c` is deployed — no code-level alternative explanation survives. The actual `intel_feature_flag` rows and the deployed bundle SHA remain **unverified**; confirming them requires a DB read and an ECS/task-def check. If the flags are *not* on, something in the runtime contradicts the code as read | flag-ui-reconciliation §1, rec 3 |
| P4-12 | D-79's *"no evidence in the repo of ever being enabled"* is accurate but reads as "not enabled anywhere", which the live observation appears to contradict. Distinguishing repo-state from database-state in that sentence would have prevented an entire review | flag-ui-reconciliation rec 4 |

---

## Coverage: which phases now have a real verdict

**43 of 52.** Mapping of review file → phases, with the band verdict:

| Review file | Verdict | Phases it covers |
|---|---|---|
| `band-c-attestation.md` | `P00_…_CONFIRMED_INERT` / `P09_…_CONFIRMED_PRESENTATION_ONLY` | P00, P09 |
| `band-a-p07-p08.md` | `BAND_A_P07_P08_REJECTED` (P07 passes alone; the rejection is P08's) | P07, P08 |
| `band-b-matching-scoring.md` | `FO_GA_BAND_B_MATCHING_SCORING_REJECTED` | P01, P02, P06, P23, P25, P41, P43 |
| `band-b-lifecycle-events.md` | `FUNDING_OPPORTUNITIES_BAND_B_INDEPENDENTLY_APPROVED` (= `PASS WITH NON-BLOCKING NOTES`) | P03, P04, P35, P36, P47, P48 |
| `band-b-ui-triage.md` | `BAND_B_UI_TRIAGE_REJECTED` | P10, P11, P12, P26, P32, P33, P34 |
| `band-b-infra-deploy.md` | `FO_GA_BAND_B_INFRA_REJECTED` | P13, P16 (+ all 27 migrations, `config.ts`, `compute-stack.ts`) |
| `band-b-ingestion-adapters.md` | `BAND_B_INGESTION_ADAPTERS_REJECTED` | P14, P15, P17, P18, P19, P22, P24, P27, P28, P29, P30, P40, P42 (+ subawards, adjacent) |
| `band-a-p46-webhooks.md` | `P46_REJECTED` | P46 |
| `band-a-p49-canary.md` | `P49_CANARY_RUNBOOK_REJECTED` | P49 |
| `band-a-p50-schedule-enablement.md` | `P50_SCHEDULE_ENABLEMENT_REJECTED` | P50 |
| `band-a-p51-ga-closeout.md` | `P51_GA_CLOSEOUT_REJECTED` | P51 |
| `band-a-flag-guard.md` | `FO_GA_BAND_A_FLAG_GUARD_REJECTED` | cross-cutting (lands on P26, P41, P43; guard itself passes in full) |
| `band-a-d79-producer-wiring.md` | `D79_PRODUCER_WIRING_INDEPENDENTLY_APPROVED` | D-79 / PR #943 (lands on P41, P43) |
| `flag-ui-reconciliation.md` | split — dropdown correct, data path a genuine gap | cross-cutting |

**Still with no independent review of any kind (9):** **P05, P20, P21, P31, P37, P38, P39,
P44, P45.**

---

## What the reviews say is genuinely good — recorded so the rejections are not read as broader than they are

Twelve of fifteen reviews rejected, and every one of them went out of its way to state what
held. Collected because a queue of 118 findings misrepresents the program without it.

- **P07 passes outright.** All 263 migrations replayed clean from empty; six columns nullable
  with no DEFAULT, no backfill, three CHECKs with correct definitions, RLS ENABLED **and**
  FORCED with exactly four policies, and all six bad-data shapes re-proved rejected by real
  Postgres with two positive controls.
- **P08's atomicity — the phase's actual purpose — is real.** `withTenant` is a genuine Prisma
  interactive transaction and `applyActionDecision` threads the same `tx` through every write
  including the audit row, with no hidden fallback. This is the P48 failure mode and P08 does
  not have it.
- **P46's raw-bytes ordering invariant holds across the whole chain**, not just inside the
  handler — traced through `main.ts`, the raw mount, the global prefix exclusions, the tenant
  middleware exclusion and the second process. The HMAC implementation is correct and its
  tests are real crypto, not mocks. The retry contract is right and an unrecorded delivery is
  never acknowledged. PR #834's fix is present and was not reverted through two later fix
  rounds.
- **The fourth instance of the never-executed-SQL class was searched for and does not exist.**
  All 23 raw SQL callsites across P03, P04, P35, P36, P47 and P48 were executed verbatim
  against a real 263+26-migration Postgres as a **non-superuser under forced RLS**. Every one
  runs. P35 and P47 are structurally immune.
- **§30's central measurement reproduced exactly, five days later** — 27 rules on
  `capiro-dev-api-migrate`, 23 unpinned, 16 of those enabled, 0 on `api-admin-migrate`. It is
  the strongest safety argument in that runbook and should not be touched.
- **The P16 secret boundary verifies live and exhaustively** — 227 task-definition families
  swept, exactly one carries `TANGO_API_KEY`, and the IAM layer holds independently of the
  task definitions (the serving task *cannot read* the key, not merely "is not handed it").
- **Migration hygiene passes across all 27**: no `DROP TABLE`, no `DROP COLUMN`, no
  `TRUNCATE`, no `DELETE FROM`; every creation `IF NOT EXISTS`; every constraint addition
  guarded; all retry-safe. All 6 tenant-scoped tables carry ENABLE + FORCE + exactly four
  policies with UPDATE correctly carrying both `USING` and `WITH CHECK`.
- **The D-79 producers are correct as merged.** The specific bug this program feared — a
  `sourceRecordKey` mismatch that passes every constraint while making every row invisible —
  was verified **absent by execution** against a real migrated database, and the V2 deletion
  is complete with no dangling references.
- **The D-67 dispatch fix held and generalised to all five rails** in both detail frames, and
  SBIR — the newest rail — received the *full* three-state / per-rail-withheld treatment
  rather than a shortcut. `fpds` is illegal on every vocabulary and the self-guard is correct
  and, this time, durable.
- **The flag guard itself is well built** — fails closed on all three paths, uses `withSystem`
  on an RLS-FORCE'd table, carries no `::uuid` cast (the District Nexus incident), and
  genuinely has no implicit internal-tenant fallback, pinned by a comment-stripping test.
- **Four of the six diagnostics handle failure better than expected**, and the P49
  `QUERY FAILED` remediation is genuinely good work that held up under a hostile read —
  including a test that asserts the *absence* of the specific wrong table.
- **P00 and P09 are genuinely inert / presentation-only**, confirmed by reading each phase's
  own isolated commit rather than the combined PR.

The recurring meta-observation, made independently in several files: this program corrects
itself in *decision-log entries* and *phase rows*, and the *summary sections* lag. Every
documentation contradiction found was already correctly recorded somewhere else in the same
corpus; not one is a fact nobody knew.
