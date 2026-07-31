# MeriV2 Phase 13 — Withdrawal Is Not Rejection

## Status

**Implemented; exact-head validation pending.**

Phase 13 separates a proposer's decision to retract a pending memory proposal from an independent reviewer's decision to reject it.

## Canonical lifecycle contract

### Legacy candidate disposition

`memory_candidate.status` now distinguishes:

```text
withdrawn  — proposer-initiated terminal disposition
rejected   — independent reviewer terminal disposition
```

The additive migration `20260815010000_memory_candidate_withdrawal` expands the candidate status check and adds a tenant/proposer history index ordered by newest proposal. It performs no candidate or canonical memory rewrite.

### Governed lifecycle state

Both dispositions map to governed status `rejected` because neither creates canonical memory and neither is recallable. They remain distinguishable through:

- legacy candidate status;
- deciding actor;
- audit reason code;
- one-line audit reason; and
- bounded audit metadata.

Exact reason codes are:

```text
withdrawn_by_proposer
rejected_by_reviewer
```

No withdrawn or rejected proposal receives memory authority, canonical memory, a projection obligation, or an active version.

## Authorization and atomicity

### Withdrawal

Routes:

```text
GET  /api/memory/proposals
POST /api/memory/proposals/:id/withdraw
```

The controller requires standard authenticated access. The service locks the exact tenant-scoped pending candidate and confirms `proposed_by` equals the authenticated effective user. No browser-supplied proposer, tenant, role, wall, or status is trusted.

A non-proposer receives a denial. A terminal or cross-tenant candidate uses the tenant-safe pending-candidate not-found response. A second withdrawal cannot create another transition.

Withdrawal, candidate status, governed status, deciding actor/time, and transition audit commit in one tenant/user transaction.

### Reviewer rejection

All injected `MemoryCandidateService` consumers resolve to `GovernedMemoryCandidateService`. Reviewer rejection:

1. locks the pending candidate;
2. denies a shared-scope proposer before evaluating reviewer authority;
3. resolves server-owned wall, grant, role, and scope facts;
4. requires an independent authorized reviewer; and
5. writes `rejected_by_reviewer` atomically.

A proposer cannot use reviewer rejection as a withdrawal shortcut even when the proposer is an administrator or also holds a client review grant.

Approval remains the inherited atomic Phase 1 path and continues to deny shared self-approval.

## Confidentiality and bounded history

The proposer endpoint returns at most the newest 50 firm/client proposals for the authenticated proposer. Private auto-committed memories are excluded so they cannot crowd shared proposals out of the bounded history.

Client proposal content is shown only while the proposer still passes the ethical wall. If wall access is later removed, status remains visible and a pending row remains withdrawable, but proposal content is returned as redacted.

Audit evidence contains IDs, status, reason code, scope, source kind, and disposition actor only. Proposal content is never written into transition evidence.

## User experience

Settings → Memory contains two separate surfaces:

- **Your proposals** — proposer-owned shared-proposal history; pending rows show **Withdraw**, terminal rows show **Withdrawn**, **Rejected by reviewer**, or **Approved**;
- **Awaiting your review** — server-authorized reviewer rows with **Approve** and/or **Reject**.

The browser cannot convert one capability into another. A restricted client proposal displays a redacted label and remains withdrawable only while pending.

## Feature boundary

The proposer and grant-aware review surfaces remain dark unless all three controls are explicitly armed:

```text
MEMORY_CLIENT_REVIEW=enforce
MEMORY_GOVERNANCE_LIFECYCLE=enforce
MEMORY_GOVERNANCE_ENFORCE=enforce
```

The code deploy and migration do not activate the routes by themselves.

## Regression coverage

Phase 13 tests cover:

- migration status expansion without data rewrites;
- proposer history index;
- distinct helper reason codes;
- no authority for withdrawal;
- proposer withdrawal succeeds;
- another user cannot withdraw;
- proposer cannot use reviewer rejection;
- independent reviewer rejection succeeds;
- terminal candidate cannot be withdrawn twice;
- withdrawal and rejection write distinct audit evidence;
- proposal content does not enter audit evidence;
- bounded shared-proposal history distinguishes both terminal outcomes after reload;
- private candidates are excluded from the shared history query;
- walled proposal content is redacted while pending withdrawal remains available;
- standard-authenticated proposer route metadata;
- exact server-context delegation;
- proposer UI exposes Withdraw only on pending rows; and
- reviewer UI continues to expose Reject only through server-derived capabilities.

## Acceptance gate

Phase 13 passes when one exact synchronized head proves:

- proposer withdrawal writes legacy `withdrawn` and audit `withdrawn_by_proposer`;
- independent rejection writes legacy `rejected` and audit `rejected_by_reviewer`;
- neither path creates canonical memory;
- a proposer cannot invoke rejection for their own shared proposal;
- a reviewer cannot withdraw another user's proposal;
- terminal re-disposition is denied;
- visible proposal history distinguishes withdrawal from reviewer rejection;
- all inherited Phase 1–12 focused and cumulative contracts remain passing; and
- PR #679 remains draft, mergeable, synchronized, and unmerged.

## Rollback

Set:

```text
MEMORY_CLIENT_REVIEW=off
```

This hides both product surfaces and makes proposer withdrawal unavailable without altering pending or terminal rows. Existing `withdrawn` and `rejected` evidence remains immutable. Do not convert a withdrawn proposal into rejected, reopen terminal candidates, or delete audit history as rollback.

Application rollback may leave the additive status check and proposer history index in place.

## Production boundary

No migration, flag, proposal disposition, customer-data mutation, merge, or AWS deployment is authorized by this phase.
