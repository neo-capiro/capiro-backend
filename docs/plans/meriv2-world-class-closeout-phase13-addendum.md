# MeriV2 World-Class Closeout — Phase 13 Ledger Addendum

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**State:** Draft, open, unmerged  
**Phase 12:** Focused local acceptance passed on `104d7dcdbb7502c8fdbf9e3befc374cef136954a`  
**Phase 13:** Implemented; exact-head validation pending

This ledger continues the accepted work log and prior addenda. It does not authorize merge, migration, feature activation, candidate disposition, customer-data change, AWS deployment, or production rollout.

---

## Phase 13 — proposer withdrawal and reviewer rejection

### Audit closure

The inherited candidate lifecycle used reviewer rejection as the only non-approval terminal path. That conflated a proposer retracting their own shared proposal with an independent reviewer declining it.

### Implemented disposition boundary

The runtime candidate provider is now `GovernedMemoryCandidateService`, exposed through the existing `MemoryCandidateService` token. Approval remains on the inherited atomic activation path. Terminal non-approval paths are separated:

- proposer `withdraw` → legacy status `withdrawn`;
- independent reviewer `reject` → legacy status `rejected`.

Both map to governed terminal status `rejected` and create no canonical memory. Immutable transition evidence uses distinct reason codes:

- `withdrawn_by_proposer`;
- `rejected_by_reviewer`.

### Additive database change

Migration:

```text
20260815010000_memory_candidate_withdrawal
```

It:

- expands the candidate status check to permit `withdrawn`;
- adds a tenant/proposer history index ordered by newest proposal;
- does not update existing candidates;
- does not update canonical memory; and
- leaves governed status vocabulary unchanged.

### Authorization and confidentiality

The proposer route is standard authenticated access but is owner-scoped under a pending-row lock. A different user cannot withdraw. A shared proposer cannot invoke reviewer rejection, even when the proposer has administrative or explicit client-review authority.

Reviewer rejection continues to resolve role, scope, ethical-wall, current grant, expiration, revocation, and segregation-of-duties facts on the server inside the deciding transaction.

The proposer surface returns at most the newest 50 firm/client proposals for the authenticated proposer. Private auto-committed candidates are excluded. Client proposal content is redacted if the proposer no longer passes the wall, but a pending row remains withdrawable because withdrawal removes no active truth and reveals no protected content.

### Product experience

Settings → Memory now separates:

- **Your proposals** — bounded shared-proposal history; pending rows expose **Withdraw**, while terminal rows display **Withdrawn**, **Rejected by reviewer**, or **Approved**;
- **Awaiting your review** — server-derived **Approve** and **Reject** actions for authorized reviewers.

The browser receives no authority to reinterpret one action as the other.

### Permanent gate

`memory-governance-ci` now covers Phases 1–13 and includes:

- clean replay of the withdrawal migration;
- the migration contract suite;
- all memory tests, including transaction-level withdrawal/rejection tests;
- proposer and reviewer controller contracts;
- proposer and reviewer web contracts, including distinct disposition history labels; and
- every inherited Phase 1–12 typecheck, migration, worker, backfill, policy, context, Workspace, and web gate.

Detailed Phase 13 acceptance contract:

```text
docs/qa/meriv2-phase-13-withdrawal-vs-rejection.md
```

### Rollback

Set `MEMORY_CLIENT_REVIEW=off`. Both product surfaces become unavailable while pending and terminal candidate rows and transition evidence remain intact. Leave the additive schema in place. Do not reopen, relabel, delete, or hand-promote terminal candidates.

---

## Current gate

Phase 13 is not accepted until focused exact-head validation passes and the branch is reconfirmed synchronized, clean, draft, mergeable, and unmerged. GitHub-hosted replication remains blocked by the orphan `BuildFailed` Actions identity.

Phase 14 has not started.
