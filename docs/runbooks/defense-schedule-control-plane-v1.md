# Defense Schedule Control Plane — Operator Runbook (v1)

**Session:** Phase 8 Session 10
**Status at authoring:** implementation complete, dark. Not activated. No
AWS resource created or modified by this session.

---

## 1. What this is, in one paragraph

`ScheduleCoordinatorService` decides which of the 14 registered official-source
adapters are due (by reading `defense_budget_watcher_adapter.next_check_at`,
a column Session 7 created and indexed but nothing before this session ever
read) and, for each due adapter, calls the existing
`DefenseBudgetLifecycleWatcher.runAdapter` — the same entrypoint the Session 7
and 8 governed CLIs already call one adapter at a time. It adds the loop and
per-adapter failure isolation around that call; it changes nothing about
leasing, backoff, discovery, classification, or persistence.

## 2. What this runbook does NOT cover

- **Activation.** Nothing in this session installs a scheduler trigger. This
  document describes what invoking `run-schedule-controller.mjs --tick
  --commit` does; it does not authorize or perform wiring an EventBridge
  rule, an ECS scheduled task, or any other mechanism that would call it on a
  timer. That is a separate, explicitly authorized deployment act.
- **NVIDIA/GPU.** Session 5's `NVIDIA_NOT_ADOPTED` decision stands untouched.
  `assertWatcherRunnableWithoutGpu` runs before any tick work, exactly as it
  already does inside every `runAdapter` call.
- **Cost.** No monetary column exists anywhere this session touches. Provider
  spend (Session 9) is tracked, if at all, via the AWS billing console, not
  here.
- **Live crawling policy.** Whether a tick's discovery is live or manifest is
  still governed entirely by `PHASE8_SESSION8_LIVE_DISCOVERY`, Session 8's
  variable, unchanged. This session does not add a second opinion about
  when to crawl live.

## 3. The governed command

```bash
cd apps/defense-api

# No database, no network, no authorization needed.
node scripts/run-schedule-controller.mjs --list-adapters

# Read-only against a real database (needs DATABASE_URL). Reports which
# adapters are due right now; calls nothing, writes nothing.
node scripts/run-schedule-controller.mjs --plan

# Full dry run: real due-state read, then runs every due adapter against the
# in-memory store and the network-free manifest discovery adapter — never
# the live crawler, regardless of PHASE8_SESSION8_LIVE_DISCOVERY. Nothing
# persists.
node scripts/run-schedule-controller.mjs --tick

# The only path that writes anything. Discovery mode follows
# PHASE8_SESSION8_LIVE_DISCOVERY, exactly as the deployed NestJS module
# would resolve it.
PHASE8_SESSION10_TICK_AUTHORIZED=true \
  node scripts/run-schedule-controller.mjs --tick --commit
```

Useful flags on `--tick`: `--now <iso>` overrides the clock (for replay or
testing against a fixed instant); `--worker-id <id>` sets the lease owner and
the tick audit's `worker_id` (defaults to `schedule-cli-<pid>`); `--tick-key
<key>` sets the tick audit's idempotency key (defaults to
`<nowIso>:<workerId>`).

## 4. Reading the output

Each `--tick` run prints one summary line and one line per adapter attempt:

```
[phase8-session10] TICK worker=... tickKey=... outcome=completed horizonBootstrapped=true
    considered=14 due=3 succeeded=2 failed=1 skippedLease=0
  ran_succeeded        hasc                             status=succeeded discovered=2 ...
  ran_failed            govinfo-bills                    <error message>
  skipped_not_due        sasc                             not due until 2028-09-01T00:00:00.000Z
```

`outcome=failed` at the summary level (not per-adapter) means the tick
machinery itself had a problem — the rolling-horizon bootstrap threw, or the
due-state read itself failed — not that an adapter failed. Check
`failure reason` on that line.

## 5. Health / staleness check

Query the audit table directly:

```sql
SELECT worker_id, tick_key, started_at, outcome, adapters_due,
       adapters_succeeded, adapters_failed, adapters_skipped_lease
  FROM defense_budget_schedule_tick
 ORDER BY started_at DESC
 LIMIT 20;
```

No recent row at all means nothing has invoked the governed command
recently — this session does not itself guarantee a tick happens on any
cadence. A recent row with `adapters_due = 0` is healthy (nothing was due
yet). A recent row with a nonzero `adapters_failed` names which adapters in
its companion `defense_budget_watcher_run` rows (join by time window and
`adapter_id`) to look at next.

## 6. If a future session activates this

Whoever does should re-verify, at minimum:

- the invoking mechanism (cron, EventBridge, ECS scheduled task) sets
  `PHASE8_SESSION10_TICK_AUTHORIZED=true` and passes `--commit` — and nothing
  else does, so this remains the single, deliberate switch;
- the invocation interval is not shorter than the shortest adapter cadence's
  in-season interval, or every tick will find nothing new due and just add
  audit rows;
- `PHASE8_SESSION8_LIVE_DISCOVERY` is set deliberately, with the same
  awareness Session 8's own runbook already documents about egress
  allowlisting for the Akamai-protected publisher hosts;
- the worker/lease-owner identity is stable across restarts of the same
  logical worker (so a redeploy does not orphan a lease unnecessarily) but
  distinct across genuinely different workers (so two real workers can be
  told apart in the audit trail).

## 7. Rollback

There is nothing to roll back at the infrastructure level: no schedule was
installed. Reverting is: stop invoking `run-schedule-controller.mjs --tick
--commit` (there is no separate deactivation switch to flip, because there
was no activation). The migration is additive (one new table); no existing
table or grant was altered, so there is no data-migration rollback either.
