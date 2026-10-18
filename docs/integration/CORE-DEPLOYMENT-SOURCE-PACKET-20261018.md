# Core deployment source packet — 2026-10-18

For the single shipping owner. **Source handoff only; activation is held.** This
packet adds no runtime configuration and authorizes no AWS, SQL, credential,
grant, build, paid source call, or production cutover. Use the state vocabulary
and coordinating scope in the [remaining deployment plan](../deployment/CAPIRO-REMAINING-DEPLOYMENT-PLAN-20261017.md).

## Source pins observed for this packet

Initial source pins were read at approximately 14:35 UTC; document/profile
successor evidence was refreshed at approximately 15:09 UTC on 2026-10-18.
These are source revisions, not image or running-service attestations.
Reconcile the separate receiving branches before freezing one build input.

| Source | Exact observed head | Meaning |
| --- | --- | --- |
| [Core PR87](https://github.com/neo-capiro/capiro-backend/pull/87) | `8130f4404d770db396b6732aac436d6e9ac93b82` | This packet's exact source base; draft, stacked on PR86. |
| [Core PR86](https://github.com/neo-capiro/capiro-backend/pull/86) | `b40971b1f8de888687a8fb92fbdf4ff653fe10d3` | Preview template, snapshot installer and successor source in PR87 ancestry. |
| [Meri PR157](https://github.com/neo-capiro/meri-greenfield/pull/157) | `ab83ee97e9cb88b4727291284da9e2485157c309` | Integration SQL already mirrors the Core snapshot function and temporary installer-role choreography in source. |
| [Core PR92](https://github.com/neo-capiro/capiro-backend/pull/92) | `7f72239d4f7746ea99fe10df701190132af84e87` | Complete document validator and current provider-disabled owner, stacked on PR87. |
| [Core document receiver successor](https://github.com/neo-capiro/capiro-backend/commit/01b5d90c8a50fee6076768dd4f226abb3e258581) | `01b5d90c8a50fee6076768dd4f226abb3e258581` | Branch `codex/core-client-documents-receiver-20261018`, additive to PR92; all eleven operations source-wired, documents still 503 by default. |
| [Meri PR158](https://github.com/neo-capiro/meri-greenfield/pull/158) | `cdc1c04342da022117401284b4e6bbac032ef84d` | Retained source adapter input received by PR161. Shared signed task relay remains a dependency. |
| [Meri PR160](https://github.com/neo-capiro/meri-greenfield/pull/160) | `0114f1a97ff9ca0f7b90ec281b557d0d24c1d225` | Versioned `get_client_context@0.3.0` input received by PR161. |
| [Meri PR161](https://github.com/neo-capiro/meri-greenfield/pull/161) | `f4cf0385471d9c57fbe7c537e3f352a0378ece24` | Profile catalog/validator, nine skill successors and source measurement received; no in-image or runtime receipt. |
| [Meri PR162](https://github.com/neo-capiro/meri-greenfield/pull/162) | `dee9ac55546d9a59dc6bba79cd4fc2cbba869000` | Immutable text-only document allocation variant, stacked on PR161; received by the Core receiver successor. |

The document receiver is a separately published source successor; this PR90
documentation branch still descends directly from PR87 and does not merge its
implementation. Memory successors also need separate source receipt. No
qualified integrated image includes these changes in the evidence here.
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

## All eleven retained operations: source status

PR87 source-wires ten operations. Receiver successor `01b5d90c` adds the
document family after PR92's current owner and full validator. At that exact
successor, **all eleven are source-wired; all eleven remain unavailable in the
preview runtime**. Documents still answer 503 by default. The original
[PR87 retained handoff](CORE-RETAINED-SOURCE-V02-HANDOFF-20261018.md) describes
the baseline; the pinned [document receiver gate](https://github.com/neo-capiro/capiro-backend/blob/01b5d90c8a50fee6076768dd4f226abb3e258581/docs/integration/CORE-CLIENT-DOCUMENTS-RECEIVER-20261018.md)
describes the additive successor.

| Operations | Source version and owner boundary |
| --- | --- |
| `resolve_entity`, `find_contacts` | 0.2.0; canonical entity/contact reads, selected-client wall and full output validation. |
| `get_client_context` | **0.3.0 only**; measured owner read window and full pinned output/cursor/coverage validation. |
| `read_monday_client_boards` | 0.2.0; managed mapping checked around the same canonical owner read. |
| `read_client_documents` | 0.2.0; current inventory, full validator, provider-disabled owner and original ADMITTED text-only allocation/runtime gate below. |
| `mail.list_messages`, `mail.search_messages`, `mail.read_thread` | 0.2.0; verified mailbox scopes constrain owner SQL; same-read scope, body and output proofs. |
| `meeting.list_upcoming_meetings`, `meeting.query_debriefs`, `meeting.read_client_meetings` | 0.2.0; current owner result/inventory, scope, lineage and full output validation. |

Meri PR161 receives the profile catalog/validator/skill/source-measurement
slice, preserving the legacy 0.2 bytes and replacing its single active binding.
Catalog `0.2.16` has SHA-256
`58673ff38658c07e608ad209f007c4c6e30b9ee06a04c0f52afa97ac222bca9c`;
profile schema SHA-256 is
`7d422f92a4771b2d7e869e45371396c12b8a69934f9cb8ca50f5821ccab514a2`.
The measured selection remains **76 operations / 42 families**, operation-list
digest `2b7e65b59487a85bbf8c938d42a76865c4eb8b3e9b5cab4330e1b8399a9fa973`.
Meri must still compose the signed post-UNKNOWN task relay with trusted
`invocationId` / `toolCredential`, exact body/correlation digests and final
release. Source measurement must be rerun in the qualified image. Keys, facts,
migrations, listener and service readbacks remain separate gates. Wired output
is bounded to 16 MiB before delegated release; personal and Portfolio reads
require their own subjects/authority.

### Document text-only allocation and current-runtime gate

Meri PR162 preserves `read_client_documents@0.2.0` and unchanged document
schema SHA-256
`71dd53119af2c0226372916e3645765687e8653da2f48b60d55c1a7a75c05247`.
Its closed `manifest.documentPricing` variant is
`{mode:"source_text_only",route:"/api/clio/tools/read_client_documents",coreSourceCommit,coreImageDigest,configurationSha256}`:
base manifest **1.1.0**, exactly **1 µUSD per call**. Unconditional tariff stays
null. The source/catalog measurement stays **76 operations / 42 families**;
a particular allocation excludes documents when qualified evidence is absent.
Document-bearing 1.0.0 manifests retain only the complete paid-pricing variant;
document-free allocations may still use 1.0.0.

Core derives the closed tariff and exact schedule charge from the **original
locked ADMITTED allocation**, verifies its hash/manifest/budget/operation
bindings, carries a frozen request-local projection, and reconstructs it at
release. The request, token, correlation and unsigned headers cannot select
pricing or runtime identity. The paid manifest cannot qualify this source path.

The receiver separately calls `RetainedDocumentRuntimeIdentityReader.readCurrent()`
before and after the source read; independently current `sourceHead`,
`imageDigest` and `configurationSha256` must match the allocation. A fail-closed
ECS selector adapter exists, but its independent trusted readback port and Nest
provider remain unimplemented and unregistered, so the default 503 occurs
before attachment metadata/bytes. Missing, malformed, unavailable or changed
evidence withholds results. RELEASE_SHA/GIT_SHA, environment digest equality,
release headers and OCI labels alone do not open it.

Shipping/render must qualify the exact integrated source and digest-addressed
ECR image, read back the current ECS task/container, define and measure the
effective-configuration hash, and implement/register the independent
control-plane readback provider.
Meri's shipping owner must compare those same **current** Core pins before
issuing a 1.1.0 allocation; Meri-source measurement or pin syntax is insufficient.
The extraction owner unconditionally enforces `allowPaidExtraction:false`
before both vision and Whisper for every retained document token. Blank PDF
text layers return truthful missing-content coverage; audio/video fails closed
before Whisper. Meri currently maps unavailable documents to `INVALID_RESULT`,
so a completed user-facing unsupported-material result is not claimed.

Paid extraction on this endpoint requires complete measured pricing and a
reliable pre-call audio cap, plus either draining/expiring all text-only
runs/delegations or a future signed/versioned mode selector checked before
both paid branches. No paid-mode activation is part of this source receipt.

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

Docs-only commits on the exact Core PR87 base. Original local focused checks:
`node --test infra/routing/capiro-prod-alb-first-match.test.mjs` **10/10**;
`node --test infra/deploy/first-chat-core-preview-source-pin.spec.mjs` **3/3**;
`git diff --check` clean. This additive refresh checked the exact source pins,
receiver gate and unchanged template; the receiver owner's **112/112** focused
checks and narrow TypeScript/diff success are reported source evidence, not a
rerun by this packet lane. The snapshot definition comparison and template
capacity/held-service/image-pin inspection are source checks. No CDK deploy,
live AWS/SQL, credential read, grant, image build or paid source call was run.
