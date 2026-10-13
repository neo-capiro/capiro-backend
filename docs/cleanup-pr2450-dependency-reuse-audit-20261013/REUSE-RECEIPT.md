# PR2450 dependency and native-client reuse audit

Source: `bbb38185058fdc64c204da723943aee055b3dad3`, tree `77a6cc091e6bfa02afa8b9e558a7d2e2a1e523a2`. Comparison: reported qualified-install source `457e84e7d50f401985355cf22eedc480fd72ad8b`, tree `19ee55e0a411f68b2a7e239544786e7f9987b892`.

The selected HTTP harness can reuse the cached libraries without an installation or Prisma generation. The task-owned overlay is now ready at `/workspace/capirov2-meri-http-qualified-20261013/apps/api/node_modules`. It explicitly selects the current-schema native client and freshly compiled current Shared source; the existing broad overlay alone is insufficient.

## Install and tool operands

All 20 root/workspace package manifests and 16 configuration slots were compared by Git modes/blob IDs. Only the API manifest differs: it adds the Phase9 discovery test alias and prepends that alias to `test:pe-trust`. Every dependency/devDependency/build/type command is preserved. `.npmrc` is absent at both pins; the other configuration slots, including the full lock/workspace files, are exact. `pnpm-workspace.yaml` includes `apps/*`, `packages/*` and `infra/*`.

All 22 selected cached package versions equal the current API lock importer base versions. These include Nest common/core/platform-express/testing 10.4.22, Nest CLI 10.4.9, Clerk backend 1.34.0, Prisma/client 5.22.0, TypeScript 5.9.3, Jest 29.7.0, ts-jest 29.4.14, tsx 4.23.15, Supertest 7.3.0 and pg 8.23.0. The cached absolute Node binary reports 24.19.0; this satisfies the unchanged root `>=20.11.0` engine. No package module was evaluated to obtain these resolutions.

The initial module-only resolver reported `@nestjs/cli` as `MODULE_NOT_FOUND`: that package has no main module, but its metadata and `bin/nest.js` are present. The final resolver records the executable and its version. The original JSON remains preserved. The initial manifest census omitted `infra/*`; it is also preserved, and the final census includes the canonical workspace pattern.

The five reported peer install/build receipts are still physically absent at the supplied paths. Their expected hashes are preserved in `SOURCE-AND-CACHE.json`; none was verified here. This audit proves source operand compatibility and selected local package availability, not a new frozen installation or the integrity of every transitive cache file.

## Exact native clients

Both existing isolated clients match PR2450 schemas byte for byte:

| Client | Reuse root | Current schema SHA256 |
| --- | --- | --- |
| Core | `/tmp/capirov2-local-native-prerequisite-20261012/core-client` | `215556bd82b97f0be84d7f97da7f19a5a25bace97dc54b1a550cab2039a740fb` |
| Workspace | `/tmp/capirov2-local-native-prerequisite-20261012/workspace-client` | `e67b41d7e5105937c201cab382e222817009dd8ec4843d045af2c754d756fa02` |

Each has its generated JS/declarations/runtime and the Debian OpenSSL3 native library, 16,161,048 bytes, SHA256 `35860a5c0fb2f79e7b38c40747c4d212318d97e1910ca528b133c802716de0b8`. The recorded package/JS/runtime/schema/engine hashes also match the previously committed `ENGINE-CLIENT-IDENTITIES.json` packet. The declaration hashes are included as additional current metadata. Nothing constructed or loaded either native client or engine in this audit.

The common `@prisma/client` package resolves to a generated Core schema with hash `69ced004...`, which is stale. The broad rich overlay's `.prisma/client` resolves to the integrated-RC engine-free cache with schema `d79006f5...`, also stale. Common Workspace native output has stale schema `fcaca466...`. N's Workspace generated output has the correct schema but no native engine file. Engine-file presence alone is therefore insufficient.

## Task-owned reuse recipe

1. Use exact PR2450 source in the qualification owner's existing task stage. Keep shared caches and existing overlay links unchanged.
2. Reuse the selected cached external packages from `/workspace/capirov2/apps/api/node_modules`; the absolute Node, TypeScript, Jest and Nest CLI paths are bound in the evidence. Create qualification-owned resolver/overlay aliases rather than changing the shared installation.
3. Resolve `@prisma/client` to the isolated **Core** client above for both types and runtime. Bind `PRISMA_QUERY_ENGINE_LIBRARY` to that client's exact Debian library only in the reviewed native command. If Workspace is actually exercised, use its separate exact client. Recheck schemas and the pinned engine hash immediately before the run.
4. N's `/tmp/capirov2-cleanup-meri-local-dispatch-conversion/packages/shared` has all 37 tracked source files matching PR2450, but its emitted cache differs from a fresh current-source strict TS5.9.3 compile in five of 74 JS/declaration files. The task-owned compile exited 0; its 149-entry package/output wrapper is at `docs/pr2450-dependency-reuse-local-20261013/local-host/shared-runtime` in the qualification worktree and is now the `@capiro/shared` alias. All declared export paths are present, and their resolved paths are captured without package evaluation. The broad overlay instead points to receiving-dist `7949d079`, where `newsletter-receiving.ts` source is stale; `37d574a3` has that same source mismatch. Original comparison failures are retained.
5. Auth's 8, MeriCore's 273, DefenseContracts' 13 and DefenseDomain's 66 cached tracked source files match current source. Their declared runtime/type entries exist. DefenseDomain's cached manifest differs only in an unrelated eval command's `--write` flag; dependency/build/type metadata is exact. Retain or independently bind prior compiled-package receipts when reusing their dist output.
6. Invoke the cached executables directly from task-owned API context. Do not use a pnpm launcher that might synchronize dependencies. Keep compiler output/build-info and test artifacts task-owned. Clerk collaborators must be deterministic local fakes; no real verification/client/provider request follows from package availability.

The qualification worktree now has 54 fixed dependency links, including exact Core aliases at `@prisma/client` and `.prisma/client`, the isolated Workspace alias at `apps/workspace/generated/prisma-client`, and the freshly compiled Shared package. Its root `tsconfig.base.json` was initially absent in the sparse materialization and was restored from the exact current Git blob without changing source. The original plan-binding ENOENT and the premature pre-Shared resolution refusal are retained. These active physical dependencies must remain available until the owning HTTP/compiler work finishes.

`owned-host/API-CHECK-COMMAND-PLAN.json` binds actual direct TypeScript and Nest CLI commands, original configs and tool hashes. API type/build commands have **not** been executed by this dependency auditor. Only the isolated Shared compiler ran, using the original strict current configs and task-owned output/build-info. Source/declaration maps are retained and hash-bound; different output-directory map paths were not treated as compiled-runtime equality. The actual JS/declaration bytes were compared before selecting the fresh output. `owned-host/CURRENT-SHARED-HOST.json` binds all 149 emitted/package files on the physical host; it is a hash receipt, not a claim those physical files have already been published in this evidence commit.

## Materially affected checks

The changed runtime scope is API authority, Clerk/tenant middleware, context security/module registration, Meri controller and Meri service. The required fresh compiler/build surface is the current API project and Nest build with the current schema declaration mapping. The existing full API 17-step command can be used if root chooses it; it is unchanged and does not itself require Prisma generation. Shared/Auth/MeriCore rebuilds are needed only to establish missing compiled-cache provenance, not because their source changed from the qualified-install pin.

Run the new authority spec and E's actual Nest HTTP harness using the real middleware/controller/service owners, deterministic Clerk, refused external providers and task-owned loopback transport. Include current authority, malformed/foreign identifiers, reauthentication/current-use changes, per-request/concurrent isolation and cancellation behavior in the bounded adversarial review. If the actual owner operations need a database, root must approve the exact private target and command, role and minimal fixture before the harness is run. The native client cache is already available, so download/generation is not a prerequisite.

No SQL/schema/migration source changed for this authority slice. The earlier native PE/operator results can remain scoped to unchanged operands; they do not qualify the new Meri/authority runtime. A full operator/default graph, unrelated PE replay and full repository Jest are not necessary repetitions for this audit's dependency question.

## Remaining limits

The peer install raw receipts remain unavailable. Actual HTTP behavior and any current-authority native/RLS execution are pending the owning harness and exact target review. Production credentials/Clerk/provider behavior, deployed-role RLS hardening, full operator qualification at this head, ARM/musl engines, deployment and shipping remain unqualified. No install/download/API build/test/client construction/native load/database/credentials/provider operation occurred in this audit. The authorized isolated Shared compiler and qualification-owned filesystem host setup are the only additions beyond metadata reads. No production source or shared cache was changed, and no protected reporting source was inspected.
