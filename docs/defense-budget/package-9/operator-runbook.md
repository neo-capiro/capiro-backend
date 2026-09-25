# Package 9 operator runbook

## Current operating decision

Production activation is `NO_GO`; shadow-only observation is the highest allowed stage. The scenarios in `failure-recovery-qualification.json` are protocols, not test results. No live queue drain, paid provider call, AWS mutation, or deployment is authorized by this packet. Package 0 is the governing budget source.

## Alarm policy

Page the platform lead and stop new admission when any hard limit is reached or projected to be crossed:

| Signal | Warning | Stop / page threshold |
| --- | --- | --- |
| Pending outbox rows | 80 | 100 |
| DLQ rows | 8 | 10 |
| Oldest pending age | 45 minutes | 60 minutes |
| Active drain tasks | 3 | 4; never start a fifth |
| Drain task runtime | 25 minutes | 30 minutes; terminate safely and allow lease recovery |
| Common interactive query p95 | 1,600 ms | 2,000 ms |
| Verified program update p95 | 45 minutes | 60 minutes |
| Incremental AWS annualized projection | $800 | $1,000 |
| Paid provider annual allocation/spend | Any nonzero spend without a named authorization | $500 hard cap; default allocation is $0 |

The named source owner handles source-specific delay and cursor alarms. The legislative lead owns Congress.gov/GovInfo version and watermark alarms. The model/evaluation lead owns provider timeout, throttling, attempt, and cost alarms. The platform lead owns queue, lease, drain, latency, and AWS cap alarms. The ingestion lead reconciles accepted fact IDs against immutable evidence and notification keys before any stage advancement.

Alarm delivery must be proven in an isolated qualification run before it is relied upon. A missing alarm receiver is a failed gate, not a warning waiver.

## Activation stages

1. **Stage 0 — design only:** validate manifests and ownership; no source or provider calls, no writes.
2. **Stage 1 — local fault qualification:** run deterministic source/provider stubs and crash/lease/retry tests in disposable local infrastructure. Must pass all relevant identity and alarm assertions.
3. **Stage 2 — isolated load qualification:** run the 100-item seeded workload with <=4 workers, capture raw latency, queue, and cost evidence. No production credentials or external provider spend.
4. **Stage 3 — shadow observation:** exact named manifest, source-specific owner, immutable image digest, approved read-only/shadow permissions, alarm receivers, and rollback rehearsal required. Shadow may persist append-only evidence only where already authorized; no canonical promotion or client notification.
5. **Stage 4 — bounded production activation:** remains `NO_GO` until all required scenarios pass, independent adjudication signs off, cost reports fit caps, and an explicit release authorization exists. Start with one exact bounded manifest and enforce the queue limits continuously.

Current maximum: Stage 3 shadow observation. Do not advance based on document presence or local protocol checks alone.

## Incident response and rollback

On any lost identity, duplicate logical notification, stale lease acknowledgement, source watermark gap, missing alarm, limit breach, or unaccounted cost:

1. Stop new admission and disable the affected consumer/schedule; do not purge the queue.
2. Let in-flight attempts reach a safe boundary or expire their leases. Record task/image/config identity and the exact affected source and logical IDs.
3. Reconcile accepted facts, immutable evidence identities, acknowledgements, and logical notification keys. Keep unresolved items pending or quarantined; never mark them complete to clear a queue alarm.
4. If a read projection was activated, move its active pointer back to the last qualified snapshot/version. Append a rollback event with reason and operator identity.
5. Preserve immutable evidence, source bytes, attempt history, manifests, and notification ledgers. Rollback must not delete or edit them; corrected evidence is a new version linked by supersession.
6. Resume only after the root cause is repaired and the applicable fault scenario plus identity reconciliation pass again. Production stage remains blocked until independent sign-off.

Client notifications are emitted from a stable logical idempotency key. If a notification delivery outcome is uncertain, query the durable delivery ledger by that key before retrying. Never blindly resend.

## Per-run record

Every run must retain: package/scenario ID; exact source revision and image digest; named manifest and source owners; environment; seed and identity map; provider/model lane and budget authorization; start/end time; raw metrics; alarms and acknowledgements; accepted/evidence/acknowledged/DLQ identity sets; notification-key report; before/after cost; operator; reviewer; and explicit `NOT_RUN`, `PASS`, or `FAIL` for each assertion. Use `NOT_RUN` where collection or execution did not occur.
