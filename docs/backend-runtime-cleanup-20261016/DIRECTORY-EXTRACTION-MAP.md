# Successor oversized-source map

Source checkpoint: `7b6bda7ca75ea86afb36c76f013f550fdd79e42f` (sealed PR30), branch `cleanup/backend-only-workspace-20261016`. Application working tree was clean when inspected. This is read-only source analysis; no application edits, tests, compiler, framework, installation, database or provider execution occurred.

## Bounded metadata shortlist

Used `git ls-tree -rl 7b6bda7 --` only for `apps/api/src/{directory,explorer,ingestion,intelligence,external,live-hearings}`. These are Git blob sizes, not a complete repository inventory or retirement decision. Fixture HTML, retained UI text and test blobs were excluded from candidate selection.

| Current source | Git bytes | Disposition |
| --- | ---: | --- |
| `directory/directory.service.ts` | 143,874 | Best bounded pure-projection extraction candidate below. |
| `live-hearings/legiwatch-wave1.service.ts` | 105,075 | Active mounted/versioned implementation; no retirement or split admitted by this inspection. |
| `explorer/explorer.service.ts` | 72,447 | Smaller source; not needed for the selected first slice. |
| `intelligence/alert-memo/alert-memo.service.ts` | 63,320 | Existing memo-section extraction is retained; not selected again. |
| `live-hearings/live-hearings.service.ts` | 59,723 | Active source; no retirement claim. |
| `live-hearings/phase9/legiwatch-phase9-readiness.service.ts` | 58,132 | State/readiness ownership not admitted as a pure-leaf slice. |
| `intelligence/insight-generator.service.ts` | 53,565 | Not selected; no current consumer/capability closure performed. |

Excluded from this allocation: all Meri/Fable, startup/auth/current membership/retained authority/memory-wall, Objective/canonical work/planner/shared/schema, and current Engagement feature claims. No versioned Funding or LiveHearings source is classified dead. No live or deployed-source equivalence is inferred.

## Directory size and active ownership

- `apps/api/src/directory/directory.service.ts`: blob `4bce0f9ccfe1fe5dbd383ca18b8fd5a602839754`; 143,874 bytes, 3,775 physical / 3,538 nonblank lines.
- `apps/api/src/directory/directory-indexes.ts`: blob `637ac9065ce2a50b6001832ead166706da47a1d6`; 16,060 bytes, 392 physical / 362 nonblank lines. It remains active: `DirectoryService.loadSnapshot` calls `buildDirectoryIndexes` at line 1956, and the service imports it at lines 20–26. It is not an oversized-file target. Its earlier three-name-formatter observation is not a new edit claim.
- `directory.module.ts` registers and exports `DirectoryService` and registers `DirectoryController` plus `InternalDirectoryController`; `app.module.ts:20,101` imports/mounts `DirectoryModule`. These DI/module declarations remain unchanged.
- `directory.controller.ts:161–168` mounts `GET directory/members/:memberId` and `GET directory/staffers/:staffId`, forwarding to the two active public detail methods below.

## Proposed first extraction: seven detail DTO mappers

Move the algorithms unchanged from `directory.service.ts` into new `apps/api/src/directory/directory-detail-mappers.ts`. Keep all seven private class methods as thin forwarding wrappers, preserving method names, signatures, receiver surface and the existing public callers. Do not create a Nest provider, barrel export, new DTO contract, behavior option or policy layer.

The exact contiguous source region is lines 1395–1507: **113 physical / 106 nonblank lines, 4,979 Git bytes**. Symbols, bodies and the following `resolveMemberRef` comment/signature, rather than historical line positions alone, define the extraction boundary.

| Canonical function to extract | Current declaration | Current callers | Existing return type |
| --- | ---: | --- | --- |
| `mapMemberOffices` | 1395 | `getMemberDetail:1086` | `DirectoryMemberDetail['offices']` |
| `mapLeaderships` | 1412 | `getMemberDetail:1089` | `DirectoryMemberDetail['leaderships']` |
| `mapContactMethods` | 1421 | `getMemberDetail:1090`; `getStaffDetail:1181,1182,1191` | `DirectoryMemberDetail['socialContacts']` |
| `mapStaffRoles` | 1431 | `getMemberDetail:1091` | `DirectoryMemberDetail['staffRoles']` |
| `mapStaffIssues` | 1439 | `getMemberDetail:1092` | `DirectoryMemberDetail['staffIssues']` |
| `mapStaffPositions` | 1447 | `getStaffDetail:1184` | `DirectoryStaffDetail['positions']` |
| `mapStaffOfficeAddresses` | 1485 | `getMemberDetail:1087`; `getStaffDetail:1183` | `DirectoryStaffDetail['officeAddresses']` |

Each accepts only `raw: unknown`. All seven complete bodies were inspected: no `this`, service state, I/O, clock, randomness, environment, DI or runtime imports. Built-ins used are `Array.isArray`, `Number`/`Number.isFinite`, `String`, and ordinary array/object operations. The new file needs only `import type { DirectoryMemberDetail, DirectoryStaffDetail } from './directory-detail.types.js'`; erasure leaves no runtime dependency on the service or Nest. Existing type-only relationships in `directory-detail.types.ts` remain unchanged.

The bounded symbol search across Directory, API tests/scripts, repository tests, `scripts/ci` and `scripts/lib` found only the declarations and callers listed above; no external direct private-method consumer surfaced. The wrappers preserve that surface regardless. Snapshot loading, identity lookup, `membershipsForPerson`, `resolveMemberRef`, `currentMemberOffice`/`selectCurrentMemberOffice`, roster-only fallback, photo provenance, sorting, grants, notes/favorites, representation and module registration are outside the extraction.

This is a modest cohesive seam, not a claim to finish decomposing a 3,775-line facade or reduce total repository LOC. With wrappers and tests, total source can increase. Its justification is one pure owner for the seven related public-detail projections and an isolated executable contract.

## Behavior and existing native coverage to retain

`directory-detail.spec.ts` is blob `ded69c5b0c1679bd8e49cc143b59a9918a109e57` (14,861 bytes; 321 physical lines). Retain the entire spec and every case identity. Directly relevant existing public-entrypoint cases are:

- line 155: `assembles complete member detail from the source row + overlays` — offices, leadership, social contacts, roles and issues.
- line 196: `assembles staff detail with member + committee associations and photo availability` — emails/positions and source availability.
- line 212: `enriches staff detail with full bio, issues, roles, office addresses, and position context` — address fields, strict flags and nested member context.
- line 265: `renders a minimal profile for a roster-only staffer (no staff-list row) instead of 404` — adjacent fallback remains unchanged.
- All identity refusal, Bioguide, committee and people-search cases remain retained; none are replaced by pure-helper tests.

Preserve exact coercions/defaults: nonarray input becomes `[]`; object filtering stays as written; `Number(null/false/'')` can produce zero; role member-ID fallback uses `??`; contact strings are not trimmed and empty strings remain accepted; boolean flags require `=== true`; preferred-name empty strings suppress fallback; order and passthrough/nullish fields remain unchanged. Do not add stricter validation or normalization in this structural slice.

## Proposed bounded builtin stage (not run)

Create `scripts/ci/directory-detail-mappers.contract.spec.mjs` using only Node built-ins. Use Node 24's native `node:module` `stripTypeScriptTypes` with strip mode and an inert data-URL import; no TypeScript compiler package, Nest/Prisma/framework imports, dependency installation, worker pool, DB or network. The original seven contiguous method bodies can be source-pinned to the `4bce0f...` blob, their `private` declarations converted to exported standalone functions, and type-erased for the BEFORE characterization. AFTER loads the new pure helper through the same type-erasure boundary. Record baseline and successor identities separately.

Planned **8 top-level cases**: seven named mapper fixture tables (one per function, including nonarray/null/malformed/coercion/order cases and concrete expected DTOs), plus one finite ownership/forwarding/type-only-import contract. Add real negative controls for a copied algorithm in a wrapper and a runtime import in the pure helper. Keep expected outputs independent from the implementation; do not duplicate its expressions as expected-value generators.

Expected command, once the owner authorizes the bounded runtime stage:

```text
node --max-old-space-size=128 --test --test-concurrency=1 scripts/ci/directory-detail-mappers.contract.spec.mjs
```

One process capped at 128 MiB, no child/application process. Native type stripping itself is not claimed executed or qualified here. Queue the existing `directory-detail.spec.ts` public-entrypoint Jest suite with the shipping resource owner at the next integration checkpoint; preserve any setup/platform failures and do not broaden into a full API suite for this leaf.

## Status

Source map complete; **no source write claim or implementation yet**. The candidate is ready for an explicitly owned seven-mapper extraction with wrappers and original algorithms preserved. No module/security/membership/feature ownership decision is required by the proposed code boundary. Broader facade splitting and all other inspected large sources remain unqualified.
