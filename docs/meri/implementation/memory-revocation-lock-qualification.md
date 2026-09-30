# Memory revocation transaction qualification

Source: f097ff4a8d9f356d7f43670a97bba1f5b081b69b.

MemoryStoreService.forgetMemory previously read the item without locking it. In an actual local PostgreSQL contention test, a competing legal-hold transaction committed after that read; revocation still returned success, persisted status=revoked with legal_hold=true, removed the clio/embedding projections and wrote an audit. A competing revocation also allowed the losing request to return success and perform cleanup/auditing. The baseline exits 1 with two failed contention checks and two passing ordinary/rollback checks.

The read now uses FOR UPDATE before the existing mutation and governance checks. A competing hold that commits first is re-read and refused. A competing revocation that commits first causes the pending predicate to return no row, so the loser performs no cleanup or audit. The change is one SQL locking clause; ordinary authorization, lifecycle switches, canonical history retention and projection cleanup are unchanged.

PASS, actual exit 0:

- API production build.
- 51 existing tests across memory-store mutation/governance, memory verbs and governance actions.
- Four actual PostgreSQL tests calling the built store through Prisma: concurrent hold, concurrent revocation, ordinary retained-row/removed-projection behavior and rollback when audit insertion fails. The contention checks observe a real PostgreSQL backend Lock wait. Owned UUID schema cleanup is confirmed.

These database tests supply an actor context and minimal isolated schema with the existing governance switches disabled. They establish the unconditional revocation locking behavior, not full RLS, governed grants, migration compatibility or shared-environment acceptance. They do not prove global deadlock freedom. Legacy unit-test embedder warnings remain separate from provider qualification.

Independent Hermes/Bedrock Kimi static review of the exact source: SCOPED PASS, exit 0. The reviewer did not execute tests. The first review process exited 0 but returned a plan and literal pseudo tool call; that output remains invalid and was replaced by the concrete final review. Lead acceptance is limited to this row-lock repair and the stated evidence scopes.

Evidence under C:/dev/cap-meri-foundation-evidence: memory-revocation-lock-before.log and exit receipt; memory-revocation-lock-final-postgres.log and exit receipt; memory-revocation-lock-{build,unit}.log and exit receipts; review-memory-revocation-lock-final.jsonl and exit receipt. No shared database, external provider sink, routing, feature flag or AWS state changed during these checks.

## Approved-fixture continuation

The existing owner path is MemoryGovernanceActionService.revoke → MemoryStoreService.forgetMemory. It retains memory_items, removes clio/embedding projections, and, when governance is armed, records the canonical transition and durable cleanup intent. It relies on the server tenant context; a fixture adapter must not synthesize administrator authority or bypass current grants.

This repair does not add an approved-fixture retirement command. Reuse still needs atomic exact candidate/item/ownership/content/version guards, current actor authority, hold checks and retained-history evidence. Pending-candidate withdrawal must never be used for approved/committed memory. The rejected Qwen audit incorrectly claimed the existing committed-memory null guards were absent and conflated withdrawal metadata with approval; none of that output was adopted.
