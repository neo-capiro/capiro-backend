# MeriV2 World-Class Closeout — Phase 12 Ledger Addendum

**Repository:** `neo-capiro/capirov2`  
**Branch:** `agent/meriv2-world-class-closeout`  
**PR:** `#679`  
**State:** Draft, open, unmerged  
**Accepted baseline:** Phases 0–9 on GitHub-hosted gates; Phase 11 on exact-head local/disposable PostgreSQL evidence  
**Phase 10:** Implemented; GitHub-hosted acceptance blocked by repository Actions control-plane failure  
**Phase 12:** Focused local acceptance passed on `104d7dcdbb7502c8fdbf9e3befc374cef136954a`

This ledger continues the accepted work log and the Phases 10–11 addendum. It does not authorize merge, migration, flag activation, grant creation, candidate review, customer-data changes, AWS deployment, or production rollout.

---

## Phase 12 — explicit client-scoped reviewers

### Audit closure

The canonical authorization engine already understood `memory_access_grant`, but the only public candidate review routes required `user_admin`. A normal client lead could therefore never use the scoped authority the database and service represented.

### Implemented review boundary

Phase 12 adds a separate standard-authenticated product surface:

```text
GET  /api/memory/review/candidates
POST /api/memory/review/candidates/:id/approve
POST /api/memory/review/candidates/:id/reject
```

The route accepts no browser authority facts. `MemoryCandidateReviewService` resolves visibility and capabilities through `MemoryAuthorizationService`, and `MemoryCandidateService` repeats the decision while holding the candidate row lock in the atomic activation/rejection transaction.

The surface is fail-closed unless all three controls are explicitly armed:

```text
MEMORY_CLIENT_REVIEW=enforce
MEMORY_GOVERNANCE_LIFECYCLE=enforce
MEMORY_GOVERNANCE_ENFORCE=enforce
```

`MEMORY_CLIENT_REVIEW` is an independent Phase 12 kill switch and defaults off. Existing administrator compatibility routes remain available for the inherited dark-mode behavior; the product queue uses the new scope-aware surface.

### Confidentiality and scope

The initial queue query reads candidate identity and scope only. Proposal content is fetched only after the server permits `approve` or `review` for that exact candidate. A denied candidate is omitted without loading its body into the review-list path.

Client authorization requires both:

- a passing ethical-wall decision; and
- an active, unexpired, reasoned grant containing the exact operation.

Client grants do not authorize firm memory. Firm review remains administrator-only. Private memory remains owner-only. Administrators are not an ethical-wall bypass.

### Grant lifecycle

Grant administration remains administrator-only. Creation now requires:

- validated explicit permissions;
- a non-empty bounded reason;
- a future expiration;
- an active recipient membership in the same tenant; and
- issuer access through the client ethical wall.

Replacement revokes the prior active row and inserts the new row transactionally. Revocation records actor and timestamp. Rows are never deleted, preserving issuer, reason, permissions, expiration, creation, replacement, and revocation history.

### User experience

Settings → Memory contains an **Awaiting your review** queue. It renders only when the server enables review and returns at least one authorized proposal. The UI uses server-derived approve/reject capabilities and cannot widen scope.

### Regression coverage

Phase 12 adds or extends tests for:

- standard-user route access;
- exact client-review switch parsing and dark-state behavior;
- grant-scoped list visibility;
- no pre-authorization payload fetch;
- approve/reject delegation with server context;
- standard-user approval under the candidate lock;
- denied approval with zero canonical mutation;
- no grant, wall denial, expired/revoked filtering;
- client grant versus firm scope;
- admin wall denial;
- required grant reason, expiration, active membership, retained history, and idempotent revocation; and
- review queue rendering and capability separation.

### Exact-head acceptance evidence

The focused Phase 12 gate passed after one style-only Prettier repair:

- exact head: `104d7dcdbb7502c8fdbf9e3befc374cef136954a`;
- API typecheck: pass;
- web typecheck: pass;
- API matrix: 9 suites, 69 tests, all pass;
- web contract: 1 file, 3 tests, all pass;
- Prettier: pass;
- `git diff --check`: pass;
- working tree: clean.

Operator log: `C:\Users\neoma\phase12-focused-validation.log`.

The permanent `memory-governance-ci` matrix includes Phase 12. GitHub-hosted replication remains blocked by the deleted synthetic `BuildFailed` identity.

Detailed acceptance contract: `docs/qa/meriv2-phase-12-client-review-grants.md`.

### Rollback

Set `MEMORY_CLIENT_REVIEW=off` or revoke an individual client grant. This disables only the grant-scoped queue and decision routes while leaving other governed-memory behavior unchanged. Pending candidates and grant/audit history remain intact.

Do not delete grants, hand-promote candidates, or overwrite later memory versions as rollback.

---

## Current gate

Phase 13 implementation is recorded separately in `docs/plans/meriv2-world-class-closeout-phase13-addendum.md`. PR #679 must remain draft and unmerged. No production or shared-environment operation occurred during Phase 12.
