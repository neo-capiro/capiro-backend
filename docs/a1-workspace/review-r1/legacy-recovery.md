# WS-04 owner recovery — review R1

Neo approved owner recovery and an unexecuted unique-match backfill proposal.
Workspace approval removal is handled separately; this change adds no approval
workflow, database execution, migration numbering, or deployment step.

An ordinary draft with a nonblank canonical `client` label and no typed
`clientId` remains held. Its current active owner can read and edit it;
collaborators receive an opaque 404 on read and update. Removed owners remain
denied. Read, update, the drafts list and the unfiltered Workspace library return `clientAssociation: 'held'`. The list
still omits the large config payload. Clearing presentation labels cannot turn
a held draft into an unbound firm draft. Ownership is checked again after the
write lock. Existing tenant, active-membership and immutable-source admission
remain in force.

Client-filtered lists exclude held rows. Share creation, existing public tokens
and guest comments refuse them, and the share index omits their titles and
comment counts. The existing saved-revision staging owner already refuses an
unresolved legacy label; that guard is retained and exercised. An explicit
owner update `{ clientId }` uses the existing active-client and client-wall
check and persists the canonical UUID/name together. A successful bind removes
the held flag. Bound attribution remains immutable. Existing fail-closed
handling of conflicting JSON/column UUIDs and JSON-only malformed labels is
unchanged.

`../ws04-unique-client-backfill.sql` is a proposal only. It selects ordinary,
unbound, non-prospect, non-source-bound rows with exactly one same-tenant active,
non-archived client whose trimmed spelling matches exactly. It sets the typed
column and `config.clientId` together. Zero/multiple matches, inactive/archived
clients, malformed JSON, and existing conflicting JSON UUIDs stay unchanged.
It does not change old versions or grants. Fable still owns live-data review,
snapshotting, locking/batching, migration numbering and rollout. No SQL was run.

## Verification method

`apps/workspace/src/drafts/legacy-client-recovery.spec.ts` executes the real
draft, collaborator, share and library services with a synthetic Prisma seam.
The shared staging check is the built local package's actual implementation.
No database, provider, AWS, or live API is contacted. The canonical
`apps/workspace/jest.config.cjs` is used, with the local cached toolchain and a
temporary cache directory. This is not a fresh frozen-install receipt or a
PostgreSQL/RLS/concurrency qualification.

The companion `legacy-recovery.json` records the final green receipt and the
targeted behavioral mutants. Each mutant is removed before the next run. The
staging mutant changes only the isolated emitted package copy, never tracked
shared source. The suite covers owner recovery, collaborator and removed-owner
refusal, locked ownership, label preservation, client-filter isolation, release
and public-token holds, share-index exclusion, failed and successful binding,
staging refusal, and the recovery wire flag.

## Result

The restored real-tree recovery suite passes **16/16** in the combined canonical
Workspace run. **15/15 targeted behavioral mutants are killed**, with zero
runtime-error kills. These include the separately renamed held-owner authority
case. The first membership mutation was a TypeScript-only failure and is
excluded; a corrected behavior-only retry is recorded. A tool reset interrupted
the first binding no-op attempt before a result; source was restored, audited,
and the retry ran in isolation. The residual seven mutations used a copied
Workspace source tree and actual compiled shared implementation under `/dev/shm`,
with unchanged canonical config bytes. Per-mutation byte backups and snapshot
hashes were saved; both isolated and real intended sources were verified after
restoration.

The broader combined receipt has 123 passed tests in eight passing suites, plus
one suite that cannot load the locally absent cached `pdfkit` dependency. This
does not establish a passing combined or full Workspace gate. No dependency was
added to disguise that limitation.
