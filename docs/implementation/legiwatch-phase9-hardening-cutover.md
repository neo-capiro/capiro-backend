# LegiWatch Live Hearings — Phase 9 Coverage Hardening, Production Activation, and Cutover

Status: implementation complete at the code/contract level on
`agent/legiwatch-phase9-hardening-cutover`.

Stacked base: `agent/legiwatch-phase8-live-intelligence`.

This phase does **not** merge, deploy, enable EventBridge rules, enable the
production default, release the kill switch, or enable capture-all. Those are
separate guarded operator actions after executable validation and current live
evidence.

## 1. Phase 9 exit contract

Phase 9 converts the Phase 0–8 implementation into an auditable production
system. The launch contract is:

1. Every current parent committee and subcommittee has an explicit source and
   coverage state.
2. Every official observation in the audit window is linked to one canonical
   hearing or has an explicit `CONFLICT` / `IGNORED_INVALID` disposition.
3. Every canonical hearing in the launch window has official observation
   provenance.
4. No duplicate canonical event fingerprint exists.
5. No hearing has more than one global public capture.
6. Every due eligible hearing has a terminal capture result or an explicit,
   policy-grounded non-capture reason.
7. Transcript interruption time has a durable gap ledger or segment marker.
8. Recovery preserves one canonical transcript sequence.
9. Discovery, probes, preflight, capture, intelligence, comparison, and metrics
   jobs are registered, scheduled, alive, and within freshness budgets.
10. The required live/chaos evidence matrix is current and source-appropriate.
11. The production default cannot change unless the guarded state machine,
    readiness evidence, exact operator confirmation, and controlled environment
    gate all agree.
12. Rollback restores the preserved Live Hearings surface, disables Phase 9
    schedules, engages the kill switch, and disables capture-all.

A zero-observation window is **insufficient evidence**, never full coverage.

## 2. Durable control plane

Phase 9 adds forward-only SQL migrations under:

```text
apps/api/prisma/migrations/20261123040000_legiwatch_phase9_hardening_cutover
apps/api/prisma/migrations/20261123041000_legiwatch_phase9_observation_disposition
apps/api/prisma/migrations/20261123042000_legiwatch_phase9_observation_disposition_trigger
apps/api/prisma/migrations/20261123043000_legiwatch_phase9_runtime_and_evidence
apps/api/prisma/migrations/20261123044000_legiwatch_phase9_shadow_schedules
apps/api/prisma/migrations/20261123045000_legiwatch_phase9_audit_scope
apps/api/prisma/migrations/20261123045100_legiwatch_phase9_audit_scope_trigger
apps/api/prisma/migrations/20261123045200_legiwatch_phase9_safe_observation_timestamp
```

### `legiwatch_runtime_heartbeat`

One global row per required job. It records:

- enabled and schedule-enabled state;
- expected cadence and maximum lag;
- EventBridge rule and ECS task family;
- start, heartbeat, success, failure, and finish timestamps;
- consecutive failures;
- bounded operational metrics;
- bounded last error.

All rows are seeded `disabled`, `enabled=false`, and
`schedule_enabled=false`.

### `legiwatch_cutover_run`

Immutable readiness evidence for one bounded audit window. It records body,
observation, canonical event, capture outcome, duplicate, unresolved, worker,
and intelligence-latency counts. A `PASS` row with `evidence_source='NONE'` is
rejected by PostgreSQL.

### `legiwatch_event_audit`

Per-run exceptions with explicit scope:

```text
RUN | BODY | OBSERVATION | EVENT
```

This preserves operational blockers such as a stale worker even when no hearing
id exists.

### `legiwatch_cutover_state`

A guarded singleton, seeded as:

```text
phase                       SHADOW
production_default          false
schedules_enabled           false
kill_switch_engaged         true
capture_all_public_events   false
minimum_consecutive_passes  3
minimum_shadow_hours        168
```

PostgreSQL rejects:

- production default outside `CUTOVER`;
- kill-switch release outside `CUTOVER`;
- capture-all outside `CUTOVER`;
- illegal state transitions;
- deletion of the singleton.

### `legiwatch_verification_evidence`

Immutable proof for real and controlled scenarios. Evidence has a source,
status, observation time, expiry, optional hearing/capture/run anchors, safe
artifact reference, bounded details, and actor attribution.

The global operational tables contain no tenant, client, watchlist, mailbox,
memory, user-session, credential, raw audio, or raw media URL fields.

## 3. Observation-led parallel comparison

`hearing_source_observation` now has an explicit disposition:

```text
PENDING
RECONCILED
CONFLICT
IGNORED_INVALID
```

Linking an observation to a canonical hearing atomically changes its state to:

```text
RECONCILED + CANONICAL_HEARING_LINKED
```

Unlinked observations remain launch blockers until an administrator records an
explicit conflict or invalid-source reason. Malformed public `startsAt` values
are sanitized at the database boundary so one damaged source value cannot abort
an entire coverage audit; the observation remains auditable through its date,
first-seen time, and disposition.

This observation ledger is the old/new comparison surface. Phase 9 does not
create a second canonical hearing table.

## 4. Readiness evaluator

`LegiWatchPhase9ReadinessService` evaluates the existing Phase 3–8 corpus:

- `congress_committee` — every current parent and subcommittee;
- `committee_source` — direct, inherited-parent, or chamber-wide source paths;
- `hearing_source_observation` — official event evidence and disposition;
- `committee_hearing` — canonical event corpus;
- `hearing_stream_candidate` — policy and resolution outcomes;
- `hearing_subscription` — tenant recording demand;
- `public_hearing_capture` — one global capture and terminal result;
- `public_hearing_transcript_segment` — one timeline and gap markers;
- Phase 8 public intelligence and tenant relevance queues;
- Phase 9 runtime heartbeats;
- Phase 9 verification evidence.

Body coverage states are explicit:

```text
HEALTHY
HEALTHY_NO_EVENTS_OBSERVED
DEGRADED
REVIEW_REQUIRED
UNAVAILABLE
```

`HEALTHY_NO_EVENTS_OBSERVED` proves source reachability only. It does not prove
that official events were represented and cannot satisfy the zero-event launch
gate.

The legacy `audit-hearing-coverage.ts` command now calls this evaluator. The old
parent-only report and hardcoded `serverCaptureAllowed=false` output are no
longer the operator path.

## 5. Global discovery and update jobs

Phase 9 reuses the existing discovery adapters and repositories:

- Congress.gov committee meetings;
- House Clerk committee repository;
- Senate committee schedule;
- committee-site adapters;
- `CommitteeSourceRepository` source-health tracking;
- `HearingObservationRepository` provenance ledger;
- `HearingReconcilerService` deterministic canonical reconciliation;
- `DiscoveryJobsService` enrichment, update detection, probes, and archive
  reconciliation.

There is still one canonical `committee_hearing` corpus. Partial source failures
are recorded per source and do not suppress successful sources.

## 6. Preflight and unattended capture

`LegiWatchPhase9PreflightService` plans the required checkpoints in the existing
Phase 6 durable queue:

```text
T-60 minutes
T-15 minutes
T-2 minutes
scheduled start
rolling delayed-start checkpoint every 5 minutes
```

The planner:

- requires tenant demand unless the separately guarded capture-all state is on;
- creates at most one `public_hearing_capture` row;
- uses stable checkpoint dedupe keys;
- re-arms completed/failed checkpoints without duplicating active leases;
- requires worker-side re-resolution;
- skips terminal captures;
- skips explicit browser-only, license-required, or blocked source sets;
- continues after an isolated event failure.

The actual resolver, FFmpeg/Deepgram runtime, capture attempts, leases, fencing,
retry ceiling, gaps, and transcript storage remain the Phase 5/6 implementation.
Phase 9 wraps those workers with operational heartbeats; it does not replace
them.

## 7. Intelligence worker activation

The Phase 8 public-insight and tenant-relevance worker remains authoritative.
Phase 9 adds a bounded runner that:

- optionally backfills final canonical transcript segments;
- optionally re-scores tenant relevance after client-context changes;
- drains public and tenant queues in bounded passes;
- refreshes an operational heartbeat while running;
- persists success/failure and queue metrics.

No tenant context is admitted to the global public insight rail.

## 8. Required runtime matrix and cadence

All jobs are registered dark by migration. The activation script creates
dedicated task definitions and disabled EventBridge Rules with these defaults:

| Job | Default cadence | Runtime |
|---|---:|---|
| central discovery | 10 minutes | API task |
| committee enrichment | 15 minutes | API task |
| committee updates | 30 minutes | API task |
| source probes | 20 minutes | API task |
| coverage audit | 6 hours | API task |
| stream preflight | 2 minutes | API task |
| capture worker | 1 minute | intel-api task |
| archive reconciliation | 30 minutes | API task |
| intelligence worker | 1 minute | intel-api task |
| parallel comparison | 6 hours | API task |
| metrics | 5 minutes | API task |

`schedules_enabled=true` is set only when all eleven required jobs are registered,
enabled, and schedule-enabled. A partial matrix cannot unlock canary.

## 9. Observability

`LegiWatchPhase9MetricsService` emits CloudWatch Embedded Metric Format under:

```text
Capiro/LegiWatch
```

Metrics include:

- production-default, schedules, kill-switch, and capture-all state;
- consecutive passing readiness runs;
- readiness blockers and evidence age;
- body and official-observation counts;
- observation disposition and capture outcome percentages;
- duplicate canonical events and captures;
- unresolved hearings;
- stale and failed runtime jobs;
- capture, public-intelligence, and relevance queue depth/failures;
- active, failed, blocked, and complete-with-gaps captures;
- transcript-gap seconds;
- upcoming two-hour events with no explicit stream path.

The activation script creates alarms for readiness blockers, unresolved upcoming
hearings, duplicates, stale/failed jobs, failed queues, and failed captures.

## 10. Verification evidence matrix

`CUTOVER_VERIFICATION` requires current passing evidence for every row below:

```text
LIVE_DISCOVERY
LIVE_RESOLUTION
LIVE_CAPTURE
LIVE_DEEPGRAM
RECOVERY_GAP
WORKER_CRASH_RECOVERY
NETWORK_RECOVERY
DEEPGRAM_RECOVERY
DUPLICATE_SUPPRESSION
CONCURRENT_CAPTURES
DELAYED_START
CANCELLATION
RESCHEDULE
SOURCE_ROTATION
COMMITTEE_SITE_CHANGE
BROWSER_FALLBACK
POLICY_BLOCK
SILENCE_HANDLING
SPEAKER_ATTRIBUTION
TENANT_RLS
INTELLIGENCE_LATENCY
ROLLBACK
```

The four `LIVE_*` gates require `LIVE` or `MIXED` evidence. Archive or local
fixture evidence cannot satisfy them. The overall cutover run also requires
`evidence_source=LIVE|MIXED`.

Evidence payloads reject credential/secret fields, tenant/client/watchlist
fields, raw audio, and raw media URLs. `LIVE_CAPTURE` and `LIVE_DEEPGRAM` require
both hearing and capture anchors.

## 11. Operator APIs

Safe standard-user read:

```text
GET /api/legiwatch/live-hearings/phase9/rollout
```

Capiro-admin control plane:

```text
GET  /api/admin/legiwatch/phase9/readiness
POST /api/admin/legiwatch/phase9/readiness/run
GET  /api/admin/legiwatch/phase9/runs
GET  /api/admin/legiwatch/phase9/runs/:id
POST /api/admin/legiwatch/phase9/observations/:id/disposition
GET  /api/admin/legiwatch/phase9/runtime
POST /api/admin/legiwatch/phase9/runtime/register
GET  /api/admin/legiwatch/phase9/state
POST /api/admin/legiwatch/phase9/transition
POST /api/admin/legiwatch/phase9/capture-all
POST /api/admin/legiwatch/phase9/evidence
GET  /api/admin/legiwatch/phase9/evidence
```

The compiled operator runner exposes the same guarded service methods. It does
not issue direct cutover SQL.

## 12. Frontend cutover behavior

The Phase 9 rollout read is server-authoritative:

- `SHADOW` / `CANARY` / `READY`: only an enabled tenant can see V2;
- `CUTOVER`: the guarded production default can enable V2 for all tenants;
- `ROLLBACK`: force the preserved hearing surface;
- rollout endpoint unavailable/malformed: fail closed to the preserved surface;
- build-time kill switch: always authoritative and can disable V2 immediately.

Bill Tracker and Settings are not routed through the hearing cutover decision.

## 13. State transitions

### SHADOW → CANARY

Requires:

- exact confirmation `ENABLE LEGIWATCH CANARY`;
- all eleven schedules enabled;
- latest blocker-free passing `SHADOW` or `READINESS` run.

### CANARY → READY

Requires:

- exact confirmation `MARK LEGIWATCH READY`;
- schedules enabled;
- latest blocker-free passing `CANARY` or `READINESS` run;
- at least 168 shadow hours;
- at least three consecutive passing readiness runs.

### READY → CUTOVER

Requires:

- exact confirmation `CUT OVER LEGIWATCH LIVE HEARINGS`;
- controlled operator environment:
  `LEGIWATCH_ALLOW_PRODUCTION_CUTOVER=true`;
- schedules enabled;
- latest blocker-free `CUTOVER_VERIFICATION` pass;
- `LIVE` or `MIXED` evidence.

The database then atomically sets:

```text
phase=       CUTOVER
production=  true
kill switch= false
```

Capture-all is **not** enabled by cutover.

### Capture-all

Separate action requiring:

- successful `CUTOVER`;
- production default on;
- kill switch released;
- controlled operator environment:
  `LEGIWATCH_ALLOW_CAPTURE_ALL=true`;
- exact confirmation `ENABLE LEGIWATCH CAPTURE ALL`.

### Rollback

Requires exact confirmation:

```text
ROLL BACK LEGIWATCH LIVE HEARINGS
```

It atomically:

- sets phase `ROLLBACK`;
- disables the production default;
- disables schedules;
- engages the kill switch;
- disables capture-all;
- resets consecutive passes;
- disables every Phase 9 runtime registry row.

EventBridge rules should then be disabled with the activation script. The
preserved UI remains available.

## 14. Out-of-band activation

Read-only plan:

```bash
bash scripts/activate-legiwatch-phase9.sh plan
```

Create dedicated task definitions, IAM role, disabled rules, and alarms:

```bash
CONFIRM=CREATE_LEGIWATCH_PHASE9_DARK \
  bash scripts/activate-legiwatch-phase9.sh register-dark
```

Smoke individual jobs while the schedules remain dark:

```bash
bash scripts/activate-legiwatch-phase9.sh smoke metrics
bash scripts/activate-legiwatch-phase9.sh smoke central-discovery
bash scripts/activate-legiwatch-phase9.sh smoke stream-preflight
bash scripts/activate-legiwatch-phase9.sh smoke capture-worker
bash scripts/activate-legiwatch-phase9.sh smoke intelligence-worker
```

Enable the complete shadow matrix:

```bash
CONFIRM=ENABLE_LEGIWATCH_PHASE9_SHADOW \
  bash scripts/activate-legiwatch-phase9.sh enable-shadow
```

Disable schedules safely:

```bash
CONFIRM=DISABLE_LEGIWATCH_PHASE9_SCHEDULES \
  bash scripts/activate-legiwatch-phase9.sh disable
```

The script does not call CloudFormation and does not alter running services,
Aurora, the ALB, certificates, or the VPC.

## 15. Validation commands

### API schema and build

```powershell
pnpm --filter @capiro/api exec prisma validate
pnpm --filter @capiro/api exec prisma generate
pnpm --filter @capiro/api exec tsc -p tsconfig.hearings.json --noEmit
pnpm --filter @capiro/api build
```

### Phase 9 API unit/contract tests

```powershell
pnpm --filter @capiro/api test -- `
  src/live-hearings/phase9/legiwatch-phase9-gates.spec.ts `
  src/live-hearings/phase9/legiwatch-phase9-readiness.service.spec.ts `
  src/live-hearings/phase9/legiwatch-phase9-runtime.service.spec.ts `
  src/live-hearings/phase9/legiwatch-phase9-cutover.service.spec.ts `
  src/live-hearings/phase9/legiwatch-phase9-preflight.service.spec.ts `
  src/live-hearings/phase9/legiwatch-phase9.controller.spec.ts `
  src/prisma/legiwatch-phase9-migrations.spec.ts `
  --runInBand
```

### Disposable PostgreSQL proof

Apply all API migrations to a fresh PostgreSQL 16/pgvector database, then run:

```powershell
pnpm --filter @capiro/api test -- `
  src/live-hearings/phase9/legiwatch-phase9.integration.spec.ts `
  --runInBand
```

Required proof:

- dark singleton and eleven dark jobs;
- illegal SHADOW production-default/kill-switch/capture-all mutations rejected;
- `PASS + NONE` readiness row rejected;
- run-scoped audit blockers persist;
- linked observation auto-dispositions to `RECONCILED`;
- malformed source timestamp is sanitized;
- repeated preflight planning yields one capture and four jobs;
- verification evidence has no tenant/client/watchlist columns.

### intel-api regressions and Phase 9 wrappers

```powershell
pnpm --filter @capiro/intel-api typecheck
pnpm --filter @capiro/intel-api build
pnpm --filter @capiro/intel-api test -- `
  src/hearing/capture/public-capture.orchestrator.spec.ts `
  src/hearing/capture/public-capture-persistent-queue.adapter.spec.ts `
  src/hearing/capture/recovery.integration.spec.ts `
  src/hearing/capture/hearing-subscription-rls.integration.spec.ts `
  src/hearing/intelligence/hearing-intelligence-job.store.spec.ts `
  src/hearing/intelligence/hearing-intelligence.integration.spec.ts `
  --runInBand
```

Manual dark smoke commands:

```powershell
node apps/api/dist/live-hearings/phase9/run-legiwatch-phase9-job.js metrics --manual
node apps/intel-api/dist/hearing/capture/run-phase9-public-capture.js status --manual
node apps/intel-api/dist/hearing/intelligence/run-phase9-hearing-intelligence.js --manual --max-passes 1
```

### Web

```powershell
pnpm --filter @capiro/web typecheck
pnpm --filter @capiro/web test -- `
  src/pages/radar/live-hearings/live-hearings-phase9-api.test.ts `
  src/pages/radar/live-hearings/legiwatch-live-hearings-flags.test.ts `
  src/pages/radar/LegiWatchShell.test.tsx
pnpm --filter @capiro/web build
```

Then rerun the complete Live Hearings Phase 0–8 regression suite, including the
Phase 7 one-capture/Postgres proof and Phase 8 public/tenant-intelligence proof.

### Readiness audit

Read-only:

```powershell
pnpm --filter @capiro/api audit:hearing-coverage -- `
  --json `
  --evidence-source=LOCAL_FIXTURE `
  --mode=READINESS
```

Persist an audit:

```powershell
pnpm --filter @capiro/api audit:hearing-coverage -- `
  --json `
  --persist `
  --evidence-source=MIXED `
  --mode=CUTOVER_VERIFICATION
```

A non-passing audit exits with code 2 unless `--no-fail` is deliberately used.

## 16. Production proof sequence

The actual launch proof remains an operator activity after merge/deployment:

```text
official announcement
  → source observation
  → one canonical hearing
  → tenant schedule demand
  → T-60/T-15/T-2/start preflight
  → official source re-resolution
  → one global fenced capture
  → real Deepgram transcript
  → recovery gap when fault injected
  → one canonical transcript timeline
  → public insights
  → tenant relevance under RLS
  → tenant alert
  → archive
  → current verification evidence
  → blocker-free CUTOVER_VERIFICATION
```

A real current hearing must prove `LIVE_DISCOVERY`, `LIVE_RESOLUTION`,
`LIVE_CAPTURE`, and `LIVE_DEEPGRAM`. Archive or fixture capture is useful but
cannot replace that proof.

## 17. Deliberately unperformed

This implementation does not claim that the following have occurred:

- migration deployment to production;
- API, web, or intel-api deployment;
- task-definition registration in AWS;
- EventBridge rule activation;
- a current live congressional capture;
- a real Deepgram production leg;
- a seven-day shadow window;
- three consecutive production-like readiness passes;
- canary activation;
- production cutover;
- capture-all activation;
- merge of any stacked PR.

Those states are represented as durable blockers/evidence requirements rather
than being inferred or fabricated.
