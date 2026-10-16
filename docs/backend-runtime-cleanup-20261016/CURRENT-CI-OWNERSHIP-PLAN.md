# Current backend gate ownership proposal

Baseline: PR30 `7b6bda7ca75ea86afb36c76f013f550fdd79e42f`, current mapping head `39ae771ec70caf8046193b32f204634ec05dac54`. Analysis only; no implementation or tests launched. Canonical current frontend parity owner: `capiro-frontend`. Historical source owner/pin: `4e0c189c5d0522098be1c4916a033bb681d11c0b` and PR30's immutable retirement/evidence manifests.

## Existing consumers

| Consumer | Current selection | Proposed backend ownership |
| --- | --- | --- |
| `scripts/verify-engagement-phase3-code.mjs:68-80` | Full array invokes the 32-case `engagement-phase3-ui-inventory.spec.mjs`, then old preview generator `--check`. | Keep full array historical identity; backend planner replaces these two selected tuples with explicit current route-contract controls and current preview-boundary controls. Frontend/full assertions remain historical and never become current frontend acceptance. |
| `scripts/engagement-phase3-qualification-plan.mjs:43-78` | Backend currently retains both old tuples unchanged. | Add narrow label replacements in backend mode only; strengthen planner negative controls to assert exact replacement argv/options and retain all unrelated selected tuples. |
| `scripts/verify-outreach-v3-phase6-code.mjs:259-262` | Both modes run old preview generator `--check`. | Backend mode selects current preview-boundary command; historical/full mode retains original command/guard. |
| `scripts/verify-outreach-v3-phase6-final.mjs:224-227` and `scripts/outreach-phase6-approved-preview-maintenance.mjs:7,126` | Original UI-final/approved-maintenance consumers of old generator. | Historical/frontend owner; no current backend gate promotion and no source changes proposed here. |
| `scripts/engagement-phase3-ui-inventory.mjs:926-940` | `--backend-only` checks stale historical UI coverage and returns INVALID. | Strict single backend flag selects the new current backend route check. UI generation/check modes explicitly require pinned historical source; never rewrite stale historical data. |
| `scripts/cleanup-script-smoke/web-visual-cli-controls.mjs` | Runs 27 historical scenarios / 144 assertions, including two inherited package failures. No literal root/package consumer in admitted search; old global smoke discovery is not current backend acceptance. | Preserve every case/assertion and require an explicit historical replay mode before fixture/resource-port setup. Exclude from current runnable catalog. Input-byte/relocation identity controls remain in the current backend catalog as data integrity, not historical package qualification. |
| `tests/support/legacy-web/historical-source-replay.spec.mjs` | Three existing source replay cases requiring explicit pinned full source. | Unchanged explicit historical owner; no full legacy rerun required for this successor. |

Raw finite reference search: `current-gate-decoupling-consumers.raw.txt`. Quarantined workflows stay inert; no `.github` activation, package/lock edits or blanket global-gate rewrite.

## New backend checks

The admitted current inputs contain 144 primary route records plus 63 records in eight additive Outreach manifests, 207 distinct method/path keys. Seven primary paths are outside `/api/engagement/`: five Krisp paths plus credential resolve and Recall webhook. These are backend catalog entries; they do not gain preview-header authority.

The new pure/read-only contract module will:

- Read the same nine current backend-owned route manifests with finite path allowlisting, regular-file/path containment and strict shape checks; check methods, absolute route paths, handler metadata and duplicate method/path identities. Primary source-file/handler references stay within admitted backend ownership and are checked against current source. Additive runtime/prefix metadata is validated as declared metadata; it is not live router/task/deployment attestation.
- Derive primary-route read/local/external classification from the existing `collectRuntimeActions`/`classifyRequest` machinery, retaining the existing evidence-backed heuristic exemptions. Apply backend method/runtime-action consistency and send/external negative controls over backend routes, rather than old UI-request/surface coverage.
- Derive anchored patterns for precisely the in-prefix current routes and prove no pattern matches any non-preview catalog path or extended/sibling path. Keep `PREVIEW_PREFIX`, original `EXCLUSIONS`, `buildPatterns` and the historical five-error guard unchanged. No new exclusion for Krisp and no generated browser table write.
- Verify retained historical input byte identities as qualification-data integrity only; report current route/classification/boundary results under new backend-specific markers. The original UI inventory and generated browser table are not current acceptance operands.

## Proposed finite write claim

New:

1. `scripts/engagement-phase3-backend-contract.mjs`
2. `scripts/engagement-phase3-backend-contract.spec.mjs` (target about 24 meaningful current-input/negative-control cases; final static count recorded)
3. `scripts/backend-source-qualification.mjs` (strict `--plan` / `--run`, allowlisted current source-only argv)
4. `scripts/backend-source-qualification.spec.mjs` (target about 10 selector/ownership/refusal cases)
5. `tests/support/legacy-web/qualification-owner.mjs` (pure historical replay intent/owner preflight)
6. `tests/support/legacy-web/QUALIFICATION-OWNERSHIP.json` (exact old/current cases, markers, owners, source pins, known inherited outcomes; no rewrites of old seals)

Modify:

7. `scripts/engagement-phase3-ui-inventory.mjs` (backend dispatch and explicit historical root, existing UI verifier/scanner rules preserved)
8. `scripts/engagement-phase3-ui-inventory.spec.mjs` (explicit historical source selection; all 32 names/assertions retained, including original five failing invariant assertions)
9. `scripts/engagement-phase3-qualification-plan.mjs`
10. `scripts/engagement-phase3-qualification-plan.spec.mjs`
11. `scripts/verify-outreach-v3-phase6-code.mjs` (backend selector only)
12. `scripts/cleanup-script-smoke/web-visual-cli-controls.mjs` (explicit replay preflight; all 27 scenarios/144 assertions retained)
13. `tests/support/legacy-web/README.md`
14. `tests/support/legacy-web/visual-cli-inputs/README.md`

The preview generator itself and its authority data remain unchanged. No API/Objective/Engagement/shared/schema/application/runtime files are in the write claim. Root source-gate/catalog integration is a separate parent decision. New current catalog includes existing `tests/support/legacy-web/inputs.spec.mjs` plus the new backend contract and selector controls; it explicitly lists historical exclusions/owners instead of silently skipping them.

## Preserved qualification accounting

- Original UI inventory: all 32 current test identities remain available in explicit pinned historical scope; five invariant failures remain honest historical results, not renamed passing current cases.
- Original visual CLI: 27 scenarios / 144 assertions remain available, including both package assertions and known two inherited failures.
- Original preview: unchanged five-prefix rejection remains in code, Git history and sealed native evidence; no route is authorized by reclassification into the backend catalog.
- Existing three full-source replay cases and 13+3 input seal remain unchanged.
- Current frontend parity is owned by `capiro-frontend`; no claim that backend source checks qualify frontend artifact, live runtime, database, compiler or browser behavior.

Implementation is pending parent acceptance. Parent/shared queue owns every test execution.
