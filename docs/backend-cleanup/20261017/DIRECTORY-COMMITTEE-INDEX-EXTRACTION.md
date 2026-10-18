# Directory committee index extraction

## Source and ownership

This local cleanup slice starts from reviewed PR80 receiving commit
`00ebd1ac17332d50a6c6c5843ea2d07c1258c9bf`. Its source is the existing
committee catalog builder in `apps/api/src/directory/directory.service.ts`. The
PR78 receiving report already accounts for Directory type, contact mapping, and
browse extractions; the earlier memo parser and Bill dossier work are also
present. No repository `AGENTS.md` or `.agents/skills` exists at this commit.

The committee builder and its office normalization, leadership inversion, and
office contact helpers now live together in
`apps/api/src/directory/directory-committee-index.ts`. The service retains a
small `buildCommitteeIndex` method, which calls the extracted pure function.
No committee selection, sorting, deduplication, fallback, or default changed.

## Consumer closure

- `DirectoryService.loadSnapshot` calls `buildCommitteeIndex` after loading the
  office, staff, and member snapshots. Cache and pointer handling stay in the
  service.
- `DirectoryController` serves committee list and staff routes through the
  unchanged `DirectoryService.getCommittees` and `getCommitteeStaff` methods.
  `DirectoryModule` still registers and exports `DirectoryService`.
- `apps/api/scripts/emit-committee-changes.ts` loads `DirectoryService` through
  Nest at runtime. The service and its public committee methods remain in place.
- `OutreachTargetReferenceService` uses
  `DirectoryService.getCommitteeStafferById`; this contract remains in place.
- `directory.committees.spec.ts` directly calls the private service method and
  covers both live-array and legacy-object office shapes, federal filtering,
  leadership, phone/address, staff deduplication, and current-position ranking.
  The retained wrapper preserves its test identity.

No public API, DTO, migration, Meri contract, Objective/read branch, auth,
tenant middleware, outreach visibility, lockfile, or shipping/infra path was
edited. Reverting this one commit restores the source layout.

## Size and focused checks

The original service was 2,247 lines and 91,735 bytes. It is now 1,994 lines
and 81,038 bytes; the extracted module is 263 lines and 10,679 bytes. Combined
source size is 91,717 bytes, 18 bytes below the starting source. The reduction
is in service size and responsibility, not a claim of repository byte savings.

At the base, the committee and snapshot suites passed 13/13 tests. After the
extraction, those suites plus the Directory service and controller suites
passed 46/46 tests. The Directory detail and outreach target reference suites
passed another 24/24. Jest used task-local cache and existing local dependencies;
the snapshot tests used fake S3 responses. No network, database, or AWS action
was part of these checks. Test cases, names, and runner scope were retained.

The extracted module passed a focused strict TypeScript check (`tsc --noEmit
--strict --skipLibCheck --target ES2022 --module commonjs --moduleResolution
node`). A full API `tsc --noEmit --rootDir .` attempt exhausted Node's default
4 GB heap before producing diagnostics, so it is not counted as a pass.

Independent read-only review found no behavior or caller regression. The
reviewer compared the four moved function bodies, office type, and federal
office table with the base as TypeScript ASTs; the only normalized changes were
calls to the three helpers in their new module. The reviewer also checked the
service wrapper, public methods, route/export consumers, dynamic Nest consumer,
and `git diff --check`.

## Next bounded candidate

Extract the member/staff detail projection helpers from `DirectoryService`
while retaining its public methods and snapshot timing. First pin the current
member/staff/committee detail behavior in `directory-detail.spec.ts` and the
controller delegation tests; do not combine this with the committee slice.
