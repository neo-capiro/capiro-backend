# Independent exact saved Workspace Objective destination review

Accepted source: `490076ab8a9a5db72eda97b0d576a81e87f81cbb`.
Accepted tree: `bfb8195babb0a25863a2ccde0e050b2ebc2a9c95`.
Required published source base: newsletter PR2401
`3c20f798c731403ffe2bbb6fa75dcb1bbf80bb16`.
Shared Objective helper source: published PR2404
`0716767e8b6ff323b2516d166b22edb4d2413e57`, unchanged blob
`767a11ddff2ff43a39cdf572029b40a4976facac`, SHA-256
`a7fafdf28c55cb9af93b2faf5fbb4b824023622cc68b08501e0d367dcf4a5443`.

**No remaining source blocker was found.** The reviewer accepts this exact source
for draft publication with the native qualification limits below. The reviewer
used a new isolated worktree and wrote only this evidence directory; no author
implementation, source helper, candidate branch, main, schema, migration, writer,
grant or reporting work was edited. All six incremental author paths and both
owner-seam provenance checks are pinned and hashed in `RECEIPT.json`.

## Actual owner composition

The new VersionsService method normalizes the bounded Objective input, opens one
tenant transaction and establishes the existing tenant context. The actual
published Workspace revision helper runs first. It resolves the authenticated
Clerk subject to an actual current Core member UUID, sets that exact user
transaction context, and locks/rechecks active tenant/member/user, the canonical
draft and current collaborator read role, selected saved version, and current
same-tenant nonarchived client/wall grant. Legacy display/person steering,
prospect origin and every immutable source action remain excluded. That helper
is byte-identical to published PR2401.

Only after the source helper succeeds does the owner require a nonnull canonical
saved/current client equal to the normalized requested client. The actual shared
Objective helper then rechecks current tenant/member/Clerk mapping, role/client
wall, current nondeleted same-client Objective and requested live version, and
reads the exact canonical revision UUID. The shared Objective helper is
byte-identical to published PR2404; there is no local policy fork or Core ORM
model added to Workspace. Cross-client, unreadable or unbound source cannot
reach a stale Objective conflict probe. Administrative roles and draft/Objective
ownership cannot override a current client wall.

The response contains only the selected saved snapshot and its canonical complete
snapshot hash, original author/kind/save time, declared canonical client and
bounded literal content projection, plus the owner-derived destination binding.
The destination kind is `workspace_saved_revision`, resourceId is the exact
WsDocVersion UUID, and draftId is its canonical parent. Objective identity,
current version and revision UUID come from the canonical Objective owner. No
synthetic destination state version, browser revision UUID, live working content,
new association, command receipt, permission capability or write is introduced.
Each open rechecks current authority; the binding and hash do not grant later
access, creation, staging, generation or send rights.

Known source/Objective unavailable and invalid/stale errors map to the established
404/400/409 behavior. Permission, deadlock and all other infrastructure failures
propagate without a 404 mask, stale-success fallback or automatic retry. The
strict nested owner route requires two UUIDs and a positive int32, rejects
unknown/repeated/nested claims, parses both resource path UUIDs, and marks the
response `Cache-Control: private, no-store`.

## Independent retained evidence

- **82 new independent cases pass**, running the actual VersionsService and
  both actual shared owner helpers from this checkout's TypeScript source.
- **133/133 pass across two suites** in `combined-final.json` and `.log`: the
  eighty-two independent cases plus fifty-one existing author owner/HTTP cases.
  The author's separately retained ninety-case four-suite run and builds are
  not claimed independently reproduced or counted as additional independent cases.
- Initial **79/79 passed** in `independent-initial.*`. The asynchronous fixture
  was then strengthened to wait for confirmed entry into each awaited query
  before changing the modeled evidence and releasing the query; the same
  seventy-nine passed in `independent-confirmed-gaps.*`. Three extra origin/wall
  await vectors form the final eighty-two. These passing runs overlap.
- No failed reviewer execution occurred. The author's separately retained wrong
  relative-path and preexisting Jest mapper collection failures remain with the
  author's qualification evidence. This review runner applies the same mapper
  correction only in its own configuration; repository tooling is unchanged.

The cases challenge current tenant/member/role/Clerk identity, actual resolved
UUID use, supported active Workspace roles and pending/revoked collaboration,
draft/version tenant and parent identity, source deletion on replay, all immutable
source origins and prospect exclusion, legacy and null clients, current/saved
client reassignment, cross-client requests before stale 409, client lifecycle and
actual grant/predicate failures, foreign/deleted/stale Objective and scoped
revision, exact full snapshot hash versus working edits, content bounds/slot
rejection, normalized UUID case, private/no-store metadata, missing/repeated/
nested/extra query fields, scalar UUID coercion and int32 bounds. Fourteen
infrastructure/context/query phases preserve the exact injected error and make
only one transaction attempt. Successful resolver SQL contains no data write and
does not call legacy collaborator/network authorization paths.

Confirmed await-entry cases cover membership removal, collaborator status change,
saved version removal, an observed source-origin receipt, source and Objective
grant denial, changed Objective role/version, and a changed working copy. These
test the decisions after asynchronous query boundaries using synthetic rows;
they do not establish real database interleavings, grant deletion while a shared
lock is held, phantom receipt insertion, native MVCC or concurrency acceptance.
Snapshots are cloned at the simulated saved-row read to mirror an owned immutable
query result rather than expose an artificial mutable fixture reference.

Run the independent suite from the repository root:

```bash
node apps/workspace/node_modules/jest/bin/jest.js \
  --config docs/workspace-objective-revisions-20261012/evidence/independent-review/jest.cjs \
  --runInBand --no-cache
```

Set `WORKSPACE_REVIEW_INCLUDE_AUTHOR=1` for the exact bounded combined run. The
runner maps shared imports to this checkout's actual TypeScript barrel, avoiding
stale compiled helper bytes, and selects no database suites. The existing
generated JavaScript/declarations and auth JavaScript/dependency links were copied
locally; native `.node`/`.wasm` engines were excluded, and shared stores were not
modified. No full TSC, shared build or production build was repeated by the
reviewer; the author's passing primary checks remain separate evidence.

## Source-only and operational boundaries

The published saved-version immutability migration remains an authored source
dependency. Mutable authority/source lifetime rows retain shared locks; immutable
source receipts and Objective revisions remain ordinary SELECT, preserving their
minimal published grants and PR2402's permission correction. The existing
Objective migration/tables are an explicit operational dependency, not newly
defined or migrated by this slice. Native source deletion/cascade, permission,
RLS, shared-schema and transaction lock qualification has not been performed.

The inherited client wall writer deletes grants before updating the client when
toggling its wall flag, while these readers lock client before grant. Its exact
flag-toggle plus grant-removal schedule can deadlock. Database rollback fails
closed, and the owner leaves infrastructure failures unmasked, but availability,
joined-row ordering and concurrent revocation need the authorized native gate.
The writer is unchanged; no workaround, permission expansion or native claim is
made here.

No database/PGlite/migration/RLS experiment, real provider/model/message/upload,
customer mutation, credentials/permissions, AWS, security/network change, native
engine/download/bypass, container, main merge or deployment occurred. This review
used the same authorized reviewer session/environment; no quota failure or quota
retry occurred during its execution. Publication remains with the source owner.
