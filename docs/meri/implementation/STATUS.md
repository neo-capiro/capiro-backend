# Meri file 01 status

IN_PROGRESS. File 01 is not complete and file 02 has not started. Codex GPT-6 Astra High leads; actual Hermes GPT-5.6 Sol High implements; independent Hermes GPT-6 Sol High reviews. Both Hermes routes were authenticated and smoke-tested through OpenRouter with High effort and no model fallback. Shared runtime settings were preserved.

## Authorized environment and Git recovery

Neo confirmed capiro-dev in AWS is the only environment and neo-capiro/capirov2 is the repository, and explicitly authorized synthetic tenants/users. Creation uses an owned namespace; no destructive fixed-ID seed, real sends, external-provider mutations or production canaries. Production canaries remain user-run.

Recovered original P0A baseline 0ddab91669cb9eae2f2f3b7757424fe98212d52a and P0B 1963efa25a1c981b283292946098438798d4f544. Original closeout claims are not accepted as completion evidence. Main 42942dedad59382f4b4aac6f904b9aee0e02efa6 remains unchanged on GitHub. The local main checkout C:/Users/Administrator/cap-meri-completion is at 0ddab9166 with four dirty P0B files; preserve them. C:/dev/capirov2 has extensive unrelated changes and is untouched. Managed worktree creation was unavailable from this projectless chat; native isolated C:/dev worktrees are used.

Command-local gh credential helper recovered stalled Git publication without changing shared authentication. These exact commits are now backed up on matching GitHub topic branches:

| Branch | SHA | Qualification |
|---|---|---|
| codex/meri-baseline-recovery | 5daff1e4671984b6f2397afb48dc5a1472972a8d | Draft PR 1902; offline baseline only |
| codex/meri-outcomes-validation | aeec5a81639980972e9ebdf4919a52f80b8cc62f | Focused tests pass; review findings still being repaired |
| codex/meri-approval-recovery | dfbb967383e5fff73e801c33f2204a1444d31ea7 | Focused tests/typecheck pass; review pending |
| codex/meri-memory-recall | 18ade62642fbe0d24886a20265a2c29419b5cd3d | 45 tests pass; independent review and SQL/live qualification pending |
| codex/meri-synthetic-fixtures | a3b159fcdffd6e1bf177bf63eb41d0f236142647 | Five offline tests pass; pre-apply review requires repairs |

Integration branch codex/meri-foundation-20260928 currently retains recovered P0A/P0B, dependency cleanup and the full supplied plans/ledger. No main merge, deployment, migration or shared flag/routing change has been performed.

## Evidence and review

Evidence root: C:/dev/cap-meri-foundation-evidence. Reports are bounded source/test evidence, not live acceptance.

- Baseline: frozen offline installs, shared/core builds, 53 Python tests, 40 Node tests, Promptfoo 26/26 and verifier all exit 0 on recovered candidate 50a439243. Dependency repair 6fdccff42 preserves every previous importer/package/snapshot and passes frozen install, shared/core build, 26/26 and verifier. Final 5daff1e46 adds only Node >=22.22 tooling prerequisite documentation. Independent narrow source/lock review accepted preservation and its documentation finding is addressed.
- P0B aeec5a816: 87 provider/runtime tests and 52 proposal-service tests pass, orchestrator typecheck exit 0. API-wide typecheck remains affected by unrelated setup/source diagnostics. Review found research-finalization bypass and post-effect receipt/retry gaps; static findings are being reproduced and repaired, not represented as live defects.
- P0C dfbb96738: 30 controller/card/work-state tests and web typecheck exit 0. Controlled local fixtures cover lost acknowledgment, authoritative status reconciliation and double-click. Authenticated workspace acceptance remains NOT_RUN.
- P1A 18ade6264: baseline old-memory regression failed, candidate 45/45 tests exit 0. Real SQL query performance/correctness, authorization continuation and served recall remain NOT_RUN.
- Fixture a3b159fcd: five pure Node tests exit 0. Independent review found ready-manifest ID, ownership/roster/grant and firm-review-role gaps. No tenant/user has yet been created by this task; repair is underway.
- CI: missing capiro_worker during disposable migrations is reproduced on base main and the recovery PR. Earlier ECR public base-image rate limit cleared on the updated run. Other CI failures remain under investigation; there is no global green verdict and no gate bypass.
- Read-only AWS/database preflight: API task definition 483, image digest sha256:640f76d01bd6d0b7658f1229aee90cd7979c75d8b0f7ab7df76a5d5b7abc3c68, ECR tag 42942dedad59382f4b4aac6f904b9aee0e02efa6. Database reachable locally; six bootstrap models have all expected columns. Historical migration drift is recorded separately, with no migration attempted. ECS exec agents are STOPPED; no service restart requested.

## Active bounded work

- Read-tool outcomes: codex/meri-read-outcomes in C:/dev/cap-meri-outcomes-validation.
- Provider/post-effect reconciliation: codex/meri-outcome-reconciliation in C:/dev/cap-meri-memory-recall.
- Native durable research: codex/meri-durable-research in C:/dev/cap-meri-approval-recovery.
- Isolated fixture hardening: codex/meri-fixture-hardening in C:/dev/cap-meri-fixture-hardening. Fourth implementation slot is temporarily justified by an independent pure-Node setup slice and confirmed 16-core/64-GB host capacity.
- Independent review: read-only exact candidate in C:/dev/cap-meri-foundation-review, currently approval UI.

## Remaining mandatory scope

P0B complete reconciliation/read outcomes; P0C in-Meri memory decisions and files/artifacts; P1A real query/evidence/cache authorization; P1B governed discovery, versioned procedures, commitments and qualified consolidation; P1C plans, aggregate budgets, compaction, durable checkpoints/steering/children/UI; P2 narrative/JEV/trace joins. Source acquisitions require pinned-license/translated-test records. The separate 75 live, CD7, CW01-08 and M acceptance rows remain unqualified. Conditional infrastructure/alternate-runtime work needs explicit disposition and triggers, not automatic expansion.

Read both supplied files in full (foundation 1,779 lines), including original annex contracts. No scope was removed. Independent review, exact both-main integration, approved release and live evidence remain required before handover completion.
