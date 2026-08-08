# Outreach V3 Command Protocol V1

## Principle

All Phase 2 campaign mutations are strict business commands applied by deterministic Capiro code.

```text
caller
  -> strict command envelope
  -> normalize/hash
  -> authenticate + tenant/owner scope
  -> reference authorization
  -> expected-version check
  -> pure reducer
  -> immutable state version
  -> append-only events
```

A model never receives direct database mutation or send authority.

## Command envelope

```json
{
  "type": "SET_GOAL",
  "schemaVersion": 1,
  "payload": {}
}
```

Unknown envelope keys, command types, schema versions, payload keys, out-of-bound values and disallowed control characters are rejected.

## Implemented Phase 2 commands

```text
SET_GOAL
SET_OBJECTIVE
SET_TOPIC
SET_DESIRED_OUTCOME
SET_ASK
CLEAR_ASK
SET_WHY_NOW
SET_SPONSOR_SCOPE
SET_TARGET_CRITERIA
SET_DELIVERY_PATTERN
SET_PERSONALIZATION
SET_CAMPAIGN_ANGLE
SET_TONE
SET_LENGTH
RESTORE_STATE_VERSION
```

Every implemented registry entry has reducer authority. Boot/static verification fails if an implemented command lacks a reducer.

## Explicit future commands

These names are registered so later phases do not invent incompatible vocabulary, but they have **no reducer authority** in Phase 2:

```text
ADD_TARGET_REFS
REMOVE_TARGET_REFS
REJECT_TARGET_RECOMMENDATION
ACCEPT_CONTEXT_REFS
EXCLUDE_CONTEXT_REFS
SET_SENDER_REF
SET_ATTACHMENT_REFS
REQUEST_SAMPLE_GENERATION
REQUEST_FULL_GENERATION
REQUEST_SEND_REVIEW
```

Applying one returns `OUTREACH_COMMAND_FUTURE_PHASE` with bounded ownership metadata. Future commands may not silently no-op or call a provider.

There is no `SEND_EMAIL_NOW` command or equivalent direct-send command.

## Batch envelope

```json
{
  "batchId": "uuid",
  "expectedStateVersion": 7,
  "commands": []
}
```

Limits:

- `batchId` is a UUID;
- expected version is a positive integer;
- 1–20 commands;
- normalized batch <= 256 KiB.

## Atomicity

The server validates, normalizes and authorizes the **entire** batch before the first persistent state mutation. Commands reduce in array order in memory. If any command fails, no state version, current-version pointer, command event or batch-result event commits.

A changed batch creates exactly one new state version regardless of command count. A no-op batch creates no version.

## Idempotency

The normalized command batch is canonically encoded and SHA-256 hashed.

The database stores exactly one `command_batch_result` event per `(session_id, batch_id)`.

After the owner session row is locked:

```text
same batch id + same normalized hash
  -> return durable prior result with replayed=true

same batch id + different normalized hash
  -> 409 OUTREACH_COMMAND_ID_REUSE
```

Idempotency lookup intentionally precedes expected-version rejection so a response-lost retry can replay the committed result even though the campaign version has since advanced.

## Optimistic concurrency

Every new mutation targets `expectedStateVersion`.

```text
expected != current
  -> 409 OUTREACH_STATE_CONFLICT
  -> includes currentStateVersion
  -> no auto-retry
  -> no auto-merge
```

The session row lock serializes competing writers. Exactly one writer against a current version can advance it.

## Sponsor authorization

`SET_SPONSOR_SCOPE` is strict before persistence and again produces a valid Campaign Spec after reduction.

Any client references are authorized in the **same state transaction** through the Phase 1 `CapabilityAuthorizationService.authorizeClientWithinTx` boundary. Tenant, server-established client scope and ethical-wall rules therefore cannot race the state mutation.

One denied client fails a multi-client/coalition command in full. Authorized clients are not partially retained.

## Restore

`RESTORE_STATE_VERSION`:

- may reference only a version from the same owner/session;
- parses and verifies the stored state/hash;
- reauthorizes all known client references;
- copies the old state into a **new** version;
- records source version in safe event metadata;
- never rewrites the old row or rewinds the current pointer to it.

## Proposals

Proposal creation is deliberately not mutation.

Create:

- owner session only;
- exact expected state version;
- strict/normalized commands;
- durable command hash;
- source `user` in Phase 2;
- state version unchanged.

Apply:

- explicit user operation;
- pending proposal only;
- exact expected state version;
- stored command hash reverified;
- references reauthorized;
- same authoritative command engine used;
- server-owned internal command-batch UUID generated at Apply time;
- state mutation and proposal terminal stamp share one transaction;
- competing proposals against the old version become `superseded`.

A superseded proposal returns `OUTREACH_PROPOSAL_STALE` when Apply is attempted. It is never automatically rebased.

Reject:

- pending -> rejected;
- no campaign mutation.

## Error codes

Frozen Phase 2 domain errors are defined in `outreach-command-errors.ts`. Important conflict/authority codes include:

```text
OUTREACH_STATE_CONFLICT
OUTREACH_COMMAND_ID_REUSE
OUTREACH_COMMAND_INVALID
OUTREACH_COMMAND_BATCH_TOO_LARGE
OUTREACH_COMMAND_BLOCKED
OUTREACH_COMMAND_FUTURE_PHASE
OUTREACH_REFERENCE_UNAUTHORIZED
OUTREACH_PROPOSAL_STALE
OUTREACH_PROPOSAL_ALREADY_DECIDED
OUTREACH_SESSION_ARCHIVED
OUTREACH_STATE_CORRUPT
```

HTTP responses contain bounded code/details only. Operational logs do not need command payload bodies.

## Direct deterministic controls

A future UI control may invoke implemented commands directly without a model. This is intentional: the model is an optional proposal producer, not a dependency of campaign state.
