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

### Version-candidate routing

`memory_correction`, `memory_restore`, and `memory_contradiction` candidates now route to immutable-version activation/rejection. Version rejection requires bounded evidence. The review queue displays candidate type and refreshes from the actual server result.

### Projection retry

Failed/dead-letter outbox work is visible and retryable to an authorized operator. Retry locks the job, enforces private ownership and ethical walls, repeats item read authorization when item-backed, resets retry state transactionally, and records prior attempts, operation, subject IDs, and a bounded error code in `AuditLog`.

Pending/running jobs are idempotent. Completed/superseded jobs are not reopened. An RLS-hidden Clio subject fails closed rather than being treated as unscoped.

Canonical memory remains authoritative when a secondary projection fails.

### Accessibility and narrow-width behavior

Memory rows are operable by Enter and Space with visible focus. Tables are horizontally contained, tabs scroll, drawer width is viewport-capped, and mobile card spacing is reduced.

### Evidence

The center reads transition time from immutable `memory_transition_audit.occurred_at`, not an invented timestamp.

### Permanent gate

`memory-governance-ci` covers Phases 1–15. The API memory sweep includes all new service/controller/switch/security tests. The web matrix includes `MemoryGovernanceCenter.test.ts` and the extended version-aware review contract.

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
