# Independent Strategy/Planner Objective destination review

Accepted exact source: `d198733d66ea6b6b29eaafbccb6a76b6a174b239`.
Tree: `df1d72330029edbc0a250940a9adb98c14c8c87b`.
Required corrected published PR2402 base:
`4a784b58a0d41251ae6d7dea75a9b4858abc8665`.
Initial frozen ancestor: `b5e61175eff7cebe28a70a79da41e12d8f584b28`,
tree `9f1885726d8f2ac02a12a3ee096b63f6330888c7`.

**No remaining source blocker was found.** The final shared helper and its owner
integration are accepted for source-only draft publication. The reviewer used a
new isolated worktree/branch and changed only this evidence directory. All
seventeen author incremental paths were compared with their exact accepted Git
blobs and hashed in `RECEIPT.json`; no author implementation, other candidate,
main branch, reporting, EngagementService, schema, migration or permission was
altered by the reviewer.

## Concrete findings and reviewed controls

The initial helper's UUID regex coerced arrays/coercion objects before calling
`toLowerCase`; malformed direct service input could therefore produce TypeError
instead of the bounded invalid-input error. The author added the explicit string
guards in the final two-line repair. The retained exact b5e helper reproduces the
rejection: `b5e-scalar-red.log` records one failed targeted case, with the other
forty-nine cases deliberately skipped. The accepted final helper passes those
same scalar vectors for both UUID fields before any SQL. HTTP duplicate/nested
scalar parameters and unknown claims are separately refused by the strict DTO
validation pipeline.

The previously published immutable-revision permission defect remains corrected:
the shared helper uses ordinary SELECT on `client_objective_revisions`, whose
preserved Objective migration grants SELECT/INSERT and revokes UPDATE/DELETE.
Locking SELECT would require UPDATE privilege under the
[PostgreSQL SELECT contract](https://www.postgresql.org/docs/15/sql-select.html).
Current tenant/member/user/client and actual wall grant retain shared row locks;
the mutable Objective is locked and its live version is compared before the
exact scoped revision is read. The original composite revision-to-Objective FK
and unique tenant/Objective/version constraint are retained unchanged. These
parent/current locks protect canonical delete/cascade and Objective version
changes through the transaction boundary; source checks do not prove the live
runtime role's grants, native cascade blocking or RLS.

The helper resolves each authenticated Clerk subject through the actual current
active Core membership and role floor. Core supplies its additional UUID pin;
non-Core owners do not fabricate a UUID or cast a Clerk subject to UUID. Wall
authorization uses the resolved member UUID. Stale administrator request context,
Objective ownership, Strategy ownership and Planner task ownership confer no
wall bypass. The SQL retains same-tenant predicates, nonarchived client state,
nondeleted current Objective scope, and exact requested version. Missing/revoked
authority fails before a stale-version conflict can be disclosed. Every open
rechecks current authority; the returned binding is neither a grant nor a durable
association.

Strategy locks its exact same-tenant, same-client, nonarchived row before loading
the existing live-plan projection. Existing node writes, plan patches/archival
and saved-plan restore use the matching parent FOR UPDATE mutation lock. Live
node and attached-artifact filtering remain in the owner projection. Planner
acquires the same existing tenant advisory lock before task/project reads, keeps
the current task/project viewer policy and filtered task projection, and requires
explicit canonical task `data.clientId`. A project, meeting, parent, name or
absent client cannot substitute. Task archival is denied; existing project,
assignee and collaborator policy is preserved rather than replaced. Unreadable
project membership/custom fields and dependency references stay filtered.

Actual Strategy, Planner and Core delegation methods propagate infrastructure
failures unchanged. Only the neutral owner's bounded invalid, unavailable and
stale errors become the established 400, 404 and 409 responses. No failed query
can yield cached authority, a successful destination or a changed receipt.
Both destination kinds and resource UUIDs are owner-derived; both controller
routes mark responses `Cache-Control: private, no-store`. Existing Strategy
feature and Planner context guards remain in their respective owner surfaces.

## Independently reproduced evidence

- **50/50 independent cases pass** in `independent-final.json` and `.log`, using
  the actual shared helper TypeScript source plus the actual Strategy, Planner
  and Core delegate methods with synthetic transactions.
- **109/109 across seven suites pass** in `combined-final.json` and `.log`.
  This includes the fifty new independent cases and fifty-nine existing author
  cases for Strategy/Planner HTTP and owner behavior, the shared authority seam,
  Core/Outreach owner regression and the ten preserved permission-repair cases.
  The author's separately reported 128-case run is not claimed reproduced here;
  overlapping runs are not additional independent counts.
- Initial independent **44/44 passed** before six added asynchronous/Core
  delegation checks. This overlaps the final fifty.
- The initial combined run retained **108 passes / one failure** because the
  preserved permission test resolves a migration relative to the Core working
  directory. `combined-wrong-cwd.*` is a reviewer launcher failure, not a source
  finding. The final run uses `apps/api` as cwd and passes all 109.

The independent cases challenge actual tenant/member/user/Clerk agreement,
current role downgrade, wall/client lifecycle, deleted/foreign/stale Objective
and missing revision, each infrastructure query phase, wrong resource client,
archival, current project ACL revocation, assignee/collaborator revocation,
hidden task fields/references, exact current resource/revision refresh,
parameterization and grants, scalar UUID coercion, missing/duplicate/nested/extra
transport fields, positive int32 bounds and no-store metadata. Two controlled
asynchronous waits demonstrate that authority changed before the relevant check
is re-read and denied; they do not simulate or establish PostgreSQL MVCC or lock
acquisition behavior. No data write appears in successful resolver SQL.

To run the independent suite from the repository root:

```bash
node apps/api-strategy/node_modules/jest/bin/jest.js \
  --config docs/objective-strategy-planner-destinations-20261012/evidence/independent-review/jest.cjs \
  --runInBand --no-cache
```

For the bounded combined run, invoke the same runner from `apps/api`, use the
repository-relative `../../docs/.../jest.cjs` path, and set
`OBJECTIVE_REVIEW_INCLUDE_AUTHOR=1`. The rejected scalar run sets
`OBJECTIVE_REVIEW_SHARED_SOURCE` to the retained `rejected-b5e-shared-helper.ts`
and selects only the `final shared scalar guards` case. The runner maps shared
imports to this checkout's actual TypeScript barrel, avoiding stale compiled
helper bytes. No database suites are selected.

## Exact limits and native gates

No database/PGlite, migration, RLS experiment, native Prisma engine, provider,
model, AWS, customer mutation, credential/permission, security/network, container,
merge-to-main or deployment operation was performed. Existing dependency links
were copied into this review worktree without modifying their shared store;
generated JavaScript/declarations were copied locally with native `.node` and
`.wasm` engines excluded. Tests use isolated transpilation, not an independent
full TypeScript or production build. The author's full build evidence is separate;
no competing eight-GB TypeScript process was started.

Native grants/shared-schema availability, RLS, parent/cascade locking, joined
authority row order, advisory lock interoperability and concurrent revocation
still need the authorized qualification gate. The existing client wall writer
deletes grants before updating the client when changing its wall flag, whereas
readers acquire client then grant. The exact flag-toggle plus grant-removal race
can deadlock; transaction abort fails closed, but availability/error behavior is
unqualified. This inherited writer was not changed or bypassed. Runtime integration
must preserve the existing Objective migration and deliberately compose all
published candidates. The shared pure-package dependency, lockfile entry and
Docker build/runtime source were reviewed; no container was built or executed.
