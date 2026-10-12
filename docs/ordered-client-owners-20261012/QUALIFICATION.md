# Exact source qualification

Source/tests: `5f7308891e9bb3f0561804a0895b4372030c0d38`.
Tree: `15355c281ff13f012c49e7edb51f134e0fb8f742`.
Runtime changes are identical to `82a4366256a35ab27099aac099c7fb7e610a4959`;
the final source commit adds the independent regression suite unchanged.
Base: `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`.
Later commits contain documentation/evidence only.

## Results

| Check | Exact result / evidence |
| --- | --- |
| Author final regression | **97/97**, seven suites, exit0; `evidence/owners-qualified.log` |
| Independent exact-source replay | **107/107**, nine suites, exit0; 75 owner/HTTP cases including29 independent adversarial cases, plus32 existing role/wall/tenant controls. Independent receipt and logs retained under `evidence/independent/`. These counts overlap the author run; do not add them. |
| Core primary TypeScript | **PASS**, exit0 on the exact source; `evidence/api-primary-tsc-qualified.log` (empty success log). Command: `NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc --noEmit --rootDir .` from `apps/api`, using its local binary. |
| Core Nest build | **PASS**, exit0 on exact source; `evidence/api-nest-build.log` (empty success log), run serialized after primary TypeScript. |
| Changed TypeScript formatting | **PASS**, exit0; `evidence/prettier-check.log`; complete main-to-source diff also passes `git diff --check`. |
| Prisma schema/client generation | **PASS** official Prisma5.22 WASM DMMF + noEngine client generation in this candidate's own offline install; `evidence/prisma-wasm-final.log`. No database/native engine was used. |
| Workspace dependencies | Frozen/offline install with `--ignore-scripts`; shared/auth/MeriV2/defense-domain/defense-contracts/strategy-verifier builds passed. No package or lockfile change. |
| ESLint | **BLOCKED**, exit1 `eslint: not found`; `evidence/api-lint.log`. Existing manifest/config source gap, independent from native-engine egress. No global install or ad hoc configuration. |
| Native PostgreSQL migration/RLS/MVCC | **NOT RUN**. No migration executed, including against an ephemeral database. |
| Signed-in frontend, deployed API, real customer/provider actions | **NOT RUN**. No deployment or enablement. |

Regression scope includes four-owner replacement/reordering/removal/clear,
malformed/duplicate/inactive/foreign members, current role/identity/membership,
archived/missing/walled clients, rollback on audit failure, concurrent stale
replacement, exact no-op, maximum versions, legacy multi-owner conflicts,
legacy version invalidation, HTTP guards/strict input, and team rank/role behavior.
Independent cases cover post-lock revocation/demotion/remapping across ranked,
legacy and team operations, protected wall grants, rollback and lost replies.
These are transaction-adapter interleavings, not native PostgreSQL lock proofs.

## Failures retained and repaired

- Initial author run: **33 passed / 6 failed**. Old team fixtures used UUID strings
  rejected by the now-shared strict actor/client checks; fixed synthetic UUIDs,
  preserving the original behavior assertions. Original log retained.
- Initial primary compiler: **exit2**, test array indexing inferred undefined
  under checked-in strict options. Made the synthetic fixed ID tuple explicit and
  asserted an already-tested second owner slot; final primary compile passed.
- Independent review found three initial source gaps: actor authority before a
  client-lock wait, a wall-grant revocation across a later membership wait, and
  rank-row parent movement leaving the old set unchecked. The candidate rechecks
  and locks current actor/identity after the client lock, holds existing wall
  grants through later waits, and rejects assignment parent changes.
- A preserved partial-repair access-helper snapshot reproduces **3 RED / 26 PASS**
  independent cases. It already contained the actor-lock fix when captured, so
  this negative replay proves the wall-lock regression only. Its context receipt
  explicitly distinguishes that snapshot from a historical Git revision or a
  native race test. Final exact-source independent run is green.
- Review identified an inconsistent maximum-version boundary. Ranked input now
  accepts2147483647 for an exact no-op; any change at that version returns typed
  `owner_version_exhausted`409, matching legacy mutation. Larger input is400.

## Integration and release boundaries

`path-intersections.json` recomputes each preserved candidate delta from its merge
base with current main and intersects it with this candidate. Only Objective2362
and QuickLog2396 intersect, in `schema.prisma` and `clients.module.ts`. Cleanup2392,
Facility2373/2394, Reply2364, Attachment2381, Stages2365, Contacts2371, Sender2393,
Planner2395 and Memory2397 do not intersect. Preserve their branches and reconcile
the two shared registration/schema files deliberately. No unrelated candidate
was merged or cherry-picked into this source branch.

The additive migration is deliberately allocated as
`20281012020000_client_ordered_owners`; backfill, tenant FK, FORCE RLS/WITH CHECK,
deferred Primary/contiguous-rank checks, invoker rights, grants and user/client
deletion effects were independently source-reviewed. Native application-role
qualification is still required. Hard deletion of an assigned user now requires
explicit ownership removal. Soft deactivation retains an unavailable rank. Old
Primary-only server code cannot commit divergence after the SQL guards are active;
coordinate schema/writer rollout through dot.

The saved environment proxy rejects normal HTTPS CONNECT to
`binaries.prisma.sh:443` with Envoy403 before TLS. The supported native-engine route
is environment-owner approval of that normal egress, followed by the existing
pinned Prisma toolchain and checksum verification. No alternate host, proxy,
manual engine or checksum bypass was used. Native database qualification also
requires explicit authorization for a disposable database and migration execution.
The earlier diagnostic receipts are copied under `evidence/tooling/` with their
original provenance; they are not a claim that a fresh native download succeeded.

No production/shared database, IAM/network/security permission, credential,
customer data, provider message, paid model workload or deployment was changed.
