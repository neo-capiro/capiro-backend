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

## Open blocker

### P2-AUD-001 — Blocking P2 — eager proposal supersession lacks event-ledger entries

**Classification:** Phase 2 defect  
**Status:** OPEN / BLOCKING

A successful state-advancing command calls `OutreachStateRepository.supersedeStaleProposals()`, which terminalizes competing pending proposals against the old version. The proposal status is correct, but the command path does not currently append a `proposal_superseded` event for each eager transition. A later attempted Apply returns the correct stale error, but a proposal that is never clicked again has no corresponding supersession event.

This conflicts with the Phase 2 audit contract: proposal lifecycle transitions must be reconstructable from the append-only event ledger without relying on a future user action.

Safe repair is already isolated in:

```text
apps/api/src/outreach-v3/persistence/outreach-proposal-supersession.ts
```

It performs the same owner/tenant/session-scoped update using `UPDATE ... RETURNING id`, returning the exact changed proposal IDs without a pre-read race or pagination cap.

Required completion:

1. authoritative command engine must call `supersedeStaleOutreachProposals(...)` instead of the count-only repository method;
2. for every returned ID, append one `proposal_superseded` event in the same session-locked transaction;
3. safe metadata only: proposal ID + `state_advanced` + resulting state version; no proposal command body;
4. proposal Apply's `excludeProposalId` must still exclude the proposal being applied;
5. the existing defensive stale-Apply path must not double-log;
6. direct command and proposal-Apply state advancement must both satisfy the audit rule;
7. make `outreach-v3-supersession-audit.spec.ts` green; do not weaken/delete the assertion.

Until this is complete:

```text
Open P0 = 0
Open P1 = 0
Blocking P2 = 1
OUTREACH_V3_PHASE2_APPROVED = NOT POSSIBLE
READY_FOR_REVISED_PHASE3 = NO
```

## Environment blocker unchanged

GitHub Actions remains `startup_failure` before job creation on both the Phase 2 PR and untouched Phase 1 base. This is separate from P2-AUD-001: fixing the code blocker does not make CI evidence green, and broken Actions does not excuse the code blocker.
