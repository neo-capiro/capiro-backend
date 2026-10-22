# A1 Workspace: WS-02, WS-03, WS-04 and X-04

Feature flags remain off. No auth/session implementation, Meri, Actions, AWS or deployed data was changed.

**Current policy: Neo approved the Workspace revisions on 2026-10-21 and directed removal of the Workspace approval workflow.** The revised bounded removal list is recorded in meri-greenfield issue 202, comment 6328316642 (mirrored on backend #105 and frontend #117). These decisions authorize draft implementation, not activation, migration execution, merge or deployment. The supplied standing rules have been reviewed; remaining qualification gates stay open.

| Boundary | Approved implementation |
|---|---|
| WS-02 reads and signed files | Owner-only, with current active membership and active client-wall admission. Recheck that same admission when serving an already-issued signed PDF URL. |
| WS-03 sharing | Only the owner creates/revokes public shares. Shares require and serve the exact saved revision, recheck the issuer on public reads/comments, and cannot reuse an idempotency receipt across revisions. |
| Workspace approvals | Removed: service, routes, DTOs, policy enforcement and approval-only helpers. Stored approval data remains untouched, with retained Prisma declarations. Meri, release, Portfolio and Outreach sender approvals are outside this removal. |
| WS-04 recovery | A legacy name-only ordinary draft is readable/editable only by its active owner and is marked held. It cannot enter client-scoped lists, sharing or staging until explicit UUID binding passes current client-wall admission. |
| WS-04 backfill | Prepare an unexecuted proposal for provably unique active, non-archived, same-tenant name matches. Keep unmatched, ambiguous and archived matches held. Binding is immutable; old versions retain their attribution. |

## Behavior and policy

- Hill Day reads and writes are owner-only. The shared admission helper validates the document ID, exact tenant and owner, then reloads active membership and the sponsor's active client wall. It runs on library rows, document/quality/context/resolution reads, job/event reads, edits, generation/refine and export. Jobs recheck before each generation unit. Export rechecks before ready storage, signed URL issuance and signed file delivery.
- Membership reads use the existing scoped `PrismaService.withSystem` reader because shared identity tables force RLS. Client queries run under the tenant GUC and retain tenant predicates. A missing, archived or walled client fails closed.
- An issued Hill Day file URL still requires a valid signature and expiry, then uses the stored tenant and issuing actor to recheck document admission. Wall revocation, removed membership or loss of ownership produces an opaque 404 before serving bytes.
- Ordinary share creation/revocation requires the owner role. Read/list uses current collaborator and source admission. Workspace has no approval request/decision/preflight workflow; legacy blueprint approval keys are ignored without rewriting stored configurations.
- Shares require an explicit saved version belonging to the exact tenant and draft. Release compares canonical saved/live content with no timestamp tolerance. A reused idempotency receipt for another version is rejected. Existing notes/label idempotency storage is preserved; this change does not introduce a new durable idempotency platform.
- Public draft links remain pinned to their frozen version, including after live edits. Public reads and guest comments recheck the issuing owner's current source/client authority. Losing that authority revokes use of the grant. Held legacy drafts cannot be shared or staged.
- Ordinary drafts persist nullable typed `clientId` and snapshot `config.clientId`. Client names are presentation only. Owner creation and explicit association validate the current active client/wall and persist its canonical name. Bound association is immutable; source-bound/prospect drafts cannot be converted by this path. Firm/null drafts remain supported. Name-only legacy rows remain owner-accessible with `clientAssociation: held`; collaborators and client filters cannot expose them. Inconsistent JSON/column associations still fail closed. The owner may explicitly associate an ordinary legacy null row through the existing UUID and wall checks; editing the display name cannot escape the held state. Old versions retain their original attribution and cannot restore over a different client binding.

## Schema/deployment gate

`ws04-client-association.sql` is an **unnumbered proposal**, not an applied migration. Fable owns migration numbering, snapshot, review and apply. Add the nullable column/index before deploying the Workspace build and regenerate Prisma. Do not enable staging/share consumers until live negative checks pass. `ws04-unique-client-backfill.sql` is a separate unexecuted proposal: it binds only provably unique same-tenant active/non-archived clients and updates the typed UUID and JSON UUID together. No approval table/column drops or stored-blueprint rewrites are proposed. No SQL was executed.

## Verification

**Historical pre-review receipt (superseded for current acceptance):** 154/154 tests in eight focused suites**, including **48 new admission tests** (four exercise real Nest HTTP routing). Test identity resolution and database/provider dependencies are synthetic; the production service admission code executes. The HTTP fixture does not validate Clerk or the global TenantGuard.

The eight suites are `delivery/a1-authority.spec.ts`, `delivery/delivery.spec.ts`, `hillday/hillday-library-access.spec.ts`, `hillday/hillday-generation.service.spec.ts`, `hillday/hillday-context.service.spec.ts`, `hillday/hillday-resolution.service.spec.ts`, `hillday/hillday-document.service.spec.ts`, and `hillday/first-page.spec.ts` under `apps/workspace/src`.

Mutation evidence: restoring changed implementation files to base `8d9958f7` made **46/48** new tests fail. The remaining two assert preserved behavior (cross-tenant denial, firm/null support); targeted removal of the tenant predicate and denial of null association made each fail. All mutations were restored. `mutation-evidence.json` records every new test result. The historical approval-specific cases were removed with the retired workflow. Sharing revision/idempotency protections remain covered. Existing Hill Day fixtures now supply valid IDs/current client/actor; wrong-owner errors are intentionally opaque 404s.

Run A1 suites through the repository configuration: from repository root, use `pnpm --filter @capiro/workspace exec jest --config jest.config.cjs --runInBand --runTestsByPath <suite paths relative to apps/workspace>`, or run the complete Workspace suite with `pnpm --filter @capiro/workspace exec jest --config jest.config.cjs --runInBand`. Generate the Workspace Prisma client and build the workspace package dependencies first. The former private `docs/a1-workspace/jest.config.cjs` has been removed; it is not an acceptance runner. The repository mapper now matches relative `.js` imports only, so dependency `.cjs` files remain intact.

The original 154-test receipt used cached Jest 29 / ts-jest in isolated transpilation mode, one worker, roots limited to Workspace src, and a focused shared export shim reexporting the real saved-revision/client-wall implementations. PDFKit is a virtual mock only in the admission suite; denied requests must never render a PDF. No real provider calls occurred. Prisma client generation succeeded locally.

Not run: full repo build/typecheck, full test suite, real PostgreSQL/RLS/locking and concurrent transaction tests, PDF rendering, browser end-to-end, production/staging APIs. Required staging gate includes active-to-removed membership, archived/deleted client, wall revocation, same-tenant wrong owner vs cross-tenant separately, actor/client switch during pending work, and create/save/reopen/Outreach staging retaining one UUID. Request-level rechecks and compare-and-set have unit coverage; atomic ordering against a simultaneous membership revocation remains a PostgreSQL integration gate.

## Review revision receipts

Current review evidence lives in `review-r1/`: real Hill Day source admission and generation guards, signed-file revocation, Workspace approval removal, and owner-held legacy recovery. Mutation results identify behaviorally killed guards and restoration. These receipts supersede approval-specific historical counts above. The canonical Workspace Jest mapper was corrected; the private A1 runner was deleted.

The current environment has a partial backend dependency cache. Focused canonical suites are reported separately from unavailable clean-install/full-build gates. Native PostgreSQL locking/RLS, live providers, browser journeys and deployment remain unqualified. See the updated draft PR body for final run totals and precise blockers.
