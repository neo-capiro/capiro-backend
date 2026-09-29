# Approved fixture revocation and proposal authorization qualification

Source: a6ce34ba5cc064a6af0fb34a7baf18bf6850b62a.

The internal approved-fixture operation delegates to canonical memory revocation. It verifies exact synthetic candidate/item/projection lineage, current membership and role, content, versions, holds and governance state in the transaction. Ordinary authorization still applies; administrator status does not bypass a client wall or private ownership. Approval history remains stored. The existing audit and projection cleanup intent share the mutation transaction. No controller or DTO exposes this operation.

Actual local PostgreSQL output also reproduced a proposal authorization defect: the governed scope column's firm default allowed approval of a walled client proposal and another user's personal proposal. Authorization now reads the proposal scope used by approval, mapping personal to user_private. Before repair both negative tests failed with approved state and committed IDs; afterward both return HTTP 403 with pending state and null committed IDs. This is a reproduced service defect in an isolated schema, not evidence of a shared-environment incident.

PASS, actual exit 0:

- 25 PostgreSQL owner tests, including valid client/firm/private-owner approval and revocation; current role/wall/hold/content/version guards; audit and outbox rollback; concurrent revocation; retained candidate history; and the existing pending retirement CLI cycle.
- API production build including the scope correction.
- 58 authorization/candidate tests in six suites on the final source.
- 51 ordinary store/governance regressions on the revocation implementation before the subsequent authorization query correction. These are separate recorded scopes, not a combined final-suite claim.
- Changed source formatting and whitespace checks.
- Independent Hermes/Bedrock moonshotai.kimi-k2.5 static review: SCOPED PASS, exit 0. The reviewer did not run tests. Lead corrections: row versions are PostgreSQL xmin strings, not UUIDs; the synthetic guard runs before the existing item authorization checks, and does not replace them.

Setup failures are separate: an initial unit command named a nonexistent test file and exited 1; the corrected six-suite command passed. An initial formatter invocation used the wrong package directory; the root formatter passed. Neither setup failure is counted as green.

The PostgreSQL tests use an owned minimal local schema, actual canonical approval/store transactions and test-local governance gates. Post-commit provider/embedding dispatch is stubbed. The schema and temporary test files were removed. Full RLS, shared-environment permissions, real providers and served acceptance remain unqualified. No production flags, routing, model policy, shared database, AWS service or migrations changed.

The approved operation is not yet wired into the fixture retirement adapter, CLI state proof or trusted capture. Pending retirement remains the currently integrated operator path. Other fixture owners, original 75/CD7/CW8 and applicable memory acceptance, hosted CI, database release clearance and deployment remain open.

Evidence: C:/dev/cap-meri-foundation-evidence/candidate-approval-scope-before.log (two failing pre-fix checks); approved-fixture-revocation-final-postgres.log; approved-fixture-revocation-final-build.log; candidate-approval-scope-unit-final.log; approved-fixture-revocation-unit.log; their exit receipts; review-approved-fixture-revocation.jsonl, exit and usage receipts.
