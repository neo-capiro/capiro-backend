# MeriV2 World-Class Closeout — Phase 15 Ledger Addendum

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**State:** Draft, open, unmerged  
**Phase 14:** Local exact-head acceptance passed on `d87b4db1d18f4d5503dfcca751e3c36e784423bf`  
**Phase 15:** Implemented; exact-head focused and cumulative validation pending

This ledger continues the accepted work log and prior addenda. It does not authorize merge, migration, feature activation, grants, real memory decisions, customer-data change, AWS deployment, or production rollout.

---

## Phase 15 — governed-memory administration UX

### Audit closure

Governed-memory capabilities existed across several correct server services, but administration was fragmented across files, candidate queues, version endpoints, conflict routes, grants, and background-worker evidence. There was no single server-owned read model showing the complete state of institutional memory.

An inherited defect also routed correction/restore/contradiction candidates through generic candidate approval even though immutable-version activation already existed.

The Phase 15 action-by-action audit additionally found and closed four release-boundary defects:

1. The Governance Center sent correction text as `content` while the immutable API required `newContent`.
2. Immutable version responses exposed `status` while Governance Center success copy inspected `outcome`, allowing a pending proposal to look completed.
3. Conflict authorization ran before the mutation transaction and the conflict group was not row-locked.
4. Withdrawal and immutable review decisions did not refresh or describe the Governance Center state precisely enough.

### Implemented center

Settings → Memory now has a dark administrator-only Governance Center with:

- overview;
- active memory;
- pending review and proposer withdrawal;
- conflicts;
- review-due/stale memory;
- revoked/superseded history;
- access grants;
- transition history; and
- projection health with authorized retry.

The detail drawer shows class, authority, scope/client, provenance, approval chain, temporal validity, confidence, legal hold, retention, origin trace, version lineage, conflict control, transition evidence, and projection state.

### Dark rollout and fallback

The center requires:

```text
MEMORY_GOVERNANCE_CENTER=enforce
MEMORY_GOVERNANCE_LIFECYCLE=enforce
MEMORY_GOVERNANCE_ENFORCE=enforce
```

`MemoryGovernanceCenterHost` preserves the prior proposal/review queues while the center is off or unavailable. Standard users never receive the administration API or grant manager.

### Trust boundary

The controller is administrator-only. Reads execute under tenant/user RLS, apply ethical-wall exclusions, re-evaluate canonical authorization, and explicitly exclude another user's private item, candidate, transition, Clio-memory, and projection identities.

The browser sends no tenant, role, wall, client-scope, status, approval, legal-hold, or capability claims. Capabilities are display hints only; mutations reload and re-authorize the canonical subject.

### Canonical mutation ownership

Phase 15 composes, rather than replaces:

- `MemoryCandidateReviewService`;
- `GovernedMemoryCandidateService`;
- `ImmutableMemoryVersionService`;
- `MemoryConflictService`;
- `MemoryAccessGrantService`; and
- `MemoryStoreService`.

The new action service owns direct confirm, mark-stale, independent second-approval, and projection-retry transactions. Revoke delegates to the canonical forget path.

Conflict resolution now locks the complete group in stable ID order, repeats canonical authorization for every touched member under the locks, verifies both update counts, and writes every resolution audit row in the same transaction. A denied group member or concurrent membership drift rolls the operation back.

### Version-candidate routing and request contract

`memory_correction`, `memory_restore`, and `memory_contradiction` candidates route to immutable-version activation/rejection. Version rejection requires bounded evidence.

The immutable controller accepts the canonical `newContent` field and the Governance Center `content` alias, while preserving `newContent` precedence. It emits controlled outcomes for successful requests and explicit HTTP errors for missing or legal-held items.

The review queue displays candidate type and presents the actual server result: activation, duplicate confirmation, conflict creation, or rejection. It does not predict generic approval.

A successful proposer withdrawal refreshes proposal history, review queues, Governance Center overview counts, and transition history.

### Projection retry

Failed/dead-letter outbox work is visible and retryable to an authorized operator. Retry locks the job, enforces private ownership and ethical walls, repeats item read authorization when item-backed, resets retry state transactionally, and records prior attempts, operation, subject IDs, and a bounded error code in `AuditLog`.

Pending/running jobs are idempotent. Completed/superseded jobs are not reopened. An RLS-hidden Clio subject fails closed rather than being treated as unscoped.

Canonical memory remains authoritative when a secondary projection fails.

### Accessibility and narrow-width behavior

Memory rows are operable by Enter and Space with visible focus. Tables are horizontally contained, tabs scroll, drawer width is viewport-capped, and mobile card spacing is reduced.

### Evidence

The center reads transition time from immutable `memory_transition_audit.occurred_at`, not an invented timestamp.

### Permanent gate

`memory-governance-ci` covers Phases 1–15. The API memory sweep includes all new service/controller/switch/security tests, including the immutable controller and conflict transaction regressions. The web matrix includes `MemoryGovernanceCenter.test.ts`, proposer history, and the extended version-aware review contract.

Detailed contract:

```text
docs/qa/meriv2-phase-15-memory-governance-center.md
```

### Rollback

Set `MEMORY_GOVERNANCE_CENTER=off`. The prior queues return immediately. No data or schema rollback is required. Do not mutate memory, candidates, grants, conflicts, transition evidence, or projection jobs as a UI rollback.

---

## Current gate

Phase 15 is not accepted until focused and cumulative validation pass on one exact synchronized head and the administrator UI checklist is completed.

GitHub-hosted replication remains separately blocked by the deleted synthetic `BuildFailed` Actions identity.

Phase 16 has not started.
