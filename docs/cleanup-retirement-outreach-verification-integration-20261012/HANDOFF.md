# Current Outreach verification scope integration

The current Phase1/3/4 standalone wrappers now accept explicit `--run` with zero or one `--backend-only`/`--frontend-only` flag. Standalone `--help` exits0; no args, duplicates/conflicts/unknown tokens, mixed help/run and missing run exit2 before commands, file reads or environment mutation. The original cleanup metadata stays `noArgsExit=2 helpExit=0`. This adopts only the bounded scope behavior of PR2423, preserving current destination source rather than replacing wrappers with older Core copies.

Source freeze is `4060915ebfa55db4a8fb805c1e25281359c46a5d`, tree `1fee6de079b59ecc3947109bb897f31d963a235b`, based published `5470c6df029c9553dd49e531229c3c91b26275ef`/tree `613e54b654bc30dcebd09c955c58a2e8940abf30`. Preparatory before-source fixtures are separate docs-only commit `c0313c67d73c3191b6c275f853c26a418c9c45dc`; the current original files were captured before edits. Both commits include `[skip ci]`. Requested PR2423 reference is `8ac4c42cc49876ec19808369c0683956e0f2f474`/tree `3312abb3d381d05ab5b499b48bbb8870de6f158a`, with its ROOT-INTEGRATION instructions read before editing.

Only five source/test paths changed: three `scripts/verify-outreach-v3-phase{1,3,4}-code.mjs` wrappers and the new pure `scripts/outreach-v3-qualification-plan.mjs`/`.spec.mjs`. No root package/CI, existing Engagement verifiers, API/Web source/fixture/schema/runtime/newsletter/frontend file changes occur here. Root owns union/aliases/CI; the other author owns Engagement Phase1/2/3 and their existing marker consumers.

| Mode | Phase1/3 | Phase4 |
| --- | --- | --- |
| Full explicit run | Original12/13 full step arrays, order, target lists, environments and subprocess policy unchanged. Full completion and exit behavior retained. | All original local source/catalog/route/scope checks and six commands remain. Nested Phase3 still includes its original one `--run`. |
| Backend | Every current full step retained; only inherited Engagement Phase3 alias becomes `verify:engagement-phase-3:backend`. | Original local contracts remain; nested Phase3 forwards exactly `script --run --backend-only`; all remaining current commands/options remain. |
| Frontend | Matching inherited `verify:engagement-phase-3:frontend` and original whitespace controls only. Engagement's own held positive source/prototype/context inventories remain its owner's responsibility. | Local API contract envelope is skipped; nested Phase3 forwards `script --run --frontend-only`, followed by original diff/current-PR whitespace controls. |

The new helper receives each wrapper's CURRENT full steps; it contains no old target/command list. Full mode returns the caller's array unchanged. Scoped plans retain all unchanged tuple/options identities and ordering. The current inherited alias/child forms are checked before scoped forwarding; duplicate/missing run or pre-scoped/wrong nested forms fail before the injected runner. No generic recovery, parser dependency or new service/store is introduced. Every exported helper is used by an actual wrapper.

All nine own completion markers are distinct: `OUTREACH_V3_PHASE{1,3,4}[_BACKEND|_FRONTEND]_DB_FREE_COMPLETE`, with no qualifier for full. Scoped normal runner failures emit their matching `...FAILED` marker; full runner failures retain original output. All original source-contract/pre-loop failure behavior remains. Phase1/3 retain their original failure exit1; Phase4 retains the actual child status (or1 when null). Current cwd/env/shell/stdio/error policies remain, including Linux/Windows behavior. There is no new child stdout capture or marker acceptance: Outreach still relies on child exit status. Exact matching nested scope is enforced by planner/root aliases; this change does not claim dynamic rejection of a dishonest child's mismatched stdout marker. Existing Engagement Phase2/Phase3 Windows marker consumers require their separately owned matching-scope adaptation. No unused marker matcher was added.

Root must add six aliases, each with exactly one `--run`:

```
verify:outreach-v3-phase-1:backend  -> node scripts/verify-outreach-v3-phase1-code.mjs --run --backend-only
verify:outreach-v3-phase-1:frontend -> node scripts/verify-outreach-v3-phase1-code.mjs --run --frontend-only
verify:outreach-v3-phase-3:backend  -> node scripts/verify-outreach-v3-phase3-code.mjs --run --backend-only
verify:outreach-v3-phase-3:frontend -> node scripts/verify-outreach-v3-phase3-code.mjs --run --frontend-only
verify:outreach-v3-phase-4:backend  -> node scripts/verify-outreach-v3-phase4-code.mjs --run --backend-only
verify:outreach-v3-phase-4:frontend -> node scripts/verify-outreach-v3-phase4-code.mjs --run --frontend-only
```

Current full aliases stay unchanged. Corresponding scoped EngagementPhase3 aliases/strict guard adoption must be supplied by their owner in the same union. Root's destination-specific package/CI contract should verify one run token, matching nested aliases and inherited current commands; do not copy PR2423's old whole root file/contract or older fixture bridge. Source context/inventory inputs remain held until their consumer owners deliberately migrate them.

The author pure/fake suite passes21/21. It evaluates actual before/current wrapper text via VM with only fake commands/files/process, preserving full command/read/env/exit traces on Linux and Windows, enforcing preflight zero-effects, scoped caller forms/markers, early failures and full/backend local predicate refusal. Phase1/3 arrays preserve raw hashes `b0c39d...`/`ce18a...`; Phase4's complete source/catalog/route/scope body preserves `cd0ac...` after removing indentation envelope. Additional AST/hash checks pass24/24, proving original function/process bodies and all six Phase4 calls exact after only declared planner/marker reversal, all five source/test blobs frozen and all exports used. Six additional inert pairs retain original scope refusal2 with zero effects versus deliberate new scope acceptance. Syntax-only Node checks pass for all five source/test files.

These are source/pure/fake checks, not real verifier `--run`, pnpm/install/build/app tests, Prisma/DB/SQL/native/provider/model/AWS/credential/permission/frontend/CI/live qualification. No actual child process or customer API/GET/provider/fixture operation was performed by the test harness. Raw initial trace-capture meta-substitution failures remain with corrected PASS; production source/tests stayed frozen. Independent review and root final union/publication remain pending at this handoff. Main merges/deployment and all earlier native/full/frontend/parser/clock/migration limits remain open.
