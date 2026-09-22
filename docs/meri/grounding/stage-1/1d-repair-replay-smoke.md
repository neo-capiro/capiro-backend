# Stage 1d repair replay smoke

Run from the repository root on 2026-09-22:

`pnpm --filter @capiro/meriv2-core eval:repair-replay`

Result: PASS — `MERI_REPAIR_REPLAY_OK`, fixture `repair-scenarios-v1`, 8 scenarios passed, 0 failed.

The focused executable behavior spec also covers the eight required paths: recoverable factual correction, missing transcript qualification, unrelated outage isolation, newly introduced unsupported assertion, failed-call dedupe, cancellation race protection, useful budget exhaustion, and explicit source conflict handling. Safety cases additionally reject mutating/unknown tools, map replay misses to `retrieval_failed`, and reject stale-ledger revisions.

This was an offline replay. It made no network, database, production, or application write calls. The automatic-correction rollout defaults remain `off` with empty tenant and surface enrollment, and no application module imports the repair package.
