# Source qualification

Reviewed runtime/source: `539f62e7f2a3f87d9f56f1281e6fff717aed0958`, based on
main `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. Later commits contain documentation
and evidence only. The two pre-change runtime files match policy reference
`fd8765ec01d292013758606204f2c9d886cd31c1` byte for byte.

Implementer: **123/123 tests in 9 suites**, including eight exact-wording,
pending-shape and personal-alternative-offer controls. The API primary TypeScript
check (`tsc --noEmit --rootDir .`, 8 GiB heap) passes. Dependencies were borrowed
from the preserved sender worktree's frozen installation; no install or generated
client changes were made in that worktree.

Independent reviewer: **150/150 tests in 16 suites**, including the implementer's
selection and 27 routing/capability controls. A separate closed-sandbox comparison
of **540 base/head rule decisions** preserved all outcomes, rule IDs and
non-target reasons; all 180 automated-source cases remain WARN. These matrix
checks are distinct from the Jest test count. All four supplied public strings
match the coordinator's handoff exactly. Independent full-file AST fingerprinting
confirms only two shared reason initializers, the pending message initializer,
and comments differ in runtime source. No blocking finding remains.

Retained behavioral suites cover mandatory pending creation, administrator
own/other approval, ordinary firm denial, client grant/assignment/nonself checks,
current authorization, self-rejection versus withdrawal, private ownership and
automated candidates. Authorization evaluators and canonical enforcement were
not changed. Some existing mocked projection tests emit expected warnings because
their fixture does not implement the embedding port; all assertions pass and no
paid model call is made.

No failed assertions in this candidate. No database, migration, real provider,
live state, deployment or permission operation ran. The reviewer did not run a
second heavy compiler; the implementer's completed primary check is separately
identified. No full repository test suite, native Prisma/Postgres qualification
or deployment qualification is claimed. Lint remains unavailable because the
repository has no ESLint dependency/configuration; the separate Core Quick log
candidate contains the exact environment/tooling diagnosis.

All requested preserved-candidate changed-path intersections are empty. Complete
supplied handoff, raw tests, independent review, scope fingerprints, test receipts
and checksums are retained under `evidence/`.
