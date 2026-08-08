# Outreach V3 Event Ledger V1

## Purpose

`outreach_events` is an ordered, append-only business audit ledger for Campaign State mutations and proposal decisions. It is not a conversation transcript and it never stores hidden chain-of-thought.

The authoritative content snapshot remains `outreach_state_versions.spec_jsonb`. Events describe **what business transition occurred**, who performed it, and which versions/hashes identify the before/after state.

## Ordering

Each session owns a monotonic positive `sequence`.

```text
UNIQUE(session_id, sequence)
```

Sequence allocation occurs while the owner session row is locked. `MAX(sequence)+1` is used only under that lock; an unlocked max+1 allocator is prohibited.

## Immutability

The database rejects `UPDATE` and `DELETE` on event rows for ordinary operation.

A narrowly scoped existing `app.allow_audit_purge=on` transaction may permit DELETE only for authorized tenant-lifecycle purge. It does not permit event UPDATE.

Runtime role grants are also narrowed to `SELECT, INSERT` for defense in depth.

## Event shape

Core identity:

```text
id
tenant_id
session_id
sequence
event_type
actor_user_id
source
created_at
```

Transition metadata:

```text
state_version_before
state_version_after
command_batch_id
command_type
payload_hash
safe_metadata_jsonb
```

`payload_jsonb` exists for bounded business-audit use but Phase 2 mutation paths do not need to duplicate full Campaign Spec or proposal command bodies into operational events.

## Sources

Database vocabulary:

```text
user_control
user_proposal
future_model
system
```

Phase 2 public APIs never trust a browser-supplied source. Direct commands are `user_control`; proposal actions are `user_proposal`. `future_model` exists only as reserved audit vocabulary for later phases.

## Phase 2 event families

Current services may emit:

```text
session_created
session_archived
command_applied
command_batch_result
proposal_created
proposal_applied
proposal_rejected
proposal_superseded
```

No generic public “append arbitrary event” route exists.

## Durable batch result

Exactly one `command_batch_result` event carries a non-null `command_batch_id` for a direct/internal command-engine batch.

The database partial unique index:

```text
UNIQUE(session_id, command_batch_id) WHERE command_batch_id IS NOT NULL
```

turns that result into the durable idempotency record.

The event stores:

- normalized batch SHA-256 as `payload_hash`;
- result status;
- resulting state version;
- resulting spec hash;
- changed/no-change flag;
- command count.

A retry with the same batch ID must match `payload_hash` before the prior result is replayed.

## Safe observability / audit metadata

Permitted event/log metadata includes:

```text
service
release SHA
operation
session id
state version
command type
batch id
proposal id
result status
conflict code
duration
hashes
counts
```

Do not duplicate into the ledger/log dimensions:

```text
goal text
objective
ask text
why-now text
campaign angle
full Campaign Spec
proposal command bodies
client names
target names or emails
context bodies
hidden model reasoning
```

## SOC 2 reconstruction

For every mutation, the database can reconstruct:

```text
actor
tenant
session
batch/proposal identity
command type(s)
before version/hash
after version/hash
timestamp
result
```

The full authoritative content is reconstructed by joining the referenced immutable state version rather than by logging duplicate sensitive text.

## Proposal audit

Proposal creation, Apply, reject and supersession each produce an event. Proposal commands themselves remain in the owner/tenant-scoped proposal row and are hash-bound; events carry proposal IDs/counts/hashes and terminal result metadata.

## Recovery

Event history is never edited to make a rollback look as if later work did not happen. A restore is a new command/new state version and therefore produces new ledger entries while preserving the original sequence.
