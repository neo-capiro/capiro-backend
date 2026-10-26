# Tracker and PE SES outcomes

Tracker retains its existing `NotificationLog` unique claim and `alertDigestQueue`. The PE daily script retains its existing `SyncRun` source and preferences/canary. Neither path retries an uncertain provider outcome. Both SESv2 clients use `maxAttempts: 1`.

`accepted` means SES returned a nonempty message id; it does not mean delivered. A parsed SES service rejection with a 4xx status other than 408 is `failed`. A timeout, untyped transport error, 408, 5xx or missing acceptance receipt is `outcome_unknown`. Private provider exception text is not copied into these outcomes.

## Tracker

Realtime email commits `outcome_unknown` before calling SES. The existing unique key prevents a second dispatch for every existing status. A crash or failure to save the final receipt leaves that claim unknown.

Digest drainers atomically change each existing `queued` log to `outcome_unknown` and mark its queue row consumed before provider I/O. Concurrent workers compete on the same log row; only the worker that changed it from `queued` sends that event. A non-queued historical claim, including `sending`, is never reclaimed. The queue's `flushed` flag means consumed, not delivered. A failed outcome write cannot undo either claim or consumption.

Digest groups include tenant, client, user and channel. Current email enablement, address and cadence govern each client separately. Missing/disabled/changed preferences produce `suppressed`; the global disabled flag leaves the queue untouched. Existing trigger, materiality, enqueue dedupe and SMS transport ownership remain in place.

Final email logs and manual test responses expose `accepted`, `failed` or `outcome_unknown`. The digest result and existing CLI report these counts and suppression through `TRACKER_DIGEST_OUTCOMES`, replacing the ambiguous `sent` summary. Old `sent` records are historical; there is no delivery confirmation or automatic unknown-to-queued transition.

## PE: best-effort NON-RETRY

`send-pe-alert-emails --commit` consumes a half-open `[since, run.startedAt)` window on its existing SyncRun row before preparation or sending. A short PostgreSQL advisory transaction lock serializes that boundary; no transaction spans SES. The next eligible window starts after the latest consumed boundary regardless of the prior run's success, errors or crash. The existing 48-hour cap remains. Alerts at the upper boundary belong to the next window.

The shared `runWithSyncRun` implementation is unchanged. Its generic successful watermark deliberately excludes `success_with_errors`; this mail job uses its own recorded consumed boundary instead. A small adapter captures that helper's existing run id, because its callback only exposes the generic successful watermark. A newly created row is distinguished from a consumed window so concurrent new runs do not masquerade as historical attempts.

Before each batch, recipient ordinals are persisted as unknown in `SyncRun.stats`. Each response updates the corresponding accepted/failed/unknown outcome; a receipt-write failure halts further sends. Final error counts include failed and unknown recipients, producing `success_with_errors` rather than a false all-delivered result. Recipient-level output includes the observed status. If the process dies, remaining unknown entries or the window's pre-send unknown marker are conservative evidence, not proof that every recipient was attempted.

This policy accepts omissions: a crash can discard an unattempted part of the consumed window, and definite rejections are not automatically retried. No operator should reset a consumed window or delete its claim to retry mail. There is no recipient recovery queue or claim of exactly-once delivery.

On the first upgraded run, existing legacy SyncRuns have no reconstructable upper boundary because the old query read an unbounded tail. That run consumes the historical interval without resending it. Later runs process new bounded windows. If no prior run exists, the initial `--hours` floor applies. Dry-run consumes nothing; disabled canaries still permit the existing watchlist-stamping behavior and do not create a delayed-send backlog.

CLI exit 2 means invalid/missing configuration, exit 1 means a job/receipt failure, and exit 0 includes completed best-effort batches with recipient errors, disabled runs and dry runs. Inspect SyncRun counts/outcomes; exit 0 is not a delivery receipt. `--help` and missing configuration perform no database or provider work.

No migration, new delivery ledger, schedule/flag change, Intel ownership transfer or external send is part of this source repair. Onboarding remains separate. Native PostgreSQL qualification and any approved live send belong to the release owner; synthetic tests do not prove deployed behavior.
