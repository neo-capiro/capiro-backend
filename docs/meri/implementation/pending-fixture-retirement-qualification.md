# Pending fixture retirement qualification

Source: cb64973bea2b3a0e1d34b80eba25809c6924f1f2.

Pending synthetic memory fixtures can now be withdrawn through the canonical proposer-only transaction while retaining the candidate, prior review records and transition audit. The internal command has no controller or DTO binding. Existing ordinary withdrawal behavior and physical deletion/reset receipts are unchanged.

The command requires the exact synthetic namespace and approved tenant identity, active proposer membership, current client access, deterministic ownership identity, unchanged payload/provenance and PostgreSQL row version. It rejects terminal, held, revised, approved, linked or otherwise enriched rows. Candidate mutation and audit creation share the canonical transaction. Readback identifies the retained terminal row and binds its audit through marker, actor and decision timestamp. It never reports physical absence; failure after the command commits is recorded as an unknown outcome.

PASS, actual exit 0:

- API production build at the source commit.
- 14 actual PostgreSQL tests through the built application service and Prisma: legacy and instance identities, retained content/history, changed-row refusals, revoked membership/client access, concurrent retirement and rollback on audit insertion failure. The owned local UUID schema was removed. This minimal schema does not qualify full migrations, RLS or shared-environment permissions.
- 33 existing withdrawal, atomicity, governance and settings tests in four suites. These ran before the final additional conservative pristine-row predicates; the final build and PostgreSQL run cover those predicates.
- 33 existing fixture contract checks, plus formatting and whitespace checks.

The first PostgreSQL run failed six new tests because its isolated operator setup omitted MEMORY_GOVERNANCE_TENANTS. The correction opts in only inside the local test process and restores the previous environment. A negative test confirms a tenant-specific cohort cannot arm the unscoped operator runtime. Runtime code never changes feature flags or widens a production cohort. Executing this command in a shared environment still requires its existing governance gates to permit that operator path.

Independent Hermes/Bedrock Kimi static review of the exact source commit: SCOPED PASS, exit 0. No concrete blocker was found. The reviewer did not execute tests. Its audit-immutability language describes the canonical writer design; these minimal-schema tests do not independently prove database immutability policies. The internal method is an additional guard, not new authorization or a LIVE permission grant.

Evidence: C:/dev/cap-meri-foundation-evidence/pending-fixture-retirement-{unit,contract}.log and corresponding exit receipts; pending-fixture-retirement-final-{build,postgres}.log and exit receipts; review-pending-fixture-retirement.jsonl and exit receipt.

## Remaining acceptance and release work

This is one pending-memory owner operation, not complete fixture reset. Approved memory requires its own canonical revocation lifecycle. Other owners, typed retirement orchestration, old/new manifest receipt binding and trusted capture validation remain open. Fresh identities alone do not isolate queries from older active records. LIVE guards remain closed; original File01 served acceptance is incomplete.

GitHub Actions currently fails before jobs start, and database recovery has not cleared migration-bearing releases. Neither GitHub-main integration nor AWS deployment is qualified by these local passes. No shared database, AWS, routing, tenant cohort or model configuration changed during qualification.
