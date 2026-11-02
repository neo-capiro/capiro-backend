# FY26 bill jobs on the preview clone

Canonical source is `neo-capiro/capiro-backend`, integration branch
`backend-import`. `scripts/release-bill-ingestion.py` runs only bounded bill
tasks in account `967807252336`, region `us-east-1`, cluster `capiro-dev`, database
`capiro` on `capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com`.
It does not deploy an ECS service or change IAM. Existing parent IDs, immutable
revisions, citations and ingestion checkpoints remain in place.

Root owns integration, independent review, the release lock, AWS writes and live
acceptance. Run the operator from a clean checkout of the merged integration tip,
on `backend-import` or detached at that exact commit. It verifies the canonical
origin URL, local remote-tracking tip and current GitHub branch tip. A feature
branch, dirty checkout or older merged commit is refused. No Actions environment
variables are needed or accepted as source evidence.

Build the exact merged source using the existing
`infra/deploy/first-chat-core-preview.buildspec.yml` and
`apps/api/Dockerfile.alpine-qualification` path. Keep the existing versioned S3
archive pins, native ARM64 build, runtime probes and immutable ECR source tag.
Root must verify the build source/revision labels, isolated database checks and
full exact-digest scan with zero HIGH/CRITICAL findings before supplying
`--qualified-digest`. The operator cross-checks that digest against
`capiro/preview-core:<source-sha>` in the immutable repository. This argument
records root's qualification decision; it does not perform or replace those
checks. Do not enable quarantined workflows or build the old capirov2 image.

## Commands

Python 3.9+ and an authenticated AWS CLI are required. Use the configured
`default` profile. Receipts must use absolute paths outside the source checkout,
with a new filename per invocation. The destination directory must exist.
The examples use shell variables for the reviewed commit, digest and receipt.

```sh
python -B scripts/test_release_bill_ingestion.py
python -B scripts/release-bill-ingestion.py --help

# Read configuration without registering or starting a task.
python -B scripts/release-bill-ingestion.py --operation inspect --job index --source-sha "$SOURCE_SHA"

# Run the idempotent index command against the existing clone.
python -B scripts/release-bill-ingestion.py --operation run --job index --commit --source-sha "$SOURCE_SHA" --qualified-digest "$DIGEST" --receipt "$INDEX_RECEIPT"

# Small same-image passage canary. Repeat with state-passages.
python -B scripts/release-bill-ingestion.py --operation run --job federal-passages --limit 1 --commit --source-sha "$SOURCE_SHA" --qualified-digest "$DIGEST" --receipt "$CANARY_RECEIPT"

# After root checks the remaining monthly allowance and reserves needed calls:
# One atomic state metadata dataset, then a bounded state document drain.
python -B scripts/release-bill-ingestion.py --operation run --job state-dataset --states CA --commit --source-sha "$SOURCE_SHA" --qualified-digest "$DIGEST" --receipt "$DATASET_RECEIPT"
python -B scripts/release-bill-ingestion.py --operation run --job state-drain --states CA --limit 3 --commit --source-sha "$SOURCE_SHA" --qualified-digest "$DIGEST" --receipt "$DRAIN_RECEIPT"

# Each schedule command first runs its exact scheduled command as a canary.
python -B scripts/release-bill-ingestion.py --operation schedule --job federal-text --limit 400 --commit --source-sha "$SOURCE_SHA" --qualified-digest "$DIGEST" --receipt "$TEXT_RECEIPT"
python -B scripts/release-bill-ingestion.py --operation schedule --job federal-passages --limit 1000 --commit --source-sha "$SOURCE_SHA" --qualified-digest "$DIGEST" --receipt "$FEDERAL_RECEIPT"
python -B scripts/release-bill-ingestion.py --operation schedule --job state-passages --limit 1000 --commit --source-sha "$SOURCE_SHA" --qualified-digest "$DIGEST" --receipt "$STATE_RECEIPT"
```

The index command creates/verifies the already approved partial lexical/vector
indexes without editing Prisma's migration ledger. Root first reconciles the
clone ledger and index definitions. Any forward Prisma migration requires a
fresh clone snapshot and the canonical migration procedure; do not reset the
clone or mark migrations applied merely to satisfy a ledger comparison.

## Schedule replacement and recovery

Only these existing enabled rules can be replaced:

| Rule suffix under `capiro-dev-fy26-bills-` | UTC schedule | Limit |
| --- | --- | ---: |
| `federal-text` | `cron(0 * * * ? *)` | 400 packages |
| `federal-passages` | `cron(10 * * * ? *)` | 1,000 passages |
| `state-passages` | `cron(20 * * * ? *)` | 1,000 passages |

Each replacement requires an exit-zero canary on the exact image digest and one
zero-error ingestion metric for the expected source. A skipped/locked run is
insufficient. Schedule around existing timers to avoid that collision. Before
replacement the operator rechecks the clean integration source and complete
original rule/target snapshot. It changes only the existing target's task
definition ARN, preserving its ID, command, role, network and enabled schedule;
then it verifies complete readback. EventBridge has no compare-and-swap API, so
root's release lock remains necessary. The seven original ingestion rules are
read-only inputs and remain unchanged.

Receipts record the original schedule target, candidate task definition, task
ARN and outcome. Exit 0 means the requested operation completed; exit 1 means a
guard or runtime failure; exit 2 means CLI usage was invalid. On a timeout,
failed target write or failed readback, inspect the receipt and actual task/rule
before retrying. A failed readback can follow a successful write. Root can
restore the exact saved `scheduleBefore.target` with EventBridge `PutTargets`
under the same rule and release lock after checking for concurrent changes.
Confirm a later timer-triggered task, exact digest and zero-error receipt before
declaring schedule acceptance; manual canaries alone do not establish that.

The configured LegiScan account reported 10,095 of 10,000 queries used on
2026-11-02, resetting December 1; Neo accepted that actual limit. The effective
soft budget is 9,000 and hard ceiling 10,000. No API requests remain authorized
for this month. The existing checkpoint stores a durable month/key capacity
hold checked before every API attempt/retry; it does not fabricate usage counts.
Root can seed the captured observation with `record-legiscan-capacity-hold
--month 2026-11 --observed-used 10095 --observed-limit 10000 --commit
--expected-host <clone-host>`, supplying the same configured key privately in
the environment. This makes zero provider calls. A new month or different key
uses a different hold. Same-key recovery requires explicit `--release
--confirmed-account-change`, fresh reported usage below the limit and a process
restart; never probe repeatedly to discover recovery. Cached imports and
publisher-only downloads remain available. Prioritize Florida one-shots first,
then continue the remaining jurisdictions and federal scope.
`state-dataset` and `state-drain` are explicit
commit-only, one-shot commands; neither can be scheduled by this operator.
Datasets require exactly one state per invocation. Dataset exports supply bill,
roll-call and person metadata; they do not contain `getBillText` bodies. Full
document retrieval therefore requires separately budgeted bounded drains and
may span allowance windows. `state-drain` now invokes `sync-state-text-drain`,
which reads the existing due document queue and retained primary-format stubs;
it does not spend `getBill` calls to rediscover metadata. Official publisher
bytes are admitted only after exact frozen MD5, byte-size and MIME checks, using
the existing DNS-pinned transport and explicit publisher/redirect policy. A
blocked publisher, fragment-only historical URL or byte mismatch remains an
explicit gap; the existing API fallback requires a successful quota reservation
and charges failed attempts and retries. At the soft budget, publisher retrieval
can continue while API calls remain held. The direct CLI also supports
`--publisher-only`. State passages embed stored text without provider calls.

For the Florida-first run use `--job state-drain --states FL --publisher-only`.
The bounded queue gives text and amendments precedence over supplements and
keeps each historical hash's retry state independent. Use `--job state-passages
--states FL --phase extract`, then the same scope with `--phase embed`; the
state filter has its own checkpoint and does not reset the global cursor.
Filtered passage jobs cannot replace an existing global schedule.

Federal cached metadata uses `--job federal-archive --federal-type hr
--archive-hash <staged-sha256> --archive-bills <exact-count>`. Run each of the
eight types through its exact retained archive. The amendment list is staged
by the offline cache CLI and must match its frozen hash. `--job
federal-inventory --archive-hashes <eight-distinct-sha256s>
--amendment-list-hash <sha256> --federal-stage metadata|inventory|hydrate|finalize`
runs one bounded phase (`--limit`, `--request-cap`). Only metadata/inventory
inject the existing `capiro/dev/congress_gov_api_key` reference. Archive,
hydrate and finalize carry no provider credentials. These jobs are one-shot
only and retain the same source, clone, role, image and receipt guards.

State metadata, masterlist, status derivation, historical import, research
hydration and text drain share per-state checkpoint leases; actual mutations
are fenced by the lease token inside their transactions. Deployed older images
do not honor this lease. Root must replace or quiesce the original state writers
before overlapping backfills; source integration alone does not establish one
live writer. Only the two state writer commands receive the LegiScan secret.
Preserve existing state writer schedules; no quota or budget increase is implied.

## Frozen archive import without provider calls

First stage the exact independently captured global discovery manifest, using
`import-state-discovery --manifest FILE --sha256 SHA256` for offline preview and
the same `--commit --expected-host CLONE_HOST` pair for the clone. It requires
all 51 unique jurisdictions marked complete, pins each expected session and
archive hash/count, and preserves the exact manifest bytes in the existing
archive owner. Coverage treats a missing expected session receipt as unknown;
an empty jurisdiction is known empty only when this manifest says so. The
`fy26-state-discovery` receipt does not imply any metadata or text was loaded.

`import-state-dataset-cache` validates an exact SHA256, state, session and full
provider parent count before writing. The existing ZIP parser bounds compressed
bytes to 120 MB, expanded JSON to 512 MB and entries to 50,000; the importer
allows at most 50,000 parents, including the reviewed NY export's 25,453. It
retains original ZIP bytes and an immutable FY26-admitted inventory receipt
before creating metadata. Receipt `complete` means the frozen source list is
known, never that document download, extraction or embeddings are complete.

Stage an already verified local ZIP with the qualified runtime and clone
configuration, then import bounded batches from its stored hash:

```sh
node --import tsx scripts/import-state-dataset-cache.ts --state NY --session 2188 --expected-bills 25453 --archive "$ARCHIVE" --sha256 "$ARCHIVE_SHA" --inventory-only --commit --expected-host "$CLONE_HOST"
python -B scripts/release-bill-ingestion.py --operation run --job state-archive --states NY --archive-session 2188 --archive-bills 25453 --archive-hash "$ARCHIVE_SHA" --limit 100 --commit --source-sha "$SOURCE_SHA" --qualified-digest "$DIGEST" --receipt "$ARCHIVE_RECEIPT"
```

Omit `--commit` for validation/preview. The ECS archive job receives database
secrets only. It never queries LegiScan, changes recurring rules or requires new
storage permissions. Batches resume from the existing checkpoint owner; each
parent's writes and checkpoint advance commit together. Existing metadata,
sponsors, links and current cursor work remain intact. Frozen evidence and
missing version identities append only for a matching canonical provider bill.
Conflicting identities remain explicit holds.

Document retries use one existing queue row per exact kind/provider-ID/hash.
Legacy ID-only rows fan out idempotently, preserving separate old/new hash
retry histories; unavailable historical bytes cannot hide a retrievable newer
hash. The ordinary metadata refresher excludes these exact-version checks.
Valid retained bytes wait for extraction without another network request.

The canonical image build now runs an isolated native PostgreSQL gate after
runtime probes and before push. Source preparation includes six exact existing
Jest harness files. Its only certificate exception is the required public
[RDS trust bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)
at `apps/api/scripts/funding-worker/rds-global-bundle.pem`, pinned to raw Git
SHA256 `90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b`.
All other secret-file exclusions remain enforced.

## Opt-in known-parent polling for the remaining states

`LEGISCAN_FY26_WIDE_ENABLED=true` on the existing masterlist and bill-drain jobs
adds the other 43 states without adding a recurring rule. The default priority
state behavior is unchanged. Wide masterlist calls occur no more than daily
per session, including failed attempts. They require the archived global
discovery manifest, all expected session receipts for the jurisdiction, and an
actually persisted admitted canonical parent with its retained hash. Unknown,
excluded and not-yet-imported parents are not queued for speculative `getBill`.

The wide drain preserves unrelated pending work, updates only admitted known
parents and queues exact document hashes for publisher-first hydration. New
wide API calls use the same four-attempt reservation owner as document fallback,
charge retries/failures, and refuse calls at the existing soft/hard budgets.
This option refreshes known parents. After qualification, optionally set
`LEGISCAN_FY26_DATASET_REFRESH_ENABLED=true` and the exact image `GIT_SHA` on the
same existing hourly masterlist job to discover late-published FY26 parents.
It starts a cycle only at least seven days after the previous completed global
receipt. Each invocation performs one state discovery or one session's archive
stage/import, with at most 1,000 parent writes and a ten-minute slice deadline.
Provider calls use bounded single-attempt transport and the existing reservation
owner. Failed requests remain charged; later hourly opportunities resume.

The archive phase acquires only the selected state's shared writer lease after
the masterlist leases are released. The existing checkpoint
`fy26-state-dataset-refresh` records pending phases, source observation time and
explicit failures. Missing historical sessions, mismatched archives or budget
holds never publish a replacement global denominator. The previous global
manifest remains authoritative until the full cycle is qualified. A cycle may
span more than a week; report its pending state and source age without asserting
a weekly completion guarantee.

Initial publisher backfill can use operator `--job state-drain --publisher-only`
to omit the LegiScan credential and prohibit API fallback. Run structured
extraction separately with `--job state-passages --phase extract` or
`--job federal-passages --phase extract`; these are one-shot phases and do not
replace the existing embedding schedules.
