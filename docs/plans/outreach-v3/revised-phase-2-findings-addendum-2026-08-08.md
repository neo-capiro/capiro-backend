# Revised Outreach Phase 2 — Hostile Review Findings Addendum

Date: 2026-08-08

This addendum records findings discovered after `revised-phase-2-findings-ledger.v1.json` was last updated. It is authoritative until those entries are folded into the JSON ledger.

## Fixed

### P2-DB-002 — P1 — session/proposal deletion was not trigger-bound

**Classification:** Phase 2 defect  
**Status:** FIXED

`REVOKE DELETE` was only defense in depth because Capiro's runtime database role may inherit table-owner capabilities. State versions/events already had binding append-only triggers, but sessions/proposals could rely on grants for retention.

Repair:

- `reject_outreach_v3_delete()`;
- `outreach_sessions_delete_protected`;
- `outreach_command_proposals_delete_protected`;
- deletion permitted only under transaction-local `app.allow_audit_purge=on`;
- disposable real-DB delete-protection rehearsal attacks deletes through a system/bypass transaction and then proves the explicit audit-purge exception.

### P2-API-001 — P2 — malformed strict command input could surface as 500

**Classification:** Phase 2 defect  
**Status:** FIXED

Raw Zod failures from public command/batch parsing were outside `OutreachCommandError`, while the Phase 2 HTTP filter maps the domain error. Invalid caller input could therefore escape the frozen bounded 4xx command contract.

Repair:

- malformed command/batch shapes now map to `OUTREACH_COMMAND_INVALID` / HTTP 400;
- domain size errors remain `OUTREACH_COMMAND_BATCH_TOO_LARGE` / HTTP 413;
- public-boundary regression suite added.

### P2-CMD-003 — P2 — proposals lacked the direct-batch size ceiling

**Classification:** Phase 2 defect  
**Status:** FIXED

Proposal creation enforced command count and individual field bounds but did not enforce the normalized 256 KiB command-list ceiling used by direct command batches.

Repair:

- proposal commands are normalized first;
- canonical normalized bytes are measured before any tenant transaction opens;
- oversized proposal returns `OUTREACH_COMMAND_BATCH_TOO_LARGE` / 413.

### P2-INT-002 — P2 — prelocked internal session identity was trusted implicitly

**Classification:** Phase 2 defect  
**Status:** FIXED

`applyBatchWithinTx()` accepted an optional prelocked session for proposal Apply and assumed it matched the requested session/tenant/owner.

Repair:

- explicit `session.id`, `tenantId`, and `createdByUserId` scope assertion before idempotency/state access;
- mismatch fails closed as `OUTREACH_STATE_CORRUPT`;
- dedicated internal-boundary regression suite added.

### P2-AUD-001 — Blocking P2 — eager proposal supersession lacked event-ledger entries

**Classification:** Phase 2 defect  
**Status:** FIXED

A successful state-advancing command terminalizes competing pending proposals against the old version. The initial implementation updated proposal status but did not guarantee a matching append-only `proposal_superseded` event for every eager transition.

Repair:

- `supersedeStaleOutreachProposals(...)` performs the owner/tenant/session-scoped terminal transition with one `UPDATE ... RETURNING` statement;
- the returned rows include `id` and `expectedStateVersion`, so there is no pre-read race or pagination cap;
- `OutreachAuditedStateRepository` is wired as the `OutreachStateRepository` provider for the V3 state module;
- it appends one `proposal_superseded` event for every exact returned proposal row in the same transaction;
- event metadata contains only proposal ID, expected/resulting state versions and `state_advanced` reason—never proposal command content;
- proposal Apply's `excludeProposalId` is preserved by the exact-returning helper;
- zero returned rows produce zero events;
- `outreach-v3-supersession-audit.spec.ts` now verifies the exact-returning helper and audited event path;
- `outreach-audited-state.repository.spec.ts` verifies one event per returned transition;
- both tests are included in `verify:outreach-v3-phase-2`.

Current code-review finding state:

```text
Open P0 = 0
Open P1 = 0
Blocking P2 = 0
```

This closes the known code blocker. It does **not** manufacture executable acceptance evidence.

## Environment blocker unchanged

GitHub Actions remains `startup_failure` before job creation on both the Phase 2 PR and untouched Phase 1 base. This is separate from the fixed code findings.

Until real executable gates and independent validation run:

```text
OUTREACH_V3_PHASE2_APPROVED = NOT YET
READY_FOR_REVISED_PHASE3 = NO
```
