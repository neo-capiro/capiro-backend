# WS-03 descendant authority correction

Bounded A1 correction for the four descendant groups named in the relay of
meri-greenfield #202 comment 6330762076. Baseline is the previously reviewed
#105 tree at remote `ad71e416` (local equivalent `04844204`). This is a draft
code correction, not a ship request or release qualification. **The #105
Workspace ACL deployment hold remains for coordinating review.**

## Authority and scope

`CollaboratorsService.assertReadable` delegates to the existing `resolveRole`
and `canRead` authority. It adds no identity store, policy, endpoint or SQL.
Missing identities and unreadable drafts receive the same opaque 404. Existing
membership, active-tenant, client binding, client wall, held-owner, prospect and
source-author checks remain in `resolveRole`/`sourceAccess`.

Comments resolve only the tenant-bound document-to-draft pointer before that
admission. The query does not select document content. Missing and inaccessible
parents have identical 404 bodies. Comment mutation predicates remain unchanged;
the viewer-delete and review checks precede protected comment reads where the
action can be decided without reading authorship. A readable commenter may read
authorship to distinguish their own comment from another author's comment.

Checks and anonymization admit the actor and retain the prospect/copy-receipt
guard before fetching full draft content. The existing quality controller and
quality adapter now forward the trusted actor to checks. Every edit-lock action
uses draft admission; heartbeat/request enforce the existing owner/editor
predicate, and release rechecks an ordinary pending recipient before transfer.
The existing prospect transaction guards remain in place. Global `assertCan`
semantics and other services are unchanged.

| Descendant | Direct Workspace route | Existing action permission |
| --- | --- | --- |
| Comments | GET/POST `documents/:documentId/comments` | Read / comment |
| Comment changes | PATCH/DELETE `documents/:documentId/comments/:commentId` | Review; author deletion still requires comment permission |
| Comment suggestion | POST `documents/:documentId/comments/:commentId/suggest` | Review; prospect transfer remains refused |
| Checks | GET `drafts/:draftId/checks` | Read |
| Lock status/release | GET `drafts/:draftId/lock`, POST `.../release` | Read; only the current holder can release |
| Lock editing | POST `.../{acquire,heartbeat,request,take-over}` | Owner/editor |
| Anonymization | POST `drafts/:draftId/anonymize/detect` | Read |

The generic frontend `/api/backend/workspace/...` proxy reaches all 13 routes.
The typed Capiro gateway exposes comment list/create/resolve. Both forward trusted
server credentials and depend on this Workspace authority. No gateway production
code or shared-shell file changed; the frontend companion adds verification only.

## Verification

The direct HTTP suite uses actual Nest controllers, the actual CurrentTenant
decorator, the actual services and actual draft authority helpers. TenantGuard
supplies a trusted synthetic identity; Prisma query results are an explicit
tenant/parent-aware fixture. No database, Clerk account or provider is contacted.
Minimal parent and authority lookups are distinguished from descendant content
reads. Rejections assert no descendant reads, writes or generation calls.

- Direct HTTP: **267/267**, exit 0, no pending tests or startup errors. Covers
  every route, owner/editor/reviewer/commenter/viewer matrix, unrelated actors,
  forged parents/comments, missing identity, membership/tenant/client/wall
  revocation, repeated collaborator revocation, held drafts, prospect positives,
  copied-brief refusal ordering and exact opaque-body equality.
- Focused service coverage: **72/72** across comments (3), checks verification
  (11), read/quality forwarding (21), and lock policy/handoff (37).
- Joined gateway qualification: wrapper Jest **1/1**, frontend **34/34**, exit 0
  with **zero skipped**. The real generic proxy and typed comments gateway call
  the local Nest server. Ten denied scenarios traverse all 13 generic routes and
  all three typed operations; owner/editor/viewer/held/prospect controls pass.
- Workspace typecheck against the prior reviewed tree: **17 identical
  dependency-related diagnostics on each tree; zero added/removed diagnostics**.
  This is parity under the cached install, not a successful clean typecheck.
- The frontend companion's canonical web typecheck and changed-file lint pass.
- **15/15 behavioral mutants killed**, with zero runtime-error suites. Each source
  was restored byte-exact. The final combined canonical run passes **339/339**
  across all five suites, exit 0, with zero failed/pending/startup errors. Exact
  mutations, failing-assertion samples and restoration hashes are in the JSON.

All backend test runs use `apps/workspace/jest.config.cjs`, with no diagnostic
override. The joined wrapper lives outside the normal spec glob and requires an
explicit frontend checkout. It refuses child-process failure or skipped joined
cases even if Vitest JSON reports success. The ordinary frontend run explicitly
reports its 18 joined cases skipped when no fixture server is provided; that
ordinary run is not the joined qualification.

This is a reused partial dependency installation. `@capiro/auth` was built from
the unchanged repository package into temporary output with its original exports.
The cached HTTP/mutation profile uses `NODE_OPTIONS=--max-old-space-size=4096`
and `NODE_PATH` pointing to the existing Workspace dependency cache. No package,
lockfile, test configuration or dependency was added. Earlier setup attempts
(missing auth/supertest/platform adapter, mismatched cached Nest adapter types,
and frontend heap/package-link failures) are not gate passes. The new direct
HTTP suite uses Node's built-in fetch, not an added HTTP-test dependency.

The existing prospect suite remains blocked by missing PDFKit typings in this
cache, with zero tests executed in that attempt. The 267-case suite independently
executes real prospect authority and the retained copy-receipt checks. Full
clean-install Workspace/API suite parity and production builds are still open.

## Native qualification: Fable-run, not executed here

- PostgreSQL 16 negatives for same-tenant unrelated, removed/suspended member,
  inactive tenant, client-wall/archived-client and collaborator revocation across
  each descendant route, through direct Workspace and gateway paths.
- Native tenant RLS, forged document/draft/comment binding, prospect and copied
  brief authority, and absence of descendant writes/provider effects on refusal.
- Native locking/concurrent revocation and edit-lock handoff rechecks, including
  current membership/client authority of the pending recipient.
- Combined-tree clean-install/build/image qualification, live authentication,
  browser/native-session checks and existing release gates.

No SQL or migration ran. No merge, deployment, email/recovery change, new phase,
Meri approval removal or cross-lane implementation occurred.

## Adjacent findings for scope review; unchanged

Read-only review identified ordinary `DocumentsService.list` and
`CollaboratorsService.list` paths that rely on the prospect-only wrapper;
`VersionsService.loadDraft` loads content before its optional actor check; and
`DocumentAgentQualityService.createFixProposal` has a prospect-only gate. These
are not included in the named four-group correction or claimed as qualified.
The coordinating owner should classify/route them under the current release
hold before any claim that all Workspace descendants are closed.
