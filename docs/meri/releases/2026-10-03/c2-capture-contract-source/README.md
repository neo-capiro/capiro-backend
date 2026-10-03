# C2 capture-contract source qualification

The combined source repair passed local qualification and independent code review.
Immutable image qualification and live release are pending. This archive contains
13 exact candidate source/test files across two frozen checkpoints, their retained
failing and passing runs, and the final combined Prisma/PostgreSQL rerun. No new
deployment, capture, journal mutation, fixture change or human acceptance is claimed.

The [serialization checkpoint](serialization/checkpoint.json) binds one production
finalizer change: omit absent API clock proof before signing instead of signing an
undefined field that JSON persistence removes. Missing proof remains PENDING and
BLOCKED, and an orchestrator cannot supply the API owner's proof. HMAC verification,
exact readback equality and current authority checks remain required. The same
database test bytes first failed both pending cases, then passed all four; the
earlier fixture-error run is retained. Initial qualification also passed71 focused
tests and an API build.

The [follow-on checkpoint](followup/checkpoint.json) binds five production changes.
The existing original01/14 capture permits its already registered own-pending
proposal read under the admitted tenant, actor and selected client. Current
authority is checked before and after the awaited owner read. Actual raw HTTP
observations prove this queue read used no compiler or semantic-time window.
Only complete or healthy-empty results qualify; partial, disabled, failed,
unproved, foreign, packet and citation claims remain blocked. The existing generic
logical observer may call a healthy empty proposal page complete, so the join
accepts that one-way match to independently observed empty coverage. Ordinary
proposal behavior is preserved. The readonly receipt ceiling matches the existing
qualified15M maximum, with exact current-ledger equality on readback; case46's
separate authority and all live budgets are unchanged.

| Final local boundary | Result | Evidence |
|---|---|---|
| Core receipt validators | 50 passed | [receipt](followup/core-green-v3.receipt.json) |
| API dispatch, scope, authority and readback | 149 passed | [receipt](followup/api-green-v2.receipt.json) |
| Actual loopback HTTP and orchestrator evidence | 43 passed | [receipt](followup/orchestrator-green-v3.receipt.json) |
| Existing provider and canonical owner regressions | 39 passed | [receipt](followup/provider-regressions.receipt.json) |
| Combined actual Prisma/PostgreSQL | 4 passed,0 skipped; cluster stopped | [receipt](combined-postgres/capture-receipt-clock-combined-followup-v1.receipt.json) |
| Core/API/orchestrator builds | All exit0 | [qualification](source-qualification.json) |

The [independent review record](independent-review.json) attributes both PASS
messages to `/root/benchmark_review`; it is neither a human release attestation nor
an independent review of this archive assembly. All three initial serialization
file hashes remained unchanged during follow-on work. Meaningful red runs and
intermediate compile/test failures are retained. Core red-to-green assertions are
unchanged at runtime, but the final test added TypeScript literal narrowing; the
checkpoint does not claim identical bytes for that pair. Early receipts saying
networkOrProviderCalls:0 mean no external network/providers: the orchestrator
suite deliberately uses loopback HTTP. Later receipts make that distinction.

The PostgreSQL proof uses the actual generated Prisma client, current source and
final built core in rollback-only random schemas on owned127.0.0.1:55433. It proves
storage and signature behavior, not production RLS, live fixture authority or
original acceptance. Proposal unit tests isolate existing owner/authority ports;
pre/post checks are point-in-time revalidation, not an atomic revocation lock.
No schema, model, service configuration or dependency changed. Native image and
rollout evidence remain separate requirements.

The [failed original Case01 attempt](../c2-case01-recovery-attempt/README.md)
remains CAPTURE_UNCERTAIN and must not be replayed or regraded from these tests.
The later [cost-only reconciliation](../c2-case01-terminal-cost/README.md) remains
unchanged:22 journal events, no active reservation, fresh recorded cost$12.133883
and$17.866117 remaining. Earlier checkpoint references to an active reservation
describe their recording time. This archive does not reread or mutate that journal.
Original acceptance stays0/75, CD0/7 and CW0/8; human grading remains incomplete.

[Provenance](provenance.json) maps original local evidence paths to byte-identical
copies. [The manifest](artifacts.json) hashes every archived file except itself.
Captured line endings are preserved by the local attributes file; logs need an
explicit forced add because the repository ignores them globally.
