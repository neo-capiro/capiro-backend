# MeriV2 Phase 12 — Client-Scoped Reviewers Through Explicit Grants

## Status

**Implemented; exact-head validation pending.**

Phase 12 closes the route-level authorization mismatch that required every governed-memory reviewer to be a tenant administrator even though the canonical authorization engine already supported client-scoped grants.

## Runtime contract

### Review surface

The product review surface is:

```text
GET  /api/memory/review/candidates
POST /api/memory/review/candidates/:id/approve
POST /api/memory/review/candidates/:id/reject
```

The controller requires standard authenticated access. It does not accept tenant, role, client, ethical-wall, grant, approval, or capability facts from the browser.

The review surface is enabled only when all three server-owned controls are explicitly armed:

```text
MEMORY_CLIENT_REVIEW=enforce
MEMORY_GOVERNANCE_LIFECYCLE=enforce
MEMORY_GOVERNANCE_ENFORCE=enforce
```

`MEMORY_CLIENT_REVIEW` is the independent Phase 12 kill switch. Only the exact value `enforce` arms it; truthy-looking values remain off. When any control is off, candidate listing returns an empty disabled queue and decision mutations fail closed. Existing candidates remain pending.

### Candidate visibility

Candidate listing runs inside the authenticated tenant/user transaction. The first query reads candidate identity and scope only. For each candidate, the server:

1. loads the canonical governed authorization subject;
2. resolves the ethical wall and current grant from the database;
3. evaluates `approve` and `review` independently;
4. withholds the candidate when neither operation is allowed; and
5. fetches proposal content only after authorization succeeds.

Therefore a reviewer never receives, and the listing path does not pre-load, proposal content for another client or a client behind an unsatisfied wall.

### Decision authority

Approve and reject calls delegate to `MemoryCandidateService`. That service locks the pending candidate row, reloads server-owned authorization facts, and re-evaluates the operation in the same transaction as activation or rejection.

A browser capability is display-only. It cannot authorize execution.

### Client grant requirements

A client memory grant is usable only when all of the following are true:

- tenant, client, and user match the request context;
- status is `active`;
- expiration is present and in the future;
- reason is present and non-empty;
- the requested permission is explicitly present; and
- the ethical-wall decision independently allows the user.

Grant creation remains administrator-only. The issuer must pass the client wall, provide a bounded reason and future expiration, and target an active member of the same tenant. Replacing a grant revokes the prior row and inserts a new row in one transaction. Revocation is a status transition with actor and timestamp, never a delete, preserving grant history.

A client grant never applies to firm memory. Firm review remains administrator-only. User-private memory remains owner-only. Administrators remain subject to ethical walls.

## User experience

Settings → Memory includes an **Awaiting your review** queue. It appears only when the server returns at least one authorized candidate. Cards render only server-returned proposal content and server-derived approve/reject capabilities.

The queue is available to a standard user with a qualifying client grant without exposing administrator-only Settings tabs or grant administration.

## Regression matrix

Phase 12 tests cover:

- standard-authenticated route metadata;
- exact parsing of the independent client-review switch;
- queue dark state while any required control is off;
- standard user with client approval grant can inspect and approve;
- same user without a grant is withheld and denied;
- unauthorized proposal bodies are never fetched;
- a grant cannot bypass an ethical wall;
- only active, unexpired, reasoned grants are considered;
- a client grant cannot authorize firm memory;
- an administrator without wall access is denied;
- grant reason, expiration, recipient membership, replacement, revocation, and retained history;
- decision authorization occurs after candidate row lock and before canonical memory mutation;
- denied approval leaves the candidate pending and creates no canonical memory; and
- browser UI renders only a server-enabled nonempty queue.

## Acceptance gate

Phase 12 passes when the exact remote head proves:

- a standard user with a valid client `approve` grant can approve another user's pending candidate for that client;
- the same user cannot inspect or decide another client's candidate;
- no grant bypasses a wall, expiration, revocation, scope, or segregation-of-duties rule;
- all inherited Phase 1–11 gates remain passing; and
- PR #679 remains draft, synchronized, mergeable, and unmerged.

## Rollback

Set the dedicated surface switch off without disabling other governed-memory behavior:

```text
MEMORY_CLIENT_REVIEW=off
```

Administrators may also revoke an individual grant. Pending candidates and immutable grant/audit history remain intact. Do not hand-promote candidates or delete grant history as a rollback mechanism.

## Production boundary

This phase does not authorize migration deployment, flag activation, grant creation, candidate approval, customer-data mutation, AWS deployment, or merge to `main`.
