# Core published-history audit — 2026-10-21

The current Core baseline contains the major receiving branches, but it missed the cleanup chain, Directory pagination fix and two committed local source changes. These are now received into the supplemental candidate. A published donor branch or PR alone does **not** establish active consolidation coverage. The earlier audit conclusion that donor existence removed the need for source receipt is superseded by this report.

This audit worker changed only review artifacts. The receiver independently assembled the source commits listed below. No default-branch or PR merge, runtime configuration, infrastructure or database action is authorized by this report. Neo owns the final merge decision.

## Frozen baseline and coverage

- Repository: `neo-capiro/capiro-backend`.
- Baseline `backend-import`: `309af848f1aa403f6c8e54aa0d22990d4230f063`.
- Baseline tree: `c9293cfcf574ad382a8defae37ffc65f3b48d1cc`.
- Published remote branches: **151**; **114** are baseline ancestors, **37** are not.
- Published PRs: **103**, including closed and merged PRs; **89** heads are baseline ancestors, **14** are not.
- Candidate branch: `codex/source-consolidation-20261021-core`; qualified source snapshot `121c628ff46a86e3accfbb99b0eff7b7f5cadde4`, tree `ff3777bb0f7fe2bc6fee4b23e140a47970db42c1`. The outreach review correction is included; final merge remains with Neo. The task candidate is excluded from the original 151-branch published inventory.
- Local custody inventory: **93** repositories, **180** unique local ref/head pairs, **15** initially unknown committed heads and **4** tracked-dirty checkouts. The 15 initially unknown heads are classified below; original local work remains preserved.
- No `AGENTS.md` was found in the baseline Git tree. The existing `docs/backend-successor-plan-20261014/INSTRUCTIONS.md`, current `docs/integration/CORE-INTEGRATION-LEDGER.md`, staged-memory successor and qualification notes were read.

The [complete readable ledger](LEDGER.md) lists every one of the **151 branches, 103 PRs and 15 initially unknown local heads**, with exact head/tree, classification and receiver, replacement or hold reason. Machine records are [branch-ledger.json](branch-ledger.json), [pr-ledger.json](pr-ledger.json) and [local-unpublished-ledger.json](local-unpublished-ledger.json). Supporting per-file modes/blob hashes and stable-patch observations remain in [branch-content-audit.json](branch-content-audit.json.gz); [coverage-summary.json](coverage-summary.json) binds the local source reports by SHA-256.

| Classification | Branches | PRs |
| --- | ---: | ---: |
| Already consolidated, including patch/content equivalents | 124 | 89 |
| Received into supplemental candidate | 7 | 7 |
| Superseded | 4 | 1 |
| Intentional alternative/proposal/evidence exclusion | 11 | 5 |
| Held pending authority, runtime or deployment qualification | 5 | 1 |

`received supplemental` records an actual receiver commit in the candidate. It does not imply completed combined-source tests, authority qualification, runtime acceptance or permission to merge. Of the 15 initially unknown local heads, 10 are patch-equivalent to the baseline, 2 are received supplemental changes, 2 are superseded and 1 remains held.

## Actual supplemental receipt

| Missed source | Donor | Receiver | Status |
| --- | --- | --- | --- |
| Strategy Objective raw ingress | local `3eda7ac162f8a126bb430c1d10720428b0a3bdab` | `5a0fbd011c3a3771a9263080c23f5d61d9acdfbc` | Source received; `065cd32d8c474468c9c93cf6903694db1f4b87dc` adapts transport test discovery to the current bootstrap. |
| Cleanup PR29 → PR30 → PR32 → PR34 → PR36 → PR39 | `8d3c7422bc5668e03da73f19a2bdff7ca7d1f94d` | merge `8f1429236a2f2f8e2b9301878c3fd144ae9595d1` | Donor chain is a receiver ancestor. Current PR91 Directory mapping is retained instead of reinstating PR32 copies; the extraction test is adapted. Combined behavior/consumer checks remain receiver-owned. |
| Directory positive-fraction pagination | PR98 `50475125275853299798fc40f8cb119f0b865464` | `c3481ca92340d104b7861b141e97816d7e865b8f` | Fix and regression tests received. PR99/100 containing the donor did not mean it was already consolidated. |
| Outreach client visibility | local `7713ecc13c1aaccf7ef6ff4605bd2f5bfb53277a` | `a49a77f0d4cb12a624db7965cb27fa50c8123ea0` | Source received and corrected by `121c628ff46a86e3accfbb99b0eff7b7f5cadde4` to preserve actual delivery outcomes after visibility changes. Combined outreach tests: 150 passed; final assertion type fix: 29 focused tests passed. |

## Source qualification receipts

The receiver reports source qualification at commit `121c628ff46a86e3accfbb99b0eff7b7f5cadde4` / tree `ff3777bb0f7fe2bc6fee4b23e140a47970db42c1`. This audit checked the retained receipt contents; builds with empty diagnostic logs use the receiver's confirmed exit-zero result.

| Check | Result | Task-local receipt |
| --- | --- | --- |
| Combined outreach tests, including three delivery-result regressions | 150 passed, zero failed | `core-validation/outreach-combined-final.json` |
| Focused outreach after final assertion type correction | 29 passed, zero failed | `core-validation/outreach-corrected-types.json` |
| Directory browse and pagination | 36 passed, zero failed | `core-validation/directory-browse.json` |
| Strategy Objective raw ingress | 53 passed, zero failed | `core-validation/strategy-raw-http-final.json` |
| Node 24 current-backend source catalog | 14 qualification steps completed; 193 tests passed | `core-validation/source-catalog-qualified.log` |
| Core Nest build | Passed; receiver confirmed exit zero | `core-validation/core-nest-build-final.log` |
| Strategy build and full typecheck | Passed; receiver confirmed exit zero | `core-validation/strategy-nest-build-final.log`, `strategy-typecheck-final.log` |
| Core broad typecheck comparison | Baseline 62 diagnostics; candidate 62; no difference after normalizing source line/column positions | `core-validation/baseline-core-typecheck-qualified.log`, `core-typecheck-qualified.log` |

The broad Core typecheck is not globally green. Its existing diagnostics are unchanged. Earlier failed catalog attempts are retained in the task but are superseded by `source-catalog-qualified.log`; they are not counted as successful runs. [validation-receipt.json](validation-receipt.json) records the checked counts and receipt hashes. These results qualify source only; the held native/runtime/deployment work below remains held.

## Existing receiving lanes

Each of these published receiving/consolidation heads is already an ancestor of the baseline:

| Existing lane | Head |
| --- | --- |
| `fable/core-integration-20261018` / PR84 | `5c105cfefe5a23a10a2d3f7c8eb0d148e9e0ef17` |
| `codex/core-integrated-source-candidate-20261018` | `4b858a87b05f0e189e9423a0f16a8de98eb96855` |
| `codex/core-staged-source-integrated-20261018` | `63e426b0cd8ea82857268ea2c5541cc3b78eda17` |
| `codex/core-backend-import-receiving-20261018` / PR96 | `784b1c3a91eb6d78f16d92c42e71f05c12c5b5bb` |
| `codex/core-producer-context-20261019` / PR97 | `b841544adef13ab5f129339cf7c4d813dd67bad4` |
| P6 authority / PR102 | `946511a70e160a85ea4820d6ef50c5bd53eb7072` |
| Mounted authority paths / PR103 | `81b1d05a1cb87cb598fc763f8d434363fc823c4b` |

## Nonancestor PR decisions

| PR | Exact head | Decision and existing lane |
| --- | --- | --- |
| [2](https://github.com/neo-capiro/capiro-backend/pull/2) | `111f269d749cae0249c2141779bd6d7deb93f45c` | Optional isolated read-only bootstrap. Authoritative successor instructions preserve it separately and explicitly select ordinary API/native-preview behavior without a replacement preview authority layer. |
| [3](https://github.com/neo-capiro/capiro-backend/pull/3) | `3509438f7f0c39c6da4db8a94b74c816211491b4` | Optional PR2 qualification and ordinary API compatibility evidence. Preserve historical evidence; not missing current product behavior. |
| [19](https://github.com/neo-capiro/capiro-backend/pull/19) | `3b7affb158903069d220c89000d054c327d3c96d` | Superseded by received PR45's broader installed-Perl upgrade, `--no-remove` and version checks. Do not revert the Dockerfile to the earlier perl-base-only fix. |
| [25](https://github.com/neo-capiro/capiro-backend/pull/25) | `6949c5ab27e0c47dcc365d8af678d3a65c2c9c4e` | Alternative held CDK preview bindings. Current ledger selects PR44 → PR62 → PR78 → PR83. Preserve the alternative; do not replace current service bindings. |
| [28](https://github.com/neo-capiro/capiro-backend/pull/28) | `51678e1297cb5146562bf20d52e97990f81e77fc` | 25 inactive Engagement routing/ACL proposal and evidence files. PR27's application behavior is already received. No activation follows from these documents. |
| [29](https://github.com/neo-capiro/capiro-backend/pull/29) | `4e0c189c5d0522098be1c4916a033bb681d11c0b` | Received in supplemental cleanup merge `8f1429236a2f2f8e2b9301878c3fd144ae9595d1`; current consumer and test qualification remains separate. |
| [30](https://github.com/neo-capiro/capiro-backend/pull/30) | `7b6bda7ca75ea86afb36c76f013f550fdd79e42f` | Received through the same merge; Defense canonical owner and legacy Web source/evidence ownership are part of combined receiver review. |
| [32](https://github.com/neo-capiro/capiro-backend/pull/32) | `0483963adc5382202408e8398d8b1601f53d8525` | Received through the same merge, preserving current PR91 Directory mapping and adapting the extraction test rather than reintroducing duplicate mappers. |
| [34](https://github.com/neo-capiro/capiro-backend/pull/34) | `f3ede4fe8d88ba686a81c59f71e44319c0f45fd1` | Federal readers/Engagement cleanup received through `8f1429236`; validate the combined canonical callers. |
| [36](https://github.com/neo-capiro/capiro-backend/pull/36) | `a2e3eee209dc82d7536f3fc318a9d952c80e628a` | Raw Meri/API V2 retirement received through `8f1429236`; current runtime proxy corrections and retained contracts remain receiver-owned. |
| [39](https://github.com/neo-capiro/capiro-backend/pull/39) | `8d3c7422bc5668e03da73f19a2bdff7ca7d1f94d` | Previously unreceived chain now has actual receiver `8f1429236`. It was not superseded by PR80. Historical flag-on relationship-overlay concerns are a combined-behavior review requirement, not resolved by donor or merge existence alone. |
| [98](https://github.com/neo-capiro/capiro-backend/pull/98) | `50475125275853299798fc40f8cb119f0b865464` | Received as `c3481ca92340d104b7861b141e97816d7e865b8f`; final user merge remains separate. |
| [99](https://github.com/neo-capiro/capiro-backend/pull/99) | `d443e227077ed307bf22afcbd51802b68d86f64b` | Documentation-only build receipt, scan findings and held roster routing/task plan above PR98. Preserve the source pin and historical evidence; no new runtime authority. |
| [100](https://github.com/neo-capiro/capiro-backend/pull/100) | `05d8eb03a94f5959f4050bcaa155aeb3038226cc` | Existing held AMD64 Alpine alternative above PR98. Its own receiving hold requires base-family decision, authorized build, native PostgreSQL-backed entrypoint qualification and fresh exact-image zero-findings scan. It is a libc migration proposal, not accepted remediation. |

## Branch-only work beyond the PR inventory

The full branch ledger accounts for all 23 nonancestor heads without associated PRs. Their substantive disposition is:

- **Already received through equivalent commits:** memory governance repair `3549f597`, recall eligibility `96065aea`, client uniqueness `f357bf47`, receipt forward `a89f6ea1`, other-memory consumers `7be58528`, legacy recall unification `1a803db5`, passive-memory proposal `785ccba4`, and Objective typed-history fixture `f5f0c1d3`. Every non-merge commit in these lanes is marked equivalent by `git cherry`; subsequent source changes remain in baseline.
- **Already present under a different source commit:** client-profile `getRun` return typing at `045b77ff` is present in the baseline and its build-qualification history (`087b5dcf2`). Do not replace the complete later file to reproduce a small annotation.
- **History release:** `codex/core-history-release-safe-handoff-20261018` at `78ceaf9bdfe00c8f013aac15eb8483312ae4f803`, tree `6cae619af4ad0d67a6693c57a6721fc775037172`, preserves the wire/batch/selected-client helper composition. Its earlier contract `a7e72d37` and owner `f7519401` remain preserved. The helpers/tests are absent from the candidate and no controller is mounted. Current native identity leaves are received by PR97/102/103, but they may reuse bounded Clerk evidence while the old batch contract requires a fresh online final observation. The old batch owner also compares `req.path` directly with `originalUrl`. These are genuine currentness/mounting/Meri final-byte contract holds. Donor publication alone is not active coverage or completed receipt.
- **Tenant transaction predecessor:** `1da05248` adds an isolation option already supported by current `PrismaService.withTenant`, which now also supports `readOnly`. Preserve the current owner instead of overwriting it with the older source/tests.
- **Signed memory:** `57ec94db9fcc12ca503f47546bea2e80ea5306f7` has 11 of 15 changed paths byte-identical to baseline. The only absent files are the `20281018100000_meri_memory_eligibility_helper` SQL migration and its migration-only test. The current `CORE-STAGED-SOURCE-SUCCESSOR-20261018.md` and `CORE-MEMORY-HELPER-MIGRATION-QUALIFICATION-20261018.md` explicitly require these to stay outside the Stage1 tree. The current source wires helper owners behind hard-off gates. This exclusion is deliberate, not lost work.
- **Receipt-only migration runner:** `feat/core-preview-receipt-only-runner-20261017` at `a93a4a4040c780fb8751948273cc94c9a9086523` contains four scripts and a handoff tied to an old PR48 image, schema hash and named database/role. No current receiver is established. It is held pending refreshed exact image/target/ledger qualification and shipping-owner execution authorization, and must not be executed as a source test.
- **Earlier Objective/first-chat integration:** `6ca986a6bcf435bb917eaf3eb97ba99d616594ae` has no absent donor-delta path; 21 of 30 match baseline exactly. Product commits have equivalents. Historical qualification prose differs from later current qualification instructions; preserve the old branch instead of replacing current owner files.
- **Docs-only proposed work:** topology `003a081b`, service-responsibility cleanup `61e2fad8`, first-chat handoff `8b46d2df`, selected-client coordination `5e13e321`, runtime addendum `83b91365`, Objective reconciliation `23a1c350`, and Engagement proposal `f41be177` contain no missing executed behavior. They are retained historical proposals/evidence. The service-responsibility extraction is still a proposal, not completed implementation; the Engagement plan implementation has since been received through PR27.

## Method and limits

The 15 initially unknown local heads are separately recorded in [local-unpublished-ledger.json](local-unpublished-ledger.json). Ten have full stable-patch equivalence to the baseline. Strategy raw ingress `3eda7ac1` and outreach visibility `7713ecc1` now have the receiver commits above. Local history source `3a2659c046016c0549a7b87358cbb20ae10c0102` has the exact same tree as published `78ceaf9b` and retains the genuine history-release hold. Fresh-identity predecessor `00470033d790b17b5e29295a642bf7eba2f2e62b` is superseded by current exact provenance/row-lock/currentness owners. Source-successor `cf45e7811b1f9a2a7ac7a67419c5ea7ffb08b535` has four equivalent commits and two alternative delegated raw-capture commits; current `meriReadDelegationRawBody` in `auth/read-delegation/read-delegation-request.ts` already owns the bounded exact-byte route. Adding the older `clio/read-delegations` parser would duplicate the canonical owner.

The audit scripts (`audit.ps1`, `classify.ps1`, `local-and-readable-ledger.ps1`) remain in the task workspace with their task-owned bare Git store and custody inputs. They read Git and captured metadata and write only the audit artifacts. They do not fetch, push, modify source branches or run application/provider/database commands. The supporting content inventory is published as lossless gzip-compressed JSON; its original and compressed hashes are in `qualification.json`.

For every published remote head, the audit records head/tree and `merge-base --is-ancestor` against the frozen baseline. Nonancestors include stable-patch equivalence and per-path donor/current modes/blob hashes from a merge-base delta. All merge bases are recorded; where multiple bases exist, the first is used only to choose the supporting file-delta inventory, not as proof of runtime correctness. Git reported skipped exhaustive rename detection on large cleanup deltas; the path inventory remains explicit and no rename heuristic is used as authority for deletion.

Ancestry proves source history is received; it does not prove present runtime activation or product acceptance. Stable patch equivalence is not a replacement for combined runtime testing. This audit performed source/history analysis and independently checked the receiver test receipts summarized below; it did not execute those source tests itself. The receipts do not establish native PostgreSQL/RLS, deployed image, zero-vulnerability or production readiness.

The inventory covers the 151 fetched published branch heads, all 103 captured PR heads and the finite local custody survey of 93 repositories/180 local ref-head pairs. It does not claim access to every unpublished/dirty/private worktree, deleted historical ref, external repository branch or future remote update. Protected unpublished Engagement `e01e3b72aa0e26f4d2a9ad65533da1d561920aca` was not inspected or hydrated; no local path is known. The exact hold is recorded in [INSTRUCTIONS.md:46](https://github.com/neo-capiro/capiro-backend/blob/309af848f1aa403f6c8e54aa0d22990d4230f063/docs/backend-successor-plan-20261014/INSTRUCTIONS.md#L46) and [INSTRUCTIONS.md:153](https://github.com/neo-capiro/capiro-backend/blob/309af848f1aa403f6c8e54aa0d22990d4230f063/docs/backend-successor-plan-20261014/INSTRUCTIONS.md#L153): preserve the separate candidate pending publication/review; do not inspect, hydrate or adopt its protected body. Existing local work remains untouched.

No action was denied or left uncertain in this audit. Held dispositions above are source/runtime qualification boundaries documented by the existing lanes, not claims of automatic approval rejection.
