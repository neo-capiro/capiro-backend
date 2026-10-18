# Directory detail projection extraction

## Source and boundary

This local slice starts at `b6e5bc5235b0bdf3dea20313d9e1f21fd547cedd`,
whose parent is reviewed PR80 receiving commit
`00ebd1ac17332d50a6c6c5843ea2d07c1258c9bf`. The previous slice extracted
the committee snapshot index. This slice moves only member/staff detail DTO
assembly and its pure mapping helpers into
`apps/api/src/directory/directory-detail-projection.ts`.

`DirectoryService.getMemberDetail` still accesses `getDirectoryData()` first,
resolves Bioguide or numeric identity with the existing indexes, and throws the
same member 404. `getStaffDetail` still accesses the snapshot first, resolves
the numeric staff ID, chooses the staff-list or roster-only path, and throws the
same staff 404 when neither source has a name. Its public signatures are
unchanged. Snapshot pointer, cache, rollback, and index construction stay in
the service.

## Consumer and policy closure

- `DirectoryController` retains its class-level `RolesGuard` and
  `@Roles('standard_user')` for the member/staff detail routes. No controller or
  module registration changed.
- `client-targets.service.ts`, `objective-generation-context.service.ts`, and
  `capabilities/targets/outreach-target-reference.service.ts` consume the
  member/staff detail shapes. Strategy's member-office reader and Web Directory
  clients call the same public routes. The projection preserves DTO fields,
  null/empty distinctions, association order, and source timestamps.
- Detail projections still return all indexed committee memberships, including
  ended ones. The separate service context path keeps its existing
  `endedAt === null` filter through the retained `membershipsForPerson` wrapper.
- Existing member photo precedence and the staff photo entitlement behavior
  remain in place. Contact methods, office addresses, roles, issues, and
  roster-only defaults are mapped with the same expressions. No new product
  policy or visibility decision was needed.

No auth, tenant middleware, outreach visibility, Objective/read branch, Meri,
migration, lockfile, shipping/infra, or cloud path was edited. Revert this
single commit to restore the preceding layout.

## Size and focused checks

Immediately before this slice, `directory.service.ts` was 1,994 lines and
81,038 bytes. It is now 1,609 lines and 65,586 bytes; the new projection is
407 lines and 15,847 bytes. The two touched source files total 81,433 bytes,
395 above the prior service. Cumulatively since PR80, the service shrank from
2,247 lines and 91,735 bytes to 1,609 lines and 65,586 bytes; it now delegates
to two cohesive modules totaling 26,526 bytes.

At the starting commit, the Directory detail, controller, and snapshot suites
passed 30/30 tests. After extraction, those suites plus the Directory photo and
index suites passed 46/46. Snapshot failure messages came from their fake S3
responses. The new projection passed a focused strict TypeScript check. Tests
used task-local cache and existing local dependencies; no install, database,
network, or AWS action was performed. Test names and runner scope were retained.

Independent read-only review found no behavior or policy regression. The
reviewer compared the moved member, staff, roster-only, and 10 helper bodies
with the parent as TypeScript ASTs, normalizing only calls to moved helpers.
The review also verified snapshot timing, both 404 paths, current-only context
filtering, photo selection, controller guards/routes, staged source identity,
and `git diff --cached --check`.
