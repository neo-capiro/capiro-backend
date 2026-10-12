# Initial independent ordered-owner review

Reviewed the uncommitted author working source in `/workspace/capirov2-ordered-owners`, based on main `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. This is not an exact-ref approval. A source snapshot and SHA-256 manifest are in `initial-working-source/`. No source implementation was edited; no migration, SQL/database, provider call, build, or regression test was executed.

## Findings sent to author

1. **Authorization after a blocking lock:** `requireOwnerClient()` obtains the actor role before waiting for the client `FOR UPDATE` lock. An actor deactivated, demoted or remapped during that wait can continue using the previous role. Recheck current actor authority after acquiring the lock, or hold the relevant authorization rows consistently. Exercise ordered read/write, legacy write and team delegation.
2. **Wall authorization after member-lock wait:** the wall decision precedes requested-member `FOR SHARE`. `ClientsService.setMemoryAccess()` can delete the actor grant without updating the client row when `memoryWall` stays true. Recheck the wall after potentially blocking member locks, or lock the relevant authorization rows, before mutation/receipt.
3. **Deferred trigger misses the old source client on row moves:** `check_client_ordered_owners()` checks only NEW tenant/client on UPDATE. Moving rank 2 from client A `[1,2,3]` to B `[1]` can leave A `[1,3]` while B passes. Reject tenant/client identity moves or validate both affected clients. No HTTP path moves rows directly; this is a database-integrity source defect in the advertised direct-write guard. Native execution remains prohibited/unqualified.

## Supported design aspects

One canonical ordered-owner service and shared client row lock; strict bounded replacement and explicit version; legacy zero/one owner compatibility plus multi-owner conflict/no-op; no membership or ethical-wall grant on assignment; historical inactive ranks retained without promotion; general team roles retained; explicit hard-user deletion restriction and client deletion cascade; tenant/client composite FK, forced RLS and ordinary invoker-rights deferred consistency guard.

## Next review

Await the author exact source commit before creating a separate reviewer worktree and adversarial synthetic tests. Heavy compiles must remain serialized. SQL/migrations must not execute, including against an ephemeral database.

Snapshot provenance clarification: the author was concurrently repairing when the working-source snapshot was captured. The saved access helper already includes the actor-lock fix but not the wall-grant lock; it is a partial-repair snapshot, not a complete pre-fix source revision. The original findings remain the independently observed initial review conclusions.
