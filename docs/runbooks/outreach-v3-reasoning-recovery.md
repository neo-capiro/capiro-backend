# Outreach V3 Reasoning — Recovery / Rollback Runbook

## Scope

This runbook covers Revised Outreach Phase 3 reasoning only.

It does not authorize deployment.

## Fast disable

Primary rollback control:

```text
OUTREACH_V3_REASONING_ENABLED=false
```

Expected result:

```text
reasoning routes return 404
Phase 2 deterministic state routes are unaffected
Outreach v2 is unaffected
no provider call can acquire outreach_reasoning runtime permission
```

Reasoning should be disabled before considering service or database rollback.

## Provider outage

Symptoms:

```text
OUTREACH_REASONING_PROVIDER_UNAVAILABLE
provider HTTP 408 / 429 / 5xx
timeout
credential unavailable
```

Response:

1. do not mutate Campaign Spec;
2. do not fabricate a proposal;
3. preserve Phase 2 deterministic controls;
4. return bounded retryable error;
5. record only safe failure audit metadata when possible;
6. release turn claim in `finally`.

No database recovery is normally required.

## Campaign-state drift during a turn

If Phase 2 state advances after the model inspected it:

```text
model output
→ createModelProposalWithinTx(expected old version)
→ OUTREACH_STATE_CONFLICT
→ reasoning returns retryable 409
```

Do not auto-rebase the model result.

Do not rewrite the proposal to the new version.

User retries from fresh canonical state.

## Stuck in-flight turn

Conversation rows carry:

```text
in_flight_turn_id
in_flight_started_at
```

Normal provider timeout/tool budgets are shorter than the 15-minute lease.

A new turn may reclaim a claim only after the lease is stale.

Do not manually clear a fresh claim merely because a user retries quickly.

If operational evidence proves the owning worker is dead and recovery cannot wait for the bounded lease, use an explicitly reviewed tenant/user-scoped SQL repair rather than a broad table update. Record the conversation ID, old claim ID, actor, reason, and timestamp in the incident record.

## Archive during in-flight turn

Archive may race with external provider work.

The conversation becomes archived. The running turn must not produce a committed proposal/success audit against an archived conversation.

The archived-row trigger permits only the narrow in-flight claim cleanup needed by the provider call's `finally` block. All provider/identity/continuity state remains immutable.

## Provider-state continuity failure

`provider_state` is off by default and separately gated.

If OpenAI rejects or loses a prior response reference:

1. do not treat provider state as campaign truth;
2. disable provider-state mode if necessary;
3. create a new reasoning conversation or switch later through an explicitly designed product control;
4. retain Phase 2 Campaign Spec/state untouched.

Do not copy provider conversation state into Campaign Spec.

## Capiro-managed continuity failure

Capiro-managed mode relies on visible successful turns stored in `outreach_reasoning_turns`.

If a turn is missing because its transaction failed, the corresponding model proposal must also have rolled back. Do not reconstruct a proposal from application logs.

A new turn should continue from the remaining visible transcript + current Campaign Spec.

## Tool failure / ethical wall

A capability failure is surfaced to the reasoning layer as a bounded generic tool error.

Do not:

```text
retry under broader tenant/client scope
remove the client scope
switch to a raw Prisma query
include inaccessible record identity in model-visible errors
```

Fix the owning capability or authorization configuration.

## Model produces invalid command

The gateway re-parses every command through the Phase 2 schema and accepts model proposal persistence only for Phase 2 commands whose registry status is `implemented`.

Invalid/future command:

```text
OUTREACH_REASONING_OUTPUT_INVALID
no proposal
no state mutation
```

Do not expand command authority to make the model output pass.

## Database migration rollback posture

Phase 3 migrations are additive and create only nonauthoritative reasoning storage.

Preferred rollback:

```text
reasoning flag OFF
→ service rollback if necessary
→ leave additive reasoning tables dormant
```

Do not destructively down-migrate in routine rollback.

Phase 3 conversation data can be tenant-lifecycle purged using the existing explicit `app.allow_audit_purge=on` transaction convention when an approved lifecycle operation requires deletion.

## No-hidden-reasoning incident check

If any evidence suggests hidden reasoning was persisted or logged:

1. disable Phase 3 reasoning immediately;
2. identify exact storage/log sink and affected tenant/time range;
3. do not expose the material through support/UI tooling;
4. follow Capiro security/privacy incident handling;
5. remove the persistence/logging path before re-enabling;
6. add a permanent regression.

Campaign Spec/state history must not be rewritten as part of reasoning-log cleanup.

## Recovery acceptance

Before re-enabling after a Phase 3 incident, prove:

```text
Campaign Spec/state history intact
no model-origin direct mutation
no send/generation authority
owner/tenant capability scope intact
turn claim behavior intact
reasoning routes fail closed when flag off
provider outage fallback intact
Phase 2 regression green
```
