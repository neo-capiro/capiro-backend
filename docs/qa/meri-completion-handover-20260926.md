# Meri capability/JEV completion handover

Date: 2026-09-26 (America/New_York)

## Read this first

This is the portable continuation record for `neo-capiro/capirov2`. It intentionally uses only
repository-relative paths, Git commit identities, and public GitHub URLs. It does not depend on the
machine where the work was produced.

The user asked to complete the remaining Meri capability-cleanup/JEV plan with bounded Hermes
delegation, keeping every Hermes session below 50% usage. After an earlier stop/handover, the user
explicitly resumed the goal with “do it all.” Continue dependency-ordered, dormant source work and
qualification from the remote branch tip.

Do not deploy, migrate production, activate JEV/Phase 4/shadow traffic, execute Meri prompts, or run
final production browser QA without new user authority. Deployment additionally requires an
explicit user deployment **GO**. There is one production environment and no staging environment.
The final guarded browser origin is `https://os.capiro.ai` only after an exact digest-pinned
deployment and GO.

## Checkout and authoritative checkpoint

- Repository: `neo-capiro/capirov2`
- GitHub: `https://github.com/neo-capiro/capirov2`
- Branch: `integration/meri-provisional-346-20260925`
- The remote branch tip containing this handover is the authoritative resume point.

The newest authoritative continuation document is
[`meri-capability-jev-handoff-20260926.md`](./meri-capability-jev-handoff-20260926.md). It records
the completed clarification-effect checkpoint, final qualification, the Hermes audit budget miss,
and the dependency-ordered design for memory proposal, read effects, artifact reconciliation,
signing, stable operation identity, runtime integration, JEV and Promptfoo evaluation. Read it
before using the older stop-point detail below.

After cloning or fetching, check out the branch, confirm local HEAD equals the remote branch tip, and
confirm the worktree is clean before doing anything else. Do not transfer qualification results to a
different commit.

## Work completed in the final continuation

### Exact-HEAD B1/B3/B6 database requalification

Commit `8f516b268` added the disposable qualification harness and passed:

- all 440 API migrations and invariant `440|0|f|0`;
- all 61 B3 intel migrations;
- 6 database suites / 28 tests;
- the expected Phase 4 PUBLIC-routine negative control;
- exact-container cleanup.

Evidence: [B1/B3/B6 exact-HEAD receipt](./meri-b1-b6-exact-head-requalification-20260926.md).

### Dormant recovery coordinator

Commit `b4e9f77c6` added a pure, default-off coordinator with no Nest registration, timer, database,
clock, randomness, key source, or transport. It claims bounded durable candidates, orders unknown
reservation before Stop before status, prevents overlap per instance, copies body bytes, preserves
operation/nonce identity, and records UNKNOWN rather than inventing terminal state.

Evidence: [coordinator-core receipt](./meri-phase4-recovery-coordinator-core-source-20260926.md).

### Durable-authority repository boundary — final package

Commit `6728aa4f3` added the dormant TypeScript adapter between that coordinator and a future
separately owned PostgreSQL recovery authority:

- `apps/api/src/meri/hermes/meri-hermes-phase4-recovery-obligation.repository.ts`
- `apps/api/src/meri/hermes/meri-hermes-phase4-recovery-obligation.repository.spec.ts`
- recovery verification/TypeScript project registration
- [repository source receipt](./meri-phase4-recovery-obligation-repository-source-20260926.md)

The adapter uses fixed SQL only, enforces bounded batches and canonical identity, copies authority
bytes, admits only an empty status body or exact `{}` Stop body, binds verified receipts to the exact
candidate, and restricts recorded UNKNOWN/boundary detail to fixed enums. During final review, a
real mapping defect was fixed: the boundary result `bound_worker` corresponds to the signed
reservation receipt outcome `reserved`, not `bound_worker`.

Final focused verification after that fix:

```text
pnpm --filter @capiro/api exec jest --runInBand --forceExit \
  src/meri/hermes/meri-hermes-phase4-recovery-obligation.repository.spec.ts
pnpm --filter @capiro/api exec tsc -p tsconfig.meri-phase4-recovery.json --noEmit
git diff --check
```

Result: 1 suite / 6 tests passed; TypeScript and whitespace checks passed. The complete
`verify:meri-phase4-recovery` command was then rerun on the final package and passed 13 suites /
89 tests plus the targeted TypeScript compilation.

### Durable recovery-obligation database authority

The next package implemented and disposable-database-qualified the missing PostgreSQL authority:

- FORCE-RLS obligation storage and immutable stable retry identity;
- bounded reservation/Stop/status discovery;
- database-clock `SKIP LOCKED` claims with a fresh UUID fencing token per lease;
- exact persisted signed-receipt checks before completion;
- repeated-UNKNOWN replay/reclaim handling without stranded claims;
- Stop precedence over in-flight status callbacks;
- dedicated NOLOGIN recovery operator, closed routine/table/schema authority, and no membership
  edge or runtime registration.

Evidence: [database authority receipt](./meri-phase4-recovery-obligation-database-source-20260926.md).
The final disposable rehearsal applied all 441 migrations and passed 2 database suites / 10 tests.
The full recovery package passed 14 suites / 98 tests plus targeted TypeScript compilation.

### Verified recovery-outcome application

The next package now atomically applies verified recovery receipts to authoritative run state while
remaining dormant. It adds an exact native-response display projection, applied/superseded/
unresolved provenance, late worker binding, Stop/status successor work, fresh-consumer fencing,
Stop dominance, and winner-only terminal message/event publication.

Evidence: [recovery-outcome application receipt](./meri-phase4-recovery-outcome-application-source-20260926.md).
The final disposable rehearsal applied all 442 migrations and passed 3 database suites / 18 tests.
The full recovery source package passed 15 suites / 116 tests plus targeted TypeScript compilation,
and B1/B3/B6 requalification passed 6 database suites / 28 tests.

## Hermes use and cost control

The latest bounded, read-only Hermes audit covered the recovery-outcome application package:

- model: `openai/gpt-5.6-luna`, low reasoning;
- API calls: 4;
- reported total/cache/reasoning tokens: 69,681;
- estimated cost: USD 0.01208734;
- approximate context usage: 43.6% of a 160k window;
- result: `NO BLOCKERS`;
- no edits, tests, network actions, or artifacts were authorized or produced.

The session completed and exited below the requested 50% ceiling. Any future Hermes work must keep
the same in-flight cap, use the least expensive adequate model, save the usage receipt, and stop the
session immediately after its bounded review.

## Exact stop point and next unstarted boundary

The recovery coordinator, repository, database authority, protected display projection, verified
outcome application, and transactionally local `meri_record_turn` broker-effect authority are
qualified but still dormant. They intentionally do not register a caller or scheduler. The
record-turn package uses a dedicated NOLOGIN operator, FORCE-RLS append-only operations/receipts,
stable operation IDs, exact current-authority/Stop/route binding, one budget increment and event
per effect, and independently verified Ed25519 replay. Its receipt is
[here](./meri-phase4-record-turn-broker-effect-source-20260926.md).

The next coherent package is `meri_request_clarification`, followed by memory proposal and artifact
publication. S3 must use staged/reconciled uncertainty rather than claiming exactly-once external
effects. The external signature verifier/writer and its key custody remain separately owned,
unimplemented activation prerequisites.

Trusted runtime integration comes only after the selected broker mutators are covered. Caller
credentials, default-off registration, and scheduling remain later independently reviewed
packages.

## Remaining plan after the database-authority package

### Phase 4 source and activation prerequisites

- Separately owned caller/reconciler registration and bounded schedule, still default-off.
- Broker-effect idempotency and signed effect receipts for clarification, memory proposal, artifact
  publication, and any remaining budget-consuming calls. `sealed_absent` does not prove no
  provider, broker, worker, or downstream effect occurred. The dormant `meri_record_turn` slice is
  locally qualified, but its external verifier/writer is intentionally absent.
- Default-off trusted runtime coordinator, exact-byte transport, private claim controller,
  source-qualified V2 route resolver, deterministic dispatch bearer, and module/config wiring.
- All-ingress enforcement before provider, memory, or broker effects, including MCP/background
  refresh paths.
- Key/credential custody, rotation, ownership separation, private topology, trusted mapping,
  single-writer behavior, restart/crash/retention, backup/restore, immutable image, and rollback
  qualification.

### Inventory and B1-B6 acceptance gaps

- Reconcile the 105 canonical handlers and 104 exposed schemas with the deployed runtime and prove
  per-turn permissions/availability.
- Complete factual oracles and the 23 unexecuted write cases.
- B1 ordinary-user revocation remains live-unverified because the available admin identity cannot
  prove it and the user declined new non-admin identities.
- B2 live egress/proxy canary; B3 live source controls; B4 raw-owner → model projection → displayed
  receipt chain; B5 private orchestrator hop with four reads/negative controls/rollback; B6
  attachment/entity/coverage/cleanup receipts.

These are QA/Meri-prompt/live-environment activities and were deliberately not started. Tell the
user when source implementation reaches this boundary rather than running them automatically.

### Phase 2/3 capability cleanup and JEV

- Finish remaining result envelopes/observers and the exact-final-HEAD regression matrix.
- Prove alias parity, permissions, coverage/freshness, pagination/partial semantics, and authorized
  fixtures.
- Build authoritative final-schema per-tool/per-skill eligibility; offered names alone are not
  authorization.
- Implement the executable JEV choice path only after eligibility is truthful. Preserve off-mode
  zero provider calls and ordinary-tool fallback. Keep routing off until evaluation promotion gates
  pass.

### Phase 5/6, rollout, and retirement

- Phase 5 still has zero real independently adjudicated cases; it requires at least 300 total and
  50 per promoted family with frozen splits/oracles and locked-holdout review.
- Phase 6 requires the full event/sink/key/clock/receipt/recovery/anti-fork integrity suite, a
  dedicated non-BYPASS sink identity, and at least 500 distinct representative signed actual turns.
  Keep `liveEvidenceVerified:false` and `qualified:false` until proven.
- Build immutable commit-tagged images, reconcile live digests/topology/rollback, obtain GO, deploy,
  and only then run guarded acceptance.
- Four weeks of unsampled global traffic/consumer evidence, replacement parity, and rollback proof
  are mandatory before removing V1/V2/V3 routes or aliases.
- Six scripted `QA_FAKE_999` disputed claims remain unadjudicated and require complete same-turn
  authoritative evidence.

## Repository-contained evidence map

Read the newest exact-commit receipt for the area being changed:

1. [Verified recovery-outcome application](./meri-phase4-recovery-outcome-application-source-20260926.md)
2. [`meri_record_turn` broker-effect authority](./meri-phase4-record-turn-broker-effect-source-20260926.md)
3. [Recovery-obligation database authority](./meri-phase4-recovery-obligation-database-source-20260926.md)
4. [Recovery-obligation repository](./meri-phase4-recovery-obligation-repository-source-20260926.md)
5. [Recovery coordinator core](./meri-phase4-recovery-coordinator-core-source-20260926.md)
6. [Reservation-recovery API](./meri-phase4-reservation-recovery-api-source-20260926.md)
7. [B1/B3/B6 exact-HEAD requalification](./meri-b1-b6-exact-head-requalification-20260926.md)
8. [Worker claim gate](./meri-phase4-worker-claim-gate-source-20260926.md)
9. [Recovery and worker durability](./meri-phase4-recovery-and-worker-durability-source-20260926.md)
10. [Route operator](./meri-phase4-route-operator-source-20260925.md)
11. [Claim/tool-view V2](./meri-phase4-claim-tool-view-binding-v2-source-20260925.md)
12. [Terminalization fence](./meri-phase4-terminalization-fence-source-20260926.md)

Newer dated, exact-commit evidence supersedes stale unchecked historical bullets, but never supplies
deployment authority. No production environment, browser, provider, Meri prompt, deployment, or
live QA was used in the final continuation.
