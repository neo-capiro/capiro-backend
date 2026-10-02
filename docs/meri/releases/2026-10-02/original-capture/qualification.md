# Original Meri capture prerequisites

Source `1d54ac1a95c7a2fb5184cee5af944891a0dba255` passes the integrated offline qualification. Original live
acceptance is **NOT RUN**. The already deployed repair has a separate two-tenant
smoke PASS; it does not qualify the original 75/CD/CW/M suite.

This change composes the actual canonical case01 fixture lifecycle and restart
owner, joins authenticated source/citation/trace/provider receipts, enforces a
USD3 per-conversation provider ceiling before dispatch, and makes synthetic
memory approval wait for its projection before retirement. Ordinary approvals
retain their current asynchronous behavior. The fixed configuration operator
adds only the two approved synthetic tenant IDs and fixture namespace. It preserves
the existing customer cohort, service configuration and qualified image.

## Verification

- 329 Node capture, real PostgreSQL, native Windows storage, setup, grading and
  frozen-contract assertions passed; no skips.
- 100 API assertions in nine suites and the full API typecheck passed.
- 27 configuration operator and fault assertions passed.
- Shared/core builds and build-isolation validation passed.
- 26 deterministic Promptfoo cases and the custom verifier passed with no live
  model invocation. Raw reports remain in the evidence directory; summary is here.
- Independent Hermes/Bedrock Kimi source reviews passed with actual process exit0.
  Invalid Qwen attempts and nonqualifying review attempts remain in local evidence.
- Earlier provider/orchestrator qualification, including the 1,409-test full
  orchestrator run, is retained separately. It is not counted as this final run.

Every check has an actual exit and log hash in qualification.json. The final
documentation-only archive can be joined to this tested code through
source-file-hashes.json. No Prisma schema or any of the 449 migration files changed.

## Release and live execution

Integrate through C-drive local main, then GitHub main. Attempt the exact-source
API and orchestrator Actions workflows. The already authorized native CodeBuild
fallback is available only for a fresh relevant startup_failure with zero jobs.
Use the reviewed recipes here; independently verify source, successful phases,
native runtime imports, exact migration hashes and immutable image digests.
Promote via scripts/meri-release.mjs without database migration or provider changes.
Then apply the fixed reviewed governance operator to the currently qualified API.
Web VNext remains at https://os.capiro.ai.

The packaged fixed entrypoints are meri-case01-setup and
meri-capture-provider-budget. Follow the executable recipe in
evals/meri/live-v1/fixture-provisioning/case01-execution.md. Setup plan/execute and
budget plan/install retain durable journals and compare current source/settings
fences. A post-commit setup failure requires reconciliation, never a blind rerun.
The final one-shot driver authenticates existing PAT, captures once, grades those
same saved bytes and revokes its session. No human score has been manufactured.

## Limits and remaining acceptance

Only case01 currently has the full runtime composition and authenticated admission.
The new memory-row helpers add deterministic predicates for02 and04–11; they do
not confer LIVE authority. Complete the nine-case vertical slice before the full
75, CD01–07, CW01–08, applicable memory rows and required mode/repetition variants.
Defense Chat remains excluded. The original human rubric still requires actual
human adjudication; model-assisted review must be labeled separately.

The USD3 limit is per conversation; a USD30 aggregate ledger is not implemented.
Rate evidence and token ceilings must match actual providers and cover the policy
lifetime. Unknown price/usage holds or blocks rather than inventing a cost proof.
Legacy Clio embedding is optional and is not institutional index proof. Canonical
projection uses the real governed path; the inherited Titan whole-request timeout
requires a bounded supervisor and preservation of ambiguous committed state.

Shared policy: 39590a3bfc57ce03b0411ff7912a7c8d99deb70c.
Machine map: 2026-09-30 00:21:48 UTC. No historical migration/PITR work resumes.
