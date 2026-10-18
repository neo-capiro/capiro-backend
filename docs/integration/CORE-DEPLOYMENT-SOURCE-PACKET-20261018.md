# Core deployment source packet — 2026-10-18

For the single shipping owner. **Source handoff only; activation is held.** This
packet adds no runtime configuration and authorizes no AWS, SQL, credential,
grant, build, paid source call, or production cutover. Use the state vocabulary
and coordinating scope in the [remaining deployment plan](../deployment/CAPIRO-REMAINING-DEPLOYMENT-PLAN-20261017.md).

## Source pins observed for this packet

GitHub PR metadata was read on 2026-10-18 at approximately 14:35 UTC. These are
source revisions, not image or running-service attestations. Reconcile later
receiving commits before freezing the build input.

| Source | Exact observed head | Meaning |
| --- | --- | --- |
| [Core PR87](https://github.com/neo-capiro/capiro-backend/pull/87) | `8130f4404d770db396b6732aac436d6e9ac93b82` | This packet's exact source base; draft, stacked on PR86. |
| [Core PR86](https://github.com/neo-capiro/capiro-backend/pull/86) | `b40971b1f8de888687a8fb92fbdf4ff653fe10d3` | Preview template, snapshot installer and successor source in PR87 ancestry. |
| [Meri PR157](https://github.com/neo-capiro/meri-greenfield/pull/157) | `ab83ee97e9cb88b4727291284da9e2485157c309` | Integration SQL already mirrors the Core snapshot function and temporary installer-role choreography in source. |
| [Meri PR158](https://github.com/neo-capiro/meri-greenfield/pull/158) | `cdc1c04342da022117401284b4e6bbac032ef84d` | Retained source adapters; shared signed task relay remains a receiving dependency. |
| [Meri PR160](https://github.com/neo-capiro/meri-greenfield/pull/160) | `0114f1a97ff9ca0f7b90ec281b557d0d24c1d225` | Profile successor `get_client_context@0.3.0`; shared catalog/validator/skill/measurement receipt remains outstanding. |

The document-owner and memory successor lanes are pending stacked source work;
they are not included in this frozen base or a qualified integrated image.
There is no new accepted frontend/chat source-and-image pair in this packet.
The [existing-preview cohort record](CORE-SUCCESSOR-CHAT-COHORT-20261018.md)
reports Meri N17 `4172e474`, Core rev 2 `ade7fc88` and FE rev 17 `4ea553fe`.
Treat those as historical reports: the shipping owner must read back the current
FE/chat source, image, task and compatibility before replacement.

## Template and listener contract

The authoritative [Core preview template](../../infra/cdk/lib/preview/first-chat-core.ts)
encodes **1 vCPU / 2 GiB per task** (`cpu: 1024`, `memoryLimitMiB: 2048`),
Linux/x86_64 and a held service (`desiredCount: 0`). The size is user approved
source configuration. The current task definition, service and replica count
have not been read back here; retain their rollback revisions and verify actual
capacity before and after an independently authorized change.

`FIRST_CHAT_CORE_IMAGE_PINS` is **null**. The production renderer refuses until
a qualified integrated image's full `sourceHead` and immutable `imageDigest`
are committed together. The retired PR48 source/digest is rejected.
`RELEASE_SHA` and the digest-addressed ECR image follow that exact binding.

The bounded [render entry point](../../infra/cdk/bin/preview-first-chat-core.ts)
accepts a binding with exactly `schemaVersion`, `sourceHead`, `imageDigest`,
`internalServiceSecretArn`, `retainedTrust`, `listener`, `previewTenantId`,
`profile`, and `signers`. Required values are not filled with synthetic pins:

- **v5:** `listener: {guardPriority}` is the chat packet. **v6:** exact
  `{memoryPostPriority,guardPriority}`; `memoryPostPriority: null` retains that
  packet. A numeric memory slot is a separate held route expansion.
- `internalServiceSecretArn` must be the complete ARN of
  `meri/preview/core/internal-service-secret` in `967807252336/us-east-1`, shared
  with Meri. Its value needs no surrounding whitespace. No secret value belongs
  in this packet or frontend configuration.
- `previewTenantId` is a UUID. `profile` supplies five positive integers:
  `executionMaxTurns`, `executionMaxRuntimeSeconds`, `executionMaxCostMicrousd`,
  `routineMaxCostMicrousd`, `routineMaxRuntimeSeconds`. The recorded D016 profile
  is 20 / 900 / 2000000 / 2000000 / 900; this is not an observed live setting.
- `signers` has exactly `execution`, `routineCancel`, `routineFire`, and
  `readDelegation`. Each is null or `{issuer,kid,keyArn,publicKeyX}`, with a
  distinct key and kid per purpose. Public pins require actual `GetPublicKey`
  evidence. The task policy restricts configured keys to `kms:Sign` with
  `ED25519_SHA_512` and `RAW`; absent signers leave their routes unavailable.
- `retainedTrust: null` disables the separate principal/probe retained transport.
  Enabling it needs the exact issuer, HTTPS Intel origin, distinct principal and
  probe key IDs/private-key secret ARNs, matching Intel public pins and image,
  and RFC 8785 qualification. These are separate from the Option B read signer.

Use the [exact route manifest](../../infra/cdk/lib/preview/first-chat-core-routes.json)
and [first-match model](../../infra/routing/capiro-prod-alb-first-match.mjs): P1
Core POST, P2 Core GET, P3 native-operations POST, then the host-only 404 guard.
The host is `first-chat-preview.app-dev.capiro.ai`. On a **fresh listener
readback**, `corePreviewPacketRules(readback,routes,{guardPriority})` must prove
the guard slot vacant, after P3, and before the first shared rule matching the
host. P4 is not assumed. Update `Capiro-Preview-First-Chat-Core-Guard` first to
free P3, then `Capiro-Preview-First-Chat-Core`; the source stack dependency and
retained guard export encode that order.

For numeric v6, require `corePreviewMemoryRules` on the modeled chat packet:
`3 < memoryPostPriority < guardPriority`, both slots qualified before shared
host matches. Both frozen layouts lack a safe extra slot. Central listener
allocation and current readback remain required. The template preserves the
existing P1/P2 logical IDs; it does not allocate or move shared rules. Host,
method and three paths consume the five match evaluations in P3, so it cannot
accept another path value. Network forwarding does not establish application
authorization or route availability.

## Database installation and authority gates

The [snapshot proposal](CORE-ADMISSION-SNAPSHOT-FUNCTION-20261018.sql), Core Git
blob `424b4565afbcc5f9ced7ac25b374a4bda2adf1e7`, has its function definition
mirrored in Meri's [integration SQL at the observed pin](https://github.com/neo-capiro/meri-greenfield/blob/ab83ee97e9cb88b4727291284da9e2485157c309/infra/product-preview/first-chat-database-integration.sql),
blob `c43794f3fa00e070f7e4546dba25b6f6757b1ef7`. Definitions compare equal after
line-ending normalization. Source receipt is established; installation is not.
Meri's migration packet/hash and deployed phase ledger still need exact preflight.

The verified installer must start with `current_user = session_user`, be able
to create the dedicated NOLOGIN/NOINHERIT reader, SET ROLE
`meri_product_migrator`, grant temporary SET-only reader membership, and create
the authority schema. The installation transaction:

1. Grants the installer reader membership with `SET TRUE, INHERIT FALSE, ADMIN
   FALSE`. As the Meri object owner, grants the reader the exact table reads and
   `UPDATE(quarantined)` solely for PostgreSQL's budget `FOR SHARE` requirement.
2. Gives the reader temporary schema CREATE plus retained USAGE; creates
   `meri_core_authority.current_admission_v1(uuid,uuid,uuid)` as that reader,
   SECURITY DEFINER, VOLATILE, PARALLEL UNSAFE, fixed `pg_catalog,pg_temp` path.
3. Revokes PUBLIC EXECUTE, grants only verified Core app role `capiro_app`
   schema USAGE/function EXECUTE, resets role, revokes reader schema CREATE and
   the installer's temporary membership before COMMIT. PostgreSQL 16 may retain
   the creator's bootstrap ADMIN-only edge; verify its SET/INHERIT options are
   false. Do not report that edge as a surviving SET privilege.

Core takes its proposal advisory lock before calling on the same transaction.
The function takes the canonical budget `FOR SHARE`, then database time in its
own statement, then the saved original ADMITTED binding/allocation/grant facts
and ordered grants. Preserve the exact grant set and Core predicate. A facts
view row alone is not current admission.

Before any live SQL, the shipping owner needs actual installer capabilities,
the app credential's **username only**, base-table ownership/grant options,
deployment ledger/checksums, snapshot/restore evidence, and reviewed rollback.
Do not rerun successful installation phases or replace migration history.

| Dependency | Source evidence / remaining shipping requirement |
| --- | --- |
| Core migrations | Reconcile actual `_prisma_migrations` against the selected source, including altered `20281018020000_clio_meri_memory_submissions` and out-of-order history noted in the ledger. Option B uses `20281018060000_meri_read_delegation`; the isolated draft `070000` is superseded. Pending memory index proposals need their own allocation and duplicate preflight. |
| Option B facts | Meri `read-delegation/migrations/0001_read_delegation_facts.sql`; `capiro_app` USAGE on `meri_read_delegation_facts` and SELECT only on `run_facts_v1`, `reservations_v1`, `occurrences_v1`, `schedules_v1`, plus the snapshot EXECUTE above. Apply/readback status is unverified. |
| Approval metadata | Core's `native-approval-metadata.ts` directly SELECTs `meri_commands.approval_metadata`. The observed Meri integration SQL grants Core only the four facts views and snapshot, and its privilege audit rejects other Core Meri-table access. Reconcile this narrow owner-read contract and its audit before execution activation; the snapshot does not supply approval metadata. No grant was added here. |
| Execution cohort | Successor preview `create_task` removes the ordinary bearer fallback. Meri `features.intents.execution`, its matching verifier/grant composition, Core signer/pins, exact service identity, snapshot and migrations must ship together. Retain the compatible existing cohort until proven. |

## Retained reads and remaining source receipt

At the exact Core PR87 pin, ten retained operations have owner reads and full
pinned output validation. `get_client_context` accepts **0.3.0 only**, schema
SHA-256 `7d422f92a4771b2d7e869e45371396c12b8a69934f9cb8ca50f5821ccab514a2`.
The other ten operation IDs remain 0.2.0, including the **503**
`read_client_documents`. The [retained handoff](CORE-RETAINED-SOURCE-V02-HANDOFF-20261018.md)
records exact families, signed correlation, single-use token, owner window,
16 MiB output ceiling and final release checks. **All eleven remain unavailable
in the preview runtime.**

Meri must receive the 0.3 catalog/validator/skill/measurement slice without
silently reinterpreting 0.2 or duplicating its registry row, and compose the
signed post-UNKNOWN task relay with trusted invocation ID/tool credential,
exact body and correlation digests. Preserve the measured 76 operations; the
profile successor operation-list digest is
`2b7e65b59487a85bbf8c938d42a76865c4eb8b3e9b5cab4330e1b8399a9fa973`.
The read-delegation key, facts, migrations, listener and service readbacks are
separate gates. Paid document extraction still needs measured pricing and an
enforced pre-call audio-duration cap in its actual owner before receiver receipt.
Personal and Portfolio reads require their own subjects/authority.

Objective D7-3 remains a separate held dependency: source parser/echo exists,
while issuer/post-effect routes, later-phase adapters, authenticated original
ISSUED-run evidence, stable effect reconciliation, keys, policy and fence
decision remain open. See [source status](OBJECTIVE-D7-3-SOURCE-STATUS.md).
Routine wire C and native memory review also need their own qualified runtime
cohort and grants/route receipt; source presence is not acceptance.

## Shipping evidence to attach later

Follow the [integrated build packet](CORE-INTEGRATED-IMAGE-BUILD-20261018.md):
freeze the final received Core commit; review the full repository-root archive;
bind its SHA-256, exact S3 VersionId and derived `inputs/core-<SHA>.zip` key to the
reviewed CodeBuild source/project/buildspec with no overrides. Build linux/amd64,
complete in-image smoke and independent immutable ECR digest readback and scan
(zero findings required by that packet), then commit both image pins. The
checked-in recipe does not update the project or perform ECS/SQL actions.

The shipping owner must then attach matching Core/Meri/FE source and image
pins; exact binding/feature/profile and public-key evidence; successful database
preflight/install/grant readbacks; listener ownership, first-match and ordered
change/rollback records; current and new task definitions/service/target health;
and real authenticated sign-in, selected-client bootstrap, first stream,
reload/history, second prompt, Stop and next-prompt evidence. Keep
`os.capiro.ai` as the canonical production origin. A preview source packet does
not establish production routing, Clerk acceptance or production cutover.

## Checks performed for this packet

Docs-only change on the exact Core PR87 base. Local focused checks:
`node --test infra/routing/capiro-prod-alb-first-match.test.mjs` **10/10**;
`node --test infra/deploy/first-chat-core-preview-source-pin.spec.mjs` **3/3**;
`git diff --check` clean. The snapshot definition comparison and template
capacity/held-service/image-pin inspection are source checks. No CDK deploy,
live AWS/SQL, credential read, grant, image build or paid source call was run.
