# Retired main-Web qualification support

These files preserve backend qualification inputs and historical acceptance tools after current-tip retirement of `apps/web/src`. They are not an application workspace, a shared runtime authority, a current frontend source assertion, or deployed/browser acceptance.

Canonical current frontend parity belongs to `capiro-frontend`. `QUALIFICATION-OWNERSHIP.json` records the deliberate transition from old UI coverage/table obligations to current backend source checks; it preserves the original failing cases without claiming they were replaced as frontend acceptance. Inspect the executable current catalog with `node scripts/backend-source-qualification.mjs --plan`; `--run` executes only that finite source-only catalog. No root package, lock or workflow activation is part of this transition.

`SOURCE-INPUTS.json` pins source commit `4e0c189c5d0522098be1c4916a033bb681d11c0b`, original paths, Git blobs, byte sizes and SHA-256 hashes for 13 relocated harness files and three source operands. Harness files retain the same directory depth and sibling imports. Their only byte changes are literal `apps/web/scripts/` to `tests/support/legacy-web/` path replacements; `inputs.spec.mjs` reconstructs every original byte with that exact inverse. Original Git history and the separate full source retirement manifest remain the recovery authority.

App and hearing transport operands are `.txt` qualification data. Backend CTA and Intel transport tests still compare their own inputs with the sealed source bytes. The generated preview-route table remains historical qualification data. Its original generator/rendering obligation stays historical. Current backend checks validate route declarations and exact pattern boundaries without rewriting or accepting this browser table. Byte identity establishes no current frontend routing or public authority.

The parent's PR30 owned preview-pattern `--check` exited 1 with `ENGAGEMENT_PREVIEW_ROUTE_PATTERNS_INVALID (5)`: five `/api/clio/krisp-notetaker*` paths fall outside `/api/engagement/` and the two reviewed exclusions. They already occur at source `4e0c189c` in `apps/api/src/engagement/__fixtures__/engagement-route-manifest.v1.json` at lines 8, 32, 56, 81 and 107. All nine inputs were byte-exact to that source. Reversing the generator's sole PR30 output-path substitution reconstructed its original 7,975 bytes, blob `1fda08859597cb5fd0b56d4b4191e4e78115a3ce`, SHA-256 `6bd9d1861ee98b20f53ee5d516f27949152058ffc16fee5087de966aff0e8d4d`. Its unchanged guard rejects before rendering or reading the archived output. This inherited historical browser-generation failure remains explicit in the ledger and sealed evidence. The successor backend boundary check proves non-preview paths remain excluded; it does not waive the original guard or grant header authority. Prefix, exclusions, browser table and contracts remain unchanged. Source proof is retained in `docs/backend-cleanup-frontend-20261016/evidence/preview-pattern-inherited-failure-source-proof.json`; no new historical run is claimed.

Existing backend-owned manifests remain canonical at `apps/api/scripts/__fixtures__/engagement-current-ui-surface-manifest.v1.json` and `apps/api/src/engagement/__fixtures__/outreach-v3-ui-inventory-manifest.v1.json`. Engagement read materialization, external denial, resilience, evidence and inventory tests read those inputs. The skeleton contract remains at `apps/api/src/outreach-v3/state/__fixtures__/legacy-ui-contracts/outreach-v3-skeleton-editing.ts.txt`. No whole UI source tree is copied here.

## Test identity accounting

| Original test | Current owner | Disposition |
| --- | --- | --- |
| `scripts/engagement-phase3-ui-inventory.spec.mjs` / `the committed manifest is exactly what the builder generates` | `historical-source-replay.spec.mjs` | Same name and builder equality assertion; explicit pinned full-source input required. |
| Same source / `output is deterministic across repeated builds` | `historical-source-replay.spec.mjs` | Same name and both builder calls/key-order assertions. |
| `apps/api/src/engagement/runtime/engagement-phase1-browser-acceptance.spec.ts` / `is absent from every file under apps/web/src` | `historical-source-replay.spec.mjs` | Same name, complete tree traversal and both shim-token checks. Jest equality becomes equivalent Node strict equality. All other API membership/harness cases remain. |
| CTA parity / `owned CTA route input matches the retained current frontend source` | Same file / `owned CTA route input matches the sealed retired frontend source` | Same byte equality against sealed source; current frontend conformance claim removed. |
| Intel parity / `Intel qualification preserves the retained frontend transport bytes` | Same file / `Intel qualification preserves the sealed retired frontend transport bytes` | Same byte equality against sealed source. |
| Planner / `backend excludes exactly original direct Web steps and only browser control argv` | Same planner spec / `backend excludes direct Web and historical UI main while retaining source controls` | Adds explicit assertions that backend argv retain prototype, scope/findings and scope-base pure controls; full step-array inverse remains byte-exact. |

The original inventory suite preserves all 32 names and assertions, including five inherited failing invariants and every mutation control. It now requires the clean historical root for manifest bytes, the Phase 0 route input and `collectRuntimeActions(ROOT)`. No current backend scan supplies old-source parity proof. The existing collector already accepts this root argument; its source body needed no change. The separate replay suite retains three cases. Missing input refuses collection without skipping cases. The new current contract suite has 27 backend cases; the catalog has 18 selector/workspace/executor controls and includes the unchanged 22 input-identity cases, 19 canonical runtime controls, eight Directory controls and two real canonical source verifiers. Those two verifiers perform finite synchronous Git reads, without services or a compiler.

The parent's PR30 reader run exposed five inherited inventory assertion failures. Exact Git `4e0c189c` has blob `2f8a2cb0f733016078b2f9f54418f77962f1d069` at both original Web and owned API inventory paths. Its 237 requests include 15 unmapped routes, 86 null surfaces, 26 scanner findings and two V3 consumer files; 15 retained backend routes had no inventory coverage. Historical assertions are unchanged. Byte identity is not semantic acceptance. Mutation controls still require newly introduced diagnostics. `--backend-only` now delegates to current backend declarations without using old consumer/surface coverage assumptions.

Two CTA failures in that run were Windows checkout line endings: the owned fixture had 30,943 bytes/687 CRLF pairs instead of canonical Git's 30,256 bytes. Restoring exact Git blob `24d75b1bd4d3e22d4eb0027b9412b33281a84c85` reproduces SHA-256 `a7b1ff2a7cb9945af55ba58c5849cfe18cf5f89a47c195d99e7edac1fcbfe2cc`; assertions were unchanged. The root slice pins the fixture and archived operands to LF. No rerun is claimed here.

## Explicit historical replay

Supply an existing clean, read-only full-source checkout of exactly the pinned commit:

```powershell
$env:CAPIRO_LEGACY_WEB_SOURCE_ROOT = '<clean full-source checkout at 4e0c189c5d0522098be1c4916a033bb681d11c0b>'
node --test tests/support/legacy-web/historical-source-replay.spec.mjs
node --test scripts/engagement-phase3-ui-inventory.spec.mjs
node scripts/verify-engagement-web-no-preview-header.mjs
```

Commands verify commit and source cleanliness before traversal. They do not create/extract a checkout, compile, install, start a browser/database, or modify historical source. Browser/local harnesses retain their original runtime/resource authorization and dependencies. Local mixed Engagement runners refuse missing Web source before creating disposable resources. Historical replay does not qualify the separately owned current frontend artifact.

## Backend scopes

Default aliases are owned by the root workspace slice. Explicit backend invocations:

- `node scripts/validate-knowledge-plane-phase26.mjs --run --backend-only`; fast adds `--skip-tests` and keeps its typing-only marker.
- `node scripts/verify-outreach-v3-phase2-code.mjs --run --backend-only` and Phase 5 equivalent. Every original backend step/assertion remains; completion marker declares backend scope.
- `node scripts/verify-outreach-v3-phase6-code.mjs --run --backend-only`: retains API/package/infra/migration boundaries, current backend preview-boundary validation, and whitespace. Original browser-table drift and UI source/build/browser obligations remain in full historical mode.
- `node scripts/verify-research-portfolios-phases1-4.mjs --backend-only`: retains all API/schema/migration/closeout checks; UI file/route checks remain in full historical mode.
- `node scripts/engagement-phase3-ui-inventory.mjs --backend-only`: strict compatibility selector for current backend declarations and owned input-byte integrity; stale UI coverage does not accept or reject current backend routes.
- `node scripts/engagement-phase3-backend-contract.mjs --check-routes` and `--check-preview-boundary`: check finite current manifest/controller declarations and the existing preview boundary. The initial map has 144 primary and 63 additive records; no whole-file or route-count freeze prevents legitimate additions. Credential resolve and Recall stay separately owned declarations; the Engagement-only scanner does not invent their action classification. All seven currently non-preview paths, including Krisp, stay excluded from patterns. This is source proof, not actual router/service/live ownership.

Backend Phase 3 selects the new 27-case suite and current boundary CLI in place of its historical UI/table steps. The full 26-step array and frontend selection remain; pure scope/prototype controls and all other backend obligations remain. Additive state/reasoning/templates contracts validate and compose their actual global/controller prefixes; the other five schemaVersion inputs use their admitted family namespaces without invented fields. New routes under each owner remain valid without historical UI updates. The catalog names historical obligations and owners. `--plan` performs no execution; `--run` runs only its complete fixed Node source catalog and stops on failed, empty, unknown or uncertain execution.

Current workspace checks parse default and delegated command tokens, require real Turbo exclusions for Onboard/E2E, reject shell controls/forwarding/context redirection, preserve Onboard/E2E/source-identity support, and refuse a returned Web workspace/source/importer. Unrelated versions, dependencies and backend importer additions remain allowed; whole root/lock snapshots are not ongoing acceptance. `--check-workspace` selects these fields alone. Every catalog Node test entry uses `--test-isolation=none`. Its plan explicitly leaves nativeApplication/install/build/image/native-platform/frontend scopes UNRUN, with owners. Current Onboard default source-SPA/Node20 image safeguards and its separate optional artifact-image obligations remain current and UNRUN; retaining their dependencies does not qualify either image. Their old whole-lock transition profiles remain historical evidence.

Default task options use a finite execution-preserving grammar: concurrency, logging/UI presentation, force and no-cache. Dry-run, graph, help/version and unknown options cannot satisfy task execution. Source qualification uses the Node24 runner and builtin TypeScript stripping in existing fixture controls; the retained Onboard Node20 image/runtime is unchanged.

Default task filters must be exactly `!@capiro/onboard-web` and `!@capiro/e2e`, once each. Order, equivalent quoting and paired/equals option syntax may vary. Extra positive, broad negative or duplicate selectors require intentional owner review because they can reduce execution to zero tasks. Unrelated dependency/version/backend importer additions remain allowed.

The historical `Phase 3 V3/prototype boundary` main stage is frontend-only because it unconditionally proves the two old v2 UI files still exist and forbids their retirement. Its original main assertions, full step-array identity and frontend selection remain. Backend control argv still run the pure prototype/source-inventory negative controls. `Phase 3 scope and findings` remains selected unchanged for backend: it enforces retained-range infra/migration/Compute policy, runtime-enablement bans and the open-P0/open-P1/blocking-P2 ledger. Both guard modules resolve their Git base only when `main` runs; importing their pure controls no longer reads Git or requires an `origin/main` ref.

## Validation handoff

Bounded source/builtin checks ran after integration. Reader/harness controls passed85cases; a subsequent55-case source-scope batch covers the later planner/base-resolution changes. No compiler, install, browser, database or build ran. Heavy/native checks remain with the shared queue; exact receipts and original failures are in `docs/backend-cleanup-frontend-20261016/VALIDATION.json`.

```text
node --max-old-space-size=128 --test --test-isolation=none scripts/engagement-phase3-backend-contract.spec.mjs scripts/backend-source-qualification.spec.mjs scripts/engagement-phase3-qualification-plan.spec.mjs
node scripts/backend-source-qualification.mjs --plan
```

The initial reader batch, including the two relocated pure browser modules, reported117cases:110passed/sevenfailed, zero skips. Two were the repaired CTA line-ending issue; five remain inherited inventory assertions. The separate historical inventory stage reports32cases/27pass/fivefail; it does not qualify current frontend coverage. API `src/engagement/runtime/engagement-phase1-browser-acceptance.spec.ts` still requires its queued native runner. The historical replay suite remains unrun outside backend coverage.

The parent's first 74-case focused batch passed before the final zero-task selector correction; its receipt remains preserved as the superseded stage. The successor now has 45 new current controls plus the existing 30-case planner awaiting parent validation. This implementation lane ran no checks. A full legacy frontend rerun is not required for current backend source acceptance; preserved historical results remain historical.

Full frontend tools such as Outreach Phase 6 final/maintenance/CSS generators and LegiWatch browser qualification remain historical commands requiring frontend source; they are not default backend acceptance. Global Cleanup/E2E source-identity obligations remain separately unqualified. Public assets/nginx and Onboard are retained by the root slice.
