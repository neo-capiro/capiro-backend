# MeriV2 World-Class Closeout — Phase 15 Ledger Addendum

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**State:** Draft, open, unmerged  
**Phase 14:** Local exact-head acceptance passed on `d87b4db1d18f4d5503dfcca751e3c36e784423bf`  
**Phase 15:** Implemented; exact-head validation pending

This ledger continues the accepted work log and prior addenda. It does not authorize merge, migration, feature activation, grants, real memory decisions, customer-data change, AWS deployment, or production rollout.

---

## Phase 15 — governed-memory administration UX

### Audit closure

Governed-memory capabilities existed across several correct server services, but administration was fragmented across files, candidate queues, version endpoints, conflict routes, grants, and background-worker evidence. There was no single server-owned read model showing the complete state of institutional memory.

An additional inherited defect routed correction/restore/contradiction candidates through generic candidate approval even though immutable-version activation already existed.

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
- projection health.

The center's detail drawer shows class, authority, scope/client, provenance, approval chain, temporal validity, confidence, legal hold, origin trace, version lineage, conflict control, transition evidence, and projection state.

### Dark rollout and fallback

The center requires:

```text
MEMORY_GOVERNANCE_CENTER=enforce
MEMORY_GOVERNANCE_LIFECYCLE=enforce
MEMORY_GOVERNANCE_ENFORCE=enforce
```

`MemoryGovernanceCenterHost` preserves the prior proposal/review queue experience while the center is off or unavailable. Standard users never receive the administration API or grant manager.

### Trust boundary

The new controller is administrator-only. Reads execute under tenant/user RLS, apply ethical-wall exclusions, and re-evaluate canonical read authorization. The browser sends no tenant, role, wall, client-scope, status, approval, legal-hold, or capability claims.

Capabilities are server-derived display hints only. Mutations reload and re-authorize the canonical subject at execution time.

### Canonical mutation ownership

Phase 15 composes, rather than replaces:

- `MemoryCandidateReviewService`;
- `GovernedMemoryCandidateService`;
- `ImmutableMemoryVersionService`;
- `MemoryConflictService`;
- `MemoryAccessGrantService`; and
- `MemoryStoreService`.

The new action service owns direct confirm, mark-stale, and second-approval transactions and delegates revoke to the canonical forget path.

### Version-candidate routing

`memory_correction`, `memory_restore`, and `memory_contradiction` candidates now route to immutable-version activation/rejection. Version rejection requires bounded evidence. The review queue displays candidate type and refreshes from the actual server result.

### Evidence and projection health

The center reads immutable transition time from `occurred_at`, not an invented timestamp. Projection health reports pending/running/completed/failed/dead-letter/superseded obligations while preserving the rule that canonical memory remains authoritative when a secondary projection fails.

### Permanent gate

`memory-governance-ci` now covers Phases 1–15. The API memory sweep automatically includes all new Phase 15 service/controller/switch tests. The web matrix adds `MemoryGovernanceCenter.test.ts` and the extended version-aware review contract.

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
