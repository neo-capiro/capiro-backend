# WS-03 classified descendant corrections

Bounded follow-up to COORD-W1-105-20261022-02 revision1, backend #105 comment
6331549181. The current source was checked against remote `308f7854`, tree
`0482fcb8dc5ab44743bcc5feed02ab846d1959ad`; all three findings remained. This
revision changes only those existing WS-03 paths and their verification.
**Workspace deployment HOLD remains. This is a draft review update, not a ship request.**

## Changes and preserved authority

| Surface | Correction | Preserved behavior |
| --- | --- | --- |
| `DocumentsService.list` | Existing opaque `assertReadable` before minimal tenant-bound origin and full document listing | All readable roles, owner-only held drafts, current membership/client-wall/source and prospect/copy-receipt checks |
| `DocumentAgentQualityService.createFixProposal` | Existing `assertReadable`, then `canEdit`, before proposal creation | Owner/editor creation, prospect-transfer refusal, trusted controller actor, unchanged canReview accept/reject policy |
| `VersionsService.loadDraft` | Minimal parent lookup, existing role/prospect admission, then full draft/documents | canRead list, canEdit create/restore, existing403 role denial, prospect receipts and optional service signature |

No new authorization machinery, grants, endpoints, schema, SQL or dependencies.
The quality module already imports the existing CollaboratorsModule. Public
controllers supply `ctx.clerkUserId`; the generation snapshot caller supplies
`run.actorId`. The audit found no production caller omitting a version actor;
the existing optional signature remains unchanged. The only existing constructor
fixture change supplies CollaboratorsService to the quality adapter.

The collaborator-list observation is **not a demonstrated HTTP exposure**:
`CollaboratorsController.list` already checks canRead before the service call.
No collaborator-list production code was changed. The version finding was a
full-content read-order defect, not demonstrated returned version leakage.

## Verification

- Final restored canonical Workspace Jest: **480/480, nine suites, exit0**, no
  failed/pending/runtime-error suites. Includes the unchanged267-case prior HTTP
  matrix, the new97-case HTTP matrix,44 focused new cases and72 existing cases.
- New direct cases cover all five routes: document list, quality fix, and version
  list/create/restore. They cover unrelated, revoked membership/tenant/client/wall/
  collaborator/source authority, forged parent/version identities, role matrix,
  held-owner access, prospect controls/copy receipts and trusted creator identity.
- Actual frontend gateway to loopback Nest: **57/57, zero skips, exit0**, plus
  wrapper1/1. The57 comprise21 standalone forwarding cases and36 fixture-dependent
  cases. The original generic/typed-comment checks remain; the new five routes
  exercise the existing generic Workspace proxy. No frontend production changed.
- **7/7 behavioral mutants killed**,155 expected assertion failures, zero runtime
  errors. Recipes cover document admission, quality opaque admission/canEdit/
  prospect refusal, version admission, and full reads moved before role or
  prospect checks. Every production source was restored byte-exact before the
  final green run. Exact recipes, hashes and failure samples are in the JSON.
- Frontend canonical web typecheck: exit0, zero diagnostics; scoped lint: exit0.
- Cached Workspace compiler comparison: **17 identical diagnostics on prior and
  candidate, zero added/removed**. Both exit2. This is not a clean compiler/build
  pass. Missing cached pdfkit/PDFKit, supertest, sanitize-html and sharp remain.

Canonical commands use `apps/workspace/jest.config.cjs --runInBand` with existing
cached dependencies, Node heap4GiB and the prior cached NODE_PATH profile. No
private Jest config, added diagnostic suppression or changed package/lock/config.
The explicit joined runner remains outside the normal spec glob; ordinary frontend
runs visibly skip36 fixture-dependent cases without the loopback server.

The22-case version-order suite ran under `src/versions` during mutation checks,
then moved to `test/ws03-version-admission-order.spec.ts` with the same assertions
and two rebased imports so it respects the compiler rootDir. Final480 includes
that relocated suite. Initial frontend fixture inference, wrong-directory lint,
and incomplete prior-copy package-link attempts are recorded as setup corrections,
not gate passes. The final prior/candidate compiler comparison uses the same
unchanged cached auth/shared/meriv2-core package outputs and generated Prisma client.
No Prisma generation, database connection, SQL or migration command was run.

## Evidence limits and remaining gates

Real controllers/services/admission helpers run, but TenantGuard identity and
Prisma storage are synthetic. Counters cover nominated descendant reads/effects.
The existing authority lookup selects config, which may contain content: these
receipts do not prove zero content-bearing bytes in every authority query or
native absence of SQL effects. Sequential revocation tests are not concurrency
qualification. No real JWT/Clerk, browser, provider, production database or image
was exercised.

**Fable-run, unexecuted:** native PostgreSQL16/RLS, unrelated/revoked/held/forged-ID
negatives on all five routes through direct/gateway paths, source/prospect/copy
receipt controls, no rejected writes, and concurrent membership/client/collaborator
revocation. Clean frozen closure/Prisma parity, full-suite baseline parity, clean
build and exact image binding remain open. Reviewed numbered SQL/fresh clone and
migration → combined backend → frontend gates remain. Backend108 remains separately
NOT DEPLOYABLE. No merge, deploy, SQL, shipping release or email/recovery change.

## Proportional source review

The three service changes place existing authority at existing boundaries; no
new persistence owner, cross-lane import or generic authorization layer. The
expanded synthetic harness keeps its existing one-workflow fixture responsibility.
The gateway test has a size-review signal; its executing callbacks remain small,
and a long describe callback registers related scenarios using the same existing
transport/fixture helpers. This is a test-only expansion, not a production registry
or shell change. Independent read-only source review found no bounded blocker;
that review is not acceptance or native qualification.
