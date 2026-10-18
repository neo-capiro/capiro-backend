# Core staged minimal build input packet - 2026-10-18

**Status: source and local archive ready for release qualification; no build or
runtime activation.** The frozen Core source is
`7b1bde0a70026db9b708e4eb05444022d714cf57`, descended from the integrated
receiver `63e426b0cd8ea82857268ea2c5541cc3b78eda17` and PR86 base
`b40971b1f8de888687a8fb92fbdf4ff653fe10d3`. Its Docker context has the
same tracked Git blobs as `63e426b0`; the new commit guards the preparer and
checked-in build recipe against the old blocking Stage 1 migration and updates
handoff facts. The historic `4b858a87b05f0e189e9423a0f16a8de98eb96855`
archive has an unconditional SQLSTATE `55000` in `090000` and must not be used
for this cut. Its ZIP or image cannot be relabeled with this source SHA.

## Exact local build inputs

| Evidence | Frozen value |
| --- | --- |
| Core source/tree | `7b1bde0a70026db9b708e4eb05444022d714cf57` / `6cd7a3c3beb9aaba23856442bedb35ef9ce72211` |
| Tracked Docker input inventory | 6,297 files; 118,649,142 Git blob bytes; ordered inventory SHA-256 `54fb49e8bddf0bd4012b4349d91407efa54406a609fb86b8fc3fa108d0643c1e` |
| PR86-base to source diff | 157 paths; binary diff SHA-256 `3c4c99ad89124e727b33fe27838d444127ac412ef85925131439a4ded31607c7` |
| Dockerfile / checked-in buildspec Git bytes | SHA-256 `86f5ed2b91cce3c9821a679c93363216af49d464213b7930cd8db51f915a57d2` / `eab9286249f8d101f39d9abd09052248ee7bb5d74095419b2b680fa60b0e67f3` |
| Stage 1 `090000` Git/archive LF SQL | SHA-256 `f9d2f4a13474a1af97afdd9b5b8587a6e27e90a36d07fdd1e6f30344bb595c51`; the Windows CRLF checkout hash `0e358884bff11be352931045e212f60e4a5aa607d656a442b72ad94e218d0fa1` is **not** the ZIP's SQL bytes |
| Local ZIP | `../core-7b1bde0a70026db9b708e4eb05444022d714cf57.zip`; 43,389,886 bytes; SHA-256 `00839c9383a955e66bca028ca92f7857416a9cc1995ea9b324725abf73dc5ff1` |
| Local manifest | `../core-7b1bde0a70026db9b708e4eb05444022d714cf57-manifest.json`; derived future S3 key `inputs/core-7b1bde0a70026db9b708e4eb05444022d714cf57.zip` |

The tracked-only preparer selected the Dockerfile's reviewed `COPY` inputs,
rejected the held
`apps/api/prisma/migrations/20281018100000_meri_memory_eligibility_helper`
directory, checked Stage 1's Git blob hash, and verified all 6,297 decompressed
file entries against their Git blob IDs (7,182 ZIP entries including directories).
Its separate `--verify-archive` pass and `Get-FileHash` agreed on the ZIP SHA.
Manifest-only negative checks rejected both old `4b858a87` (its `090000` hash
is `d8065f6edb1aaf406dc4cf7c4c84a5fc125dc8f2b5f45ec58e06a91d4deebad6`)
and the held helper branch containing `100000`. The preparer and checked-in
buildspec stop on wrong Stage 1 bytes or present `100000`; the checked-in
buildspec performs those checks before ECR login and Docker build. A local
checked-in recipe does not change CodeBuild's separately stored inline recipe.

Recreate and verify this exact packet from the repository root with:

```sh
node infra/deploy/prepare-first-chat-core-source.mjs \
  --ref 7b1bde0a70026db9b708e4eb05444022d714cf57 \
  --base b40971b1f8de888687a8fb92fbdf4ff653fe10d3 \
  --archive ../core-7b1bde0a70026db9b708e4eb05444022d714cf57.zip \
  --manifest ../core-7b1bde0a70026db9b708e4eb05444022d714cf57-manifest.json
```

The create command refuses to overwrite either local output. To recheck the
existing ZIP, replace `--archive` with `--verify-archive` and omit `--manifest`.
The Docker input inventory is byte-identical to `63e426b0`; the preceding
integrated lane passed 31/31 combined focused tests, the exact `63e426b0`
HTTP mount test passed 2/2, and the local API build passed before the final
test/documentation/packet-guard commits. These checks are source evidence,
not an image build, migration installation or preview readback.

## Source boundary with Meri

Meri draft PR174 at `4c95aa2c92beae0dbe68e786757ba567985d7c59`
provides the durable task-scoped `loadPrevious`/`retain` continuation source.
Its signed page, proof, helper and dotted proposal alias transport matches
Core `63e426b0`, which this packet descends from without changing receiver
wire. PR174 still needs its numbered continuation-table migration, retention
inventory and purge wiring, atomic suppression fence, cross-host receipt clock
qualification, and measured runtime image/config/readback. Meri's handoff
should pin this Core source instead of older `8712e508`. Core's issuer and
receiver remain hard disabled before one-use token consumption; the document
receiver remains 503 without its independent identity provider. The eleven
retained read adapters are source-wired, not proven available in preview.

## Required target and release readbacks

1. **Stage 1 Core database.** For each named target, read `_prisma_migrations`
   applied/checksum/status for original `020000`, `080000`, and unapplied,
   nonfailed `090000`; inspect the exact table, constraints, trigger/function,
   RLS and ACL, counts of old non-null/orphan/held receipt payloads, and a
   restorable snapshot. Rehearse the actual target shape and old/new writers on
   a disposable clone with the lock window before applying `090000`. A failed
   or applied `090000` or schema drift requires a separate forward/recovery
   plan, never a migration-ledger rewrite. Read back checksum, schema and
   payload counts after migration. Stage 1 makes `candidate` nullable and
   preserves all values; purge remains held while that seventh column exists.
2. **Held helper and Meri database.** Core `100000` is outside this archive and
   requires a separate source packet after `060000`/`090000`, target role/RLS
   qualification and bounded DDL window. Meri must allocate and install its
   PR174 continuation migration and read back its retention/suppression
   behavior. Separately read back Meri facts `0001`, prepared-approval facts
   `0002`, integration grants, actual restricted `capiro_app` view-only access
   and installer `current_user`/`session_user`/owner role choreography. Preserve
   `current_admission_v1`'s exact original ADMITTED grant set and transaction
   lock; the Core proposal-lock issuance transaction remains required. No new
   table SELECT grant is proposed here.
3. **Before any paid image build.** Read back the existing CodeBuild project
   source bucket/key/version, actual **inline** buildspec SHA/content, role,
   environment, architecture and timeout. The reviewed inline recipe must
   contain the same Stage 1/held-helper checks as the checked-in hash above.
   Bind `APPROVED_SOURCE_SHA` to this exact Core source, the ZIP SHA above and
   the separately observed immutable S3 VersionId, with no StartBuild
   overrides. After an authorized build, read back ECR immutable digest and
   scan. None of this has run for this packet.
4. **Before traffic or receiver activation.** Read back the current ALB listener
   first-match ordering, allocated guard after P3, guard then service, ECS task
   source/image/effective config, task definition and approved 1 vCPU / 2 GiB
   (`cpu:1024`, `memoryLimitMiB:2048`) template. Current source pins are not
   an observed running task; desired count remains zero in the reviewed
   packet. Confirm KMS signer/public pins, service secret, signed Meri relay,
   Meri/FE cohort, and authenticated owner flow. The document identity reader
   additionally needs approved service-filtered ECS task/task-definition
   readback, immutable digest-to-source and independent effective-config hash
   providers, with before/after allocation checks. It is unregistered, so
   token/header assertions or environment declarations cannot open documents.

No ZIP upload, paid build, AWS write, live SQL, security grant, credential,
listener mutation or route activation occurred in this packet. The source is
ready to receive the remaining Meri source and target-specific release facts;
it is not a deploy approval.
