# Backend cleanup source and consumer map

Baseline: `016e79b585c14f20d13669e13c987c01e3dd29dd`, tree `aae45db5f9464559739fd8eb0ad6374852b1351b`. This is a source map, not deployed-build provenance. Prepared before product-source edits in a separate sparse clone and branch. No tracked `AGENTS.md`, `.agents/`, or `.codex/skills/` exists at this pin; the split, cleanup acceptance, runtime qualification and runtime ownership handoffs were read. Historical packets remain unchanged.

## Retained frontend ownership

| Paths | Exact consumers at the baseline | Disposition |
| --- | --- | --- |
| `apps/web`, `apps/onboard-web` | `pnpm-workspace.yaml:2`; root `package.json:15-19,128-131`; `scripts/ci/rebuild-verification-scopes.spec.mjs:172-183` | Workspace build/test/type scopes still include them. Backend typing already excludes both. Package/lock changes need one coherent scope transition. |
| `apps/web/src`, `public`, entry and nginx files | `apps/web/Dockerfile:33-82`; `infra/cdk/lib/compute-stack.ts:1058-1096,2218-2227`; `infra/cdk/lib/web-vnext-stack.ts:151-225` | Default source-built images and infrastructure definitions remain. `Dockerfile.frontend-artifact:1` is explicitly opt-in. These source definitions are not live-resource evidence. |
| `apps/onboard-web` | `apps/onboard-api/Dockerfile:35,40,50,58,95`; `apps/onboard-api/src/main.ts:82-105` | Default Onboard image builds/serves the SPA. API-only fallback does not qualify retiring browser routes. Artifact alternative is opt-in. |
| `apps/web/src/pages/radar/LegacyRadarPage.tsx` | `RadarPage.tsx:6,19-26,210`; `App.tsx:49,266`; `LegiWatchShell.test.tsx:6,59` | Imported, re-exported, rendered and tested. Its filename is not evidence of dead code. |
| Web Engagement scripts and fixtures | root `package.json:37,131`; `apps/api/scripts/engagement-phase3-{external-denial,full-read-parity}.ts:62,32` | Mixed backend/frontend checks require separation with retained backend case identities before source retirement. |
| Shared E2E evidence helpers | `scripts/cleanup-gates/gate-config.mjs:29-56`; `scripts/cleanup-gates/lib/pinned-visual.mjs:39-63`; `scripts/test-proof/lib/discovery.mjs:51-61` | Backend gates still use renderer/report/source-identity/launcher support under `apps/e2e`; relocate with readers before retiring E2E. |
| Florida portraits | `apps/api/scripts/ingest-florida-legislative-directories.ts:335,355,364,452`; `scripts/ci/florida-owned-portrait-release.spec.mjs:147-157` | Importer/image assets are API-owned already. Keep exact bytes and `/florida-directory/portraits/` URL contract; serving closure remains separate. |
| Historical CI | `docs/backend-repository-split-preparation-20261013/quarantine/github-workflows/{ci-pr,web-image,web-vnext-deploy,onboard-api-image}.yml.disabled` | Inert historical definitions preserve mixed scope; do not claim these jobs ran or activate them during cleanup. |

## Runtime mirror and first bounded removal

| Paths | Exact consumers at the baseline | Disposition |
| --- | --- | --- |
| `apps/defense-api/runtime-source/defense-budget` and three `program-element` subtrees | `scripts/verify-phase8-session4.mjs:56-68,85-103`; `scripts/verify-defense-budget-mirror-parity.mjs:25-29,55-109` | Preserve all four tree pairs, the two outbox blob pairs, twelve required slices, and the 723-file defense-budget parity contract. |
| Nine mirrored FY27 fixtures | `phase1-7-runtime.adapters.ts:43-53,79-91,138-145`; registry service `:28-44`; adapter specs `:16-64`; `scripts/phase8-session4-fy27-replay.mjs:87-116` | Actual moved-root filesystem readers and dual-path replay remain. No runtime-tree or fixture retirement in this slice. |
| Defense build/image boundary | `apps/defense-api/tsconfig.json:6-7,20-26`; Dockerfile `:43-58,95-119`; `scripts/verify-phase8-session4-image.sh:25-29` | Mirror is deliberately outside compilation/image payload. Keep that containment and existing image checks. |
| `runtime-source/operators/phase6-stage-cycle.ts` | Canonical `apps/api/scripts/phase6-stage-cycle.ts`; API `package.json:130-135`, `tsconfig.phase6.json:13`; verifier `:73` | Same mode/blob `100644/d9a82728dc01bd0b48a92580ab581b13ff19bec8`. Remove copied implementation; retain canonical entrypoint/cwd/arguments. |
| `runtime-source/operators/plan-defense-budget-promotion-v1.ts` | Canonical `apps/api/scripts/plan-defense-budget-promotion-v1.ts`; API `scripts/entrypoint.sh:187`, `tsconfig.phase7.json:21`, rehearsal `:408,440,456`; verifier `:74` | Same mode/blob `100644/c5be25e428397dcf41c10a6cadba0bd6ca3ae2df`. Remove copy; preserve guarded canonical CLI and all operational readers. |
| `runtime-source/operators/status-defense-budget-promotion-v1.ts` | Canonical `apps/api/scripts/status-defense-budget-promotion-v1.ts`; API `scripts/entrypoint.sh:211`, `tsconfig.phase7.json:26`; verifier `:75` | Same mode/blob `100644/d36871ae5ce879f59b941f6ab5eb1c944ab0dec8`. Remove copy; preserve canonical CLI. |

The bounded single-thread Git reference pass over tracked `apps packages scripts infra tests` records all exact path/name matches in `operator-reference-before.txt`. The verifier is the only non-document reader of the three copied operator paths. No package command, dispatcher, typecheck config, Dockerfile, runtime registry or replay selects those copies. Their `../src/` imports resolve to a nonexistent `runtime-source/src` at the copy location. The actual CLI consumers use `apps/api/scripts`; API scripts/image copying is unchanged. Smoke discovery's mandatory CLI roots remain `apps/api/scripts/**` and root `scripts/*.mjs` (`scripts/cleanup-script-smoke/discover.mjs:778-783,1160-1182`). No test is removed.

Remove only the three duplicate operator files (618 nonblank lines), replace their verifier parity rows with canonical-presence/duplicate-absence checks, and update the mirror README. Do not introduce import wrappers: the plan/status `require.main === module` guards would suppress their entrypoints. This is canonical source ownership cleanup, not pipeline consolidation, operator retirement, or production decommission. The current direct cleanup instruction permits this bounded decoupling; historical mirror-preservation evidence stays intact for the retained runtime trees.

## Feature candidates and conflict seams

| Exact candidate | Protected ownership and integration rule |
| --- | --- |
| Frozen shipping `cd3c51e940f14e1b2a1040b0ffa445e85d68b332` | Original source checkout/refs and all live `capirov2` inputs remain untouched. No source/build/deployment equivalence claim. |
| Engagement PR27 `016e79b585c14f20d13669e13c987c01e3dd29dd` | Cleanup starts from this candidate without rewriting it. Keep its 44-file owner manifest, `apps/api/src/engagement/plans/**`, module registrations, four models/backrefs and migration `20281015040000_engagement_plans`. Current controller `:32` mounts `engagement/plans`; module `:23-24` registers the owners. |
| Inactive docs PR28 `51678e1297cb5146562bf20d52e97990f81e77fc` | Separate 25-file docs-only child of016e; preserve it, do not treat it as runtime adoption. |
| Objective `622905839c7a510ab01a512ef8012926b2e1b4ce`, tree `90503a35520425ccd20fdccd44380940fd826d0f` | Separate active 27-file candidate. Protect `clients/objectives/**`, operational module registration in `apps/api/src/app.module.ts`, shared operational-resource/authority/access/schedule exports, Strategy planner, migration `20281015030000_client_objective_operational_links`, and inherited canonicalwork/workloadintent/meeting-reader boundaries. Disabled dispatch is not retirement. |
| Shared merge seams | Objective and Engagement schema/backrefs must merge fieldwise; never replace whole Prisma schema, modules, planner or shared index. Public destination/read contracts and separate frontend binding candidate `3ef15d9a` remain protected. Cleanup's admitted operator/verifier/README paths do not intersect those application deltas. |

The owners confirmed no mutable source claim on this slice. The Objective manifest authority remains `task-6/objective-operational-implementation-evidence/SOURCE-FILES.json`, SHA256 `b21a38efaaa88153dfc9d545cf25043811ca95da27a9c733c33a587e8f095138`; Engagement manifests remain in task-3. Preserve their evidence and candidates rather than importing unrelated features into cleanup.

## Counts and remaining work

Exact016e baseline: **2,473,031 nonblank unique-source lines / 10,136 files**, including 678,329 frontend lines across all source buckets. Copied runtime mirror is separately **191,844 / 730**; physical source including it is **2,664,875 / 10,866**. The operator removal reduces only physical copied source. Report changed source/test additions separately with the same baseline classification; do not claim 618 lines removed from the unique-source headline.

Further frontend retirement needs a coherent workspace/lock/image/artifact/test/URL/evidence migration. Whole runtime-mirror consolidation needs equivalence and consumer adaptation beyond this operator slice. Comprehensive builds/native suites remain a later shared-queue integration checkpoint. No migration, cloud/resource/database action, security change, merge or deployment is included.
