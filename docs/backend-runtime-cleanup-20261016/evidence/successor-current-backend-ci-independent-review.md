# Independent current backend CI ownership review

Source-only review of successor work over PR30, with repository HEAD observed at `477ebfca554639a0ffaf447a59a37d2b3c6709df`. The frontend-consumer owner was still expanding its catalog during review. No tests, native parse, framework, build, install, application or child helper execution. No agent-owned source was edited. This evidence file is the only write in this review task.

## Finding requiring a bounded correction

**P2 — Additive route ownership ignores declared controller-prefix metadata.**

`scripts/engagement-phase3-backend-contract.mjs:70-92` validates manifest version/routes and `runtime`, but never validates `globalPrefix` or `controllerPrefix`; routes need only start with broad `/api/engagement/`. The state and reasoning manifests declare `/api` plus `/engagement/outreach-v3`; templates declares `/api` plus `/engagement/outreach-v3/templates`. Changing one of these controller-prefix declarations to `/unowned`, or changing its route to `/api/engagement/other-owner/probe`, still satisfies the new validator's source logic. `verifyBackendPreviewBoundary:160-166` then derives its expected patterns from the same wrongly owned declarations, so that comparison does not expose the inconsistency.

This is a false pass for the admitted plan's promise to validate additive runtime/prefix metadata as metadata. It does not imply a browser table is written or any live route authority changes. Correct it using a finite per-file schema/owner prefix contract and path-boundary checks, with negative controls for changed declared prefix, missing/incorrect required prefix fields and an in-Engagement route outside its declared owner. Five other admitted additive schemaVersion files omit global/controller-prefix fields, so do not invent a universal required field without mapping their existing format.

The finding was sent to the parent before this receipt. It is based on source reasoning, not an executed mutation test.

## Reviewed behavior without another concrete blocker

- Current backend inputs remain the same nine finite manifest paths. Primary source-file/handler references are checked against current admitted controller source; classification uses the retained Engagement decorator scanner. Credential resolve/Recall and additive metadata are explicitly scoped as separate declarations without invented local/external action classification. No actual router/live/frontend acceptance is claimed.
- `engagement-phase3-qualification-plan.mjs:53-58` replaces exactly the two historical UI/table tuples in backend mode and preserves command/options. Full mode remains unchanged; frontend-only retains the original steps. Updated plan tests assert the exact replacements, retain the actual original full array and preserve unrelated selected checks.
- `engagement-phase3-ui-inventory.mjs:930-952` has strict backend dispatch and explicit historical UI grammar. Its lazy backend import avoids re-entering historical coverage. The historical build and verifier explicitly receive the pinned historical route manifest/root (`:966-989`). All32 historical test identities/assertions are retained; the spec now binds inventory, route manifest and runtime scan to that root. It does not re-label the five known historical failures as current passes.
- `verify-outreach-v3-phase6-code.mjs:259-269` selects current backend preview-boundary checks only for backend mode. The original generator command remains in full mode. Existing failure propagation is unchanged.
- The preview generator file and its `PREVIEW_PREFIX`, two `EXCLUSIONS`, `pathToPattern` and rejection behavior were unchanged. The current boundary checker explicitly preserves prefix/exclusion paths, checks anchored exact generated patterns and keeps all non-preview backend catalog paths outside those patterns. Historical unaccounted Krisp paths are exposed as historical data rather than new preview exclusions.
- `qualification-owner.mjs` admits exactly `--historical-replay`. The visual wrapper checks help/intent before archive payload reads, temporary fixtures or scenario execution. The diff only adds that preflight and smoke metadata; every original27scenario/144assertion body, including both old package assertions, remains.
- `QUALIFICATION-OWNERSHIP.json` identifies current backend source controls separately from original32inventory cases,27visual scenarios, the generator and three full-source replay cases; names, source pins, inherited results and canonical `capiro-frontend` parity owner are explicit. The catalog was still being expanded, so its final14path list/ledger synchronization requires the owner's completion review.

## Limits to preserve

These checks validate source declarations, not completeness of actual Nest registration, controller method/path decorator agreement, native dispatch behavior, default Onboard/image/platform closure, current frontend parity or deployed routing. Additive handlers remain declared metadata rather than verified current controller registrations, as the ownership scope explicitly states. No whole-service/source-count hash should be introduced to compensate for these scoped limits.

The historical source-root preflight remains the existing explicit exact-commit/clean-source check. Native POSIX filesystem/shell controls and recorded Windows limitations remain separate qualification obligations. No full historical replay or local test process was run by this reviewer.
