# Future hearing server-capture recheck

Scope: every currently stored canonical federal and Florida event whose start or calendar date is in the future, without an upper date horizon or a visibility/status exclusion. This is a database and scheduler audit, not proof that every publisher has announced or exposed all future proceedings.

## Live findings at 06:58 Eastern

The read-only snapshot at 10:58:13Z found one future event: House Ways and Means 119575, October 6 at 10:00 a.m. Eastern (9:00 a.m. Central). No future Florida rows were stored. The event is public and scheduled, but its two candidates are browser-only. It has no effective server-source permission, no automatic subscription demand and no capture job. Five pending preflight jobs are source checks, not an instruction that will bypass the source policy. The browser independently displays **Browser recording only**.

Global capture-all and Florida server-capture are enabled. The capture schedule runs every minute; retained-media work runs every two minutes; preflight planning is enabled. Actual latest capture and media completions at 10:58:29Z and 10:57:04Z respectively exited successfully with no reported errors. The zero missing-approved-schedule count has a denominator of zero approved upcoming hearings and must not be presented as universal recording coverage.

The [existing source decision](../plans/legiwatch-v2-plan.md#6-open-decisions--surfaced-not-guessed) explicitly leaves YouTube and C-SPAN extraction off pending clearance. No source permission or resolver restriction was widened during this audit. Source clearance was requested from the owner separately.

## Scheduling behavior and fixes

Capture-all supplies demand independently of an individual client's subscription. Known events enter the rolling 14-day preflight window automatically. A usable start time, recognized event type, public access and an approved server-resolvable stream remain prerequisites. Private, canceled, completed, undated and source-restricted events are not guaranteed future recordings.

Review found that actively leased recordings could fill the bounded fallback discovery batch and indefinitely crowd out a newly due event. The repair excludes unexpired owned leases before that batch is selected, while keeping expired and incomplete leases eligible for discovery. A real-PostgreSQL regression covers 12 older active recordings, four expired/incomplete lease discovery cases, and a new due hearing.

Review also found that the preflight function computed a fresh future retry deadline on each call, so a due retry could repeatedly defer itself instead of resolving a stream that became available. Retry deadlines now stay anchored to the last actual attempt. Elapsed early checkpoints resolve once; recording the attempt advances to the next future checkpoint. Simulated-clock regressions cover waiting at T−5 minutes followed by capture readiness at T−4, source-error backoff, and the 24-hour/1-hour/15-minute checkpoints. Source policy, worker ownership, terminal outcomes and grace-window limits are unchanged.

Exact source `3b8bdae760f8cd3df783c163158b18da33de410d` passed **91 suites / 1,195 tests, zero failures, skips or todos**, including the native PostgreSQL demand/lease-discovery regression and recording durability/access tests. CodeBuild `319ad87a-a935-4bf5-a1c3-42046f29879a` ran against the disposable full API+Intel migration chains and passed Intel typechecking. Focused local tests and independent review also passed. ARM64 build `c43ac121-36de-4235-a6d9-0458ba400ee7` passed compilation, capture runtime imports, FFmpeg and immutable ECR readback: `sha256:294609d7853434b68c77a340a607ba43495caa9d23399d46905d039e2983219a`. Existing build isolation and retirement controls remain intact. Guarded service promotion, image-only scheduled-worker updates and fresh live acceptance are pending.

Each scheduled capture task claims one recording, so new starts are paced by worker capacity. The schedule can overlap long-running tasks but is not a guarantee that arbitrary simultaneous hearings start recording at the exact same second.

Private backend receipts and browser evidence: `C:\dev\qa-legiwatch\capture-debrief-20261006\future-capture-recheck-20261006`.
