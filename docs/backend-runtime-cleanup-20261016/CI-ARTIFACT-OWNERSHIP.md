# Successor CI and artifact ownership map

Read-only review of PR30 `7b6bda7ca75ea86afb36c76f013f550fdd79e42f` and successor documentation through `2565a7a04aa63ed6ef4793bbd236a0d32fde6e30`. Ordinary finite source/Git reads only; no test, application, compiler, build, install, browser, helper execution or workflow activation. The concurrent Directory implementation is outside this review's write claim. This map is the only file written by this task.

## Priorities

1. **Keep an explicit current Onboard owner.** Its default image still builds the retained SPA from source. Backend default-task exclusion is not Onboard retirement or image qualification. Preserve default build/source closure separately from the opt-in supplied-artifact profile.
2. **Replace the stale whole-lock artifact profile assertion deliberately.** `onboard-spa-artifact.contract.spec.mjs:137` pins the pre-runtime lock `ee1e9d…`; the accepted runtime dependency source and cleanup importer removal make that an obsolete current-root assertion. Preserve its original case in a named pinned replay profile. A current owner must assert the exact accepted transition and the actual Onboard/auth/shared importer closure, rather than deleting the check or changing a digest without provenance.
3. **Make current backend source qualification runnable without activating workflows.** The checked-in receiving job is quarantined historical source, not an active CI job. Integrate with the proposed `scripts/backend-source-qualification.mjs`, rather than adding another parallel owner. Retain exact commands, fail-closed selection and real nonzero propagation.
4. **Keep security and platform failures visible.** No helper change, skipped negative control, catch-and-pass, weakened symlink rule, Windows ACL workaround or blanket historical allowlist is justified by source acceptance. The POSIX filesystem/shell controls need a suitable explicit platform lane.

## Exact source references

At successor `2565a7…`, these admitted regular Git blobs are unchanged from PR30:

| Path | Git blob |
| --- | --- |
| `apps/onboard-api/Dockerfile` | `38c18bdfdaa83a5d5a9665e2ec93cb7aaa0544b2` |
| `apps/onboard-api/Dockerfile.spa-artifact` | `274557224d218a3c5545022d5273fe2c13562b8d` |
| `scripts/ci/onboard-spa-artifact.contract.spec.mjs` | `2a7e5f5f3dfa21eead7108a1fb6c8cd1cad6d6d3` |
| `scripts/lib/onboard-spa-artifact-contract.mjs` | `3afe06de20d333b9a5a9afac3f67f823bce4672d` |
| `scripts/ci/backend-retirement-source-jobs.contract.spec.py` | `6491c759fbebefa9f560fd4dc7968fd6efac5349` |
| `scripts/ci/frontend-artifact-docker.contract.spec.mjs` | `cc2c4999e75a898d8f4def39e720b29304170648` |
| `scripts/lib/backend-workspace-retirement.mjs` | `d27a9bbb921d357b3276f1bb249ea5511335c3c1` |
| `docs/backend-repository-split-preparation-20261013/quarantine/github-workflows/backend-cleanup-preservation.yml.disabled` | `923e171a34ee488bf0ee977257296985b6518375` |
| `docs/backend-repository-split-preparation-20261013/quarantine/github-workflows/onboard-api-image.yml.disabled` | `cf755c2ee75e0b5bd89f14b8538286a65c6c339f` |

## Current Onboard source and image obligations

`apps/onboard-api/Dockerfile:33-41` copies and frozen-installs the API, retained Onboard SPA, auth and shared manifests. Lines43-58 copy their source, build shared/auth, generate Prisma, build API and build the SPA. Lines62-64 perform production pruning; lines81-99 preserve runtime modules, generated client, Prisma data, auth symlink directory, SPA `dist`, and entrypoint. Lines101-105 preserve nonroot execution, port4400 and dumb-init.

The actual default Node pin remains `20.16.0` at line15; the opt-in recipe has the same pin at line18. It is **not** an obsolete assertion merely because the source-control runner uses Node24 (`backend-retirement-source-jobs.contract.spec.py:85`). Source cleanup has not authorized a runtime upgrade. The default SPA build script remains `tsc -p tsconfig.json && vite build` (`apps/onboard-web/package.json:8`).

The API consumes the SPA at `apps/onboard-api/src/main.ts:79-105`, using `ONBOARD_WEB_DIST` or sibling `onboard-web/dist`, with API/health exclusions and no-store shell fallback. Root `pnpm-workspace.yaml:2-4` retains Onboard, while `scripts/lib/backend-workspace-retirement.spec.mjs:47-59` deliberately excludes Onboard/E2E from backend default task selection and retains explicit Onboard typing. These are distinct, compatible scopes.

The old image job remains historical/quarantined: `onboard-api-image.yml.disabled:8-13` declares source triggers; lines54-67 select this default Dockerfile and push an arm64 candidate; lines69-76 distinguish publication from promotion. Do not activate it or reproduce its OIDC/publication authority in a source-only catalog.

## Onboard artifact cases: deliberate current/replay mapping

All existing cases must remain identifiable. The following groups partition their actual responsibilities; moving a historical assertion must not delete its original test identity or manufacture a current frontend acceptance result.

| Existing case group | Current owner / proposed treatment |
| --- | --- |
| Spec114-123: complete opt-in inverse, baseline default/API/module/entrypoint/task definitions and quarantined workflow equality | Keep the original opt-in transition replay pinned to baseline `b5ddf4556b86d0169dd4f77d0b9da971f0c7dc08`. Current Onboard default source preservation remains a separately named current obligation, including image/API/static-serving/security boundaries. Do not classify all default safeguards as legacy UI work. |
| Spec125-131: supplied site only; required pins before frozen install; exact runtime destination; no guessed source image | Current opt-in artifact-consumer contract. Preserve unchanged. |
| Spec134-156: dependency manifests/importers, whole-lock digest, frozen install count, pnpm and Node pins | Split profile identity from current closure. Original whole-lock expectation remains in explicit replay. Current closure uses accepted runtime-lock provenance plus exact cleanup inverse and validates the admitted API/auth/shared dependencies/importers. Actual Onboard Node20 and pnpm9.12 pins still apply until their owner changes the recipes. |
| Spec159-173: original public PDF/favicon bytes, URLs, exact13-file static receipt,14 reads | Current artifact integrity; historical Git bytes are an explicit provenance input. Receipt remains `static-byte-contract-only`. |
| Spec175-275: invocation, no fallback, digest/source, duplicate JSON keys, unsafe names, file proofs, public assets, HTML/module/CSS closure, incomplete shell, symlink/nonregular/root/I/O refusals | Current security controls. Preserve every counterexample and fail-closed outcome; never replace these with a source-equality-only test. |
| Spec277-296: real filesystem supplied fixture and symlink/ancestor escape refusal | Current physical filesystem control, with explicit supported platform/capability. A Windows symlink privilege failure is an unqualified result, not successful artifact refusal and not permission to omit the Linux case. |
| Spec299-330: original control/helper reconstruction hashes | Current test/provenance integrity plus historical comparison identity. Preserve exact former cases and record an explicit reviewed inverse for a future profile/reader adaptation; no broad normalization or regenerated historical seal. |
| Spec341-403: uppercase extensions, trailing controls and pin type coercion counterexamples against prior helper | Current helper regression controls. Preserve both original historical outcomes and corrected current refusals. |
| Spec406-467: comment/binding/token-gap/line-terminator security regressions | Current helper regression controls. Preserve all expanded cases and valid closed-reference counterparts. |

The filesystem port fixture is POSIX-specific: spec84-111 hardcodes `/provided/artifact`, `/` and `/`-joined map keys. The helper itself intentionally uses host `resolve`, `dirname`, `join` and checks every ancestor (`scripts/lib/onboard-spa-artifact-contract.mjs:177-223`). A native Windows path mismatch is not evidence that those ancestor checks are wrong. A future test-only portable port adapter may model the host filesystem explicitly, preserving all refusal cases; otherwise label and execute these cases on Linux. Do not weaken the real helper to accommodate a fake POSIX map.

## Exact accepted lock history

The finite command `git diff b5ddf4556b86d0169dd4f77d0b9da971f0c7dc08 3f747849a1d037806faa819f7c174d8b29675947 -- pnpm-lock.yaml` contains only four importer relocations. Both Git lock entries are mode100644:

- Before: `b5ddf4556b86d0169dd4f77d0b9da971f0c7dc08:pnpm-lock.yaml`, blob `08d78e3dbca937f82ada2eb344b961477e9dfc58`.
- Accepted runtime source: `3f747849a1d037806faa819f7c174d8b29675947:pnpm-lock.yaml`, blob `9cb39e29336e8f3a911d8e182e90f2ca5bcd5e36`.

| Importer | Before `devDependencies` line | After `dependencies` line | Unchanged operand |
| --- | --- | --- | --- |
| `apps/api` | 226 | 147 | Prisma specifier `^5.20.0`, resolution `5.22.0` |
| `apps/api-strategy` | 341 | 301 | same |
| `apps/intel-api` | 544 | 504 | same |
| `apps/workspace` | 1029 | 983 | same |

`apps/onboard-api` remains in `devDependencies` at line732 in both historical locks. Its current package manifest is byte-identical to `b5ddf455…` (`git diff b5ddf455… HEAD -- apps/onboard-api/package.json` is empty). No Onboard manifest correction or production dependency relocation is authorized by this map.

`scripts/lib/backend-workspace-retirement.mjs:21-25` binds the exact accepted pre-cleanup lock SHA256 `01f689e46dc06cdd1d9e8a0c96e5b6e70ac6f462fe2ab9c05813317a053c643c` and current canonical post-cleanup SHA256 `c40a4e5d624cf42f498a1ec0fb87851d970a7395d55afdb3c9e7cbbe38ced948`. Lines316-341 admit only exact canonical/known-checkout bytes, restore only Web's importer and verify the prior digest. `backend-workspace-retirement.spec.mjs:25-43` additionally preserves all resolutions/snapshots and retained Onboard/E2E/API importers.

Two successor comment corrections are justified without a behavioral change: `frontend-artifact-docker.contract.spec.mjs:69-70` inaccurately says API and Onboard production dependencies; `backend-retirement-source-jobs.contract.spec.py:183-184` inaccurately says two production Prisma operands if describing this four-importer lock transition. Their exact hash checks already bind the correct bytes.

## Source-job contract and runnable catalog

There are no tracked active `.github` paths at the inspected head (`git ls-tree --name-only HEAD .github` is empty). The Python test deliberately reads quarantined workflow source (`backend-retirement-source-jobs.contract.spec.py:18-19,67-70,93-94`). Its `validate` checks a precise old job and command list (`:24-48,73-87`); successfully testing that data would not schedule or execute any workflow.

| Existing Python case | Retained intent and successor ownership |
| --- | --- |
| `test_current_receiving_job_and_dependency_closure` (:96) | Preserve the old source-job fixture identity in historical/quarantine checks. Add current catalog closure: every selected test/runner source file, not just tokens beginning `scripts/`, exists in its declared owner scope. Keep explicit artifact builder/consumer support. |
| `test_all_source_categories_trigger_without_draft_native_work` (:109) | Preserve old trigger-pattern evidence; current catalog needs its own finite source categories and explicit exclusions/owners. No native/full-retirement/frontend-parity claim. |
| `test_security_bypasses_and_unavailable_carrier_dependency_refuse` (:119) | Carry these same mutations into the current catalog/runner contract: no dropped/duplicated work, bypass shell, arbitrary install/native/upload commands, foreign source ref, write credentials, unavailable dependency, `continue-on-error` or duplicate keys. Original fixture tests remain available. |
| `test_failures_propagate_before_any_later_job_command` (:148) | Preserve the actual inert POSIX shell scenario and explicit `/usr/bin/python3` prerequisite. Add independent current runner failure-propagation tests against its real selected argv, ensuring the first failure stops later steps and prevents the completion marker. Do not silently skip this test on an unsupported host. |
| `test_backend_transition_preserves_existing_gates_and_explicit_artifact_consumer` (:177) | Keep accepted source-transition proof: exact runtime lock and exact workspace/PE inverses, explicit default Web artifact consumer, unchanged Onboard default and quarantined gate sources. For replay use its pinned transition source; current owner uses a deliberately reviewed exact successor profile. The PATH-only native Node child is an observed Windows qualification limitation, not a stale-UI assertion to erase. |

Recommended catalog shape: one explicit `--plan`/`--run` runner with finite allowlisted source-only argv, sequential execution, resource bounds/timeouts and structured actual status. Its manifest should name current owner, scope, source inputs and platform for each entry; reject missing/foreign/duplicate selections before execution. `--plan` must have no execution side effects. Historical scopes have a separate explicit intent/preflight and source pin; missing replay inputs fail visibly. Current success must enumerate only current cases and name historical/native/frontend obligations excluded from that receipt. No `.github` files, cloud credentials, installs, workflow activation or source publication are needed for this source catalog.

## Concrete current catalog omissions

The quarantined `COMMANDS` list predates the accepted cleanup and does not select the following current source ownership checks. These are finite omissions in this catalog, not proof all repository CI or production testing is absent:

- `scripts/lib/defense-runtime-source-ownership.test.mjs` and `scripts/lib/phase17-operator-ownership.test.mjs` (19 meaningful ownership/refusal controls), plus the real source-only verifier entrypoints `scripts/verify-phase8-session4.mjs` and `scripts/verify-defense-budget-mirror-parity.mjs` under their documented dependency/resource conditions. Preserve the317 canonical spec twins and retained data, without claiming two independent runtime implementations.
- `scripts/lib/backend-workspace-retirement.spec.mjs`: exact current default selection, retained Onboard/E2E, unchanged lock resolutions and all retired-alias refusal controls. The old Defense workspace guard is image-specific and does not substitute for these root-workspace controls.
- `tests/support/legacy-web/inputs.spec.mjs`: relocated harness/input identities and refusal controls are current qualification-data integrity. They are distinct from the three explicit full-source historical replay cases and from UI/browser parity.
- The planned current backend route/classification/preview-boundary and selector controls in `CURRENT-CI-OWNERSHIP-PLAN.md:19-28,34-39`, owned by the independent legacy-Web lane. Do not retain old UI inventory or archived visual package assertions as current backend gates; do retain every original historical case and known failure.
- The successor Directory mapper source/body/DTO controls at `scripts/ci/directory-detail-mappers.contract.spec.mjs:9-11,37-82` once its implementation is admitted. They require a Node version supporting the explicit strip-only API; they are not native API/Jest/typing qualification.

`docs/backend-cleanup-frontend-20261016/verify-retained-boundaries.cjs` is a PR30 acceptance snapshot, not an evergreen successor gate: lines32-33 permit exactly the one original API test relocation, so an authorized Directory production extraction will intentionally violate that old scope. It also writes its sealed report at line38. Preserve PR30's original manifest/report and source-acceptance evidence; create a separate successor delta check/profile for admitted production changes rather than broadening or rewriting the sealed PR30 result.

## Remaining qualification limits

This task proves source obligations and ownership recommendations only. It ran no controls. The recorded historical Onboard Windows port/symlink issues, Python POSIX propagation and Windows child-process limitation remain explicit in PR30 `HANDOFF.md:51-55`. Native API/Jest/typing, install resolution, current Onboard build/image closure, adapter behavioral replay, protected feature integration and current frontend parity remain integration-checkpoint obligations under their respective owners/shared queue. Source acceptance does not retire Onboard or activate backend CI.
