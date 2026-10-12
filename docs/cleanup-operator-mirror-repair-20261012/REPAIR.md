# Mandatory operator source-mirror repair

Source repair: `aaea904f9d16df38ef57bc1d668a2b06f8d0fd14`, tree `41b8827051bac6d2c1ef4650798c8cdc330d5353`. Base is preserved published PR 2412 `6a4b48e6286a270ab18c033eb4ccaf6f72f42c70`, tree `f14d6fa3f191645839414972063e1057fce557bf`. The canonical scripts were already corrected in `35c64d5def5d2a4c920f3030e2f85067c8cd57d0`; this repair copies their current bytes into exactly three authorized operator mirrors.

| Canonical source under `apps/api/scripts/` | Mirror under `apps/defense-api/runtime-source/operators/` | Original mirror blob | Canonical and repaired mirror blob |
|---|---|---|---|
| phase6-stage-cycle.ts | phase6-stage-cycle.ts | `9bd1bb63da4397b35f347af2ea945b1bcb3c8df5` | `d9a82728dc01bd0b48a92580ab581b13ff19bec8` |
| plan-defense-budget-promotion-v1.ts | plan-defense-budget-promotion-v1.ts | `94fef129178ecfd4c5118e6ae17a7bab5ac23e55` | `c5be25e428397dcf41c10a6cadba0bd6ca3ae2df` |
| status-defense-budget-promotion-v1.ts | status-defense-budget-promotion-v1.ts | `de5426ebfa605340f52334003f18ad691f1df2df` | `d36871ae5ce879f59b941f6ab5eb1c944ab0dec8` |

No canonical source, verifier, manifest, config, package, workflow, migration, or Docker source changed. Exactly three production paths changed, with 38 insertions and four deletions. Original blobs remain accessible in the preserved base/history. No candidate restoration, migration deletion, retirement, main merge, or deployment was performed. The excluded unpublished EngagementService reporting owner was not inspected.

## Why this is required and what behavior it mirrors

`scripts/verify-phase8-session4.mjs:73` names these three source/mirror pairs. Its `read(source) !== read(mirror)` check at line 82 has no exemption for operator scripts. The baseline source-only check records all three failures. After repair, all three are byte-exact.

The mirrored Phase 6 canonical changes add no-argument and sole-help handling, explicit usage, and bounded inspect argument validation. Existing commit/promotion refusal and extraction delegation stay canonical. The two Phase 7 scripts mirror early missing DATABASE_URL usage exits and guarded `require.main === module` invocation. Plan refusal/blocked paths use exitCode plus return so the existing finally disconnect remains reachable. These are inherited canonical behavior, not a new policy or owner introduced by this repair.

## Import and containment trace

[repaired-trace-green.json](evidence/repaired-trace-green.json) contains exact import declarations, hashes, and mapped targets. The old mirror imports, canonical imports, and repaired imports match exactly. There are zero new imports or lib/config dependencies. All eight direct local imports already have byte-identical targets in the defense-budget source/mirror trees:

| Operator | Existing local imports, relative to canonical `apps/api/scripts` |
|---|---|
| Phase 6 | `../src/defense-budget/phase6/phase6-cycle-runner-v1.js` |
| Promotion plan | promotion-planner-v1, canonical-mapping-registry-v1, eligibility-bound-projection-source-prisma-v1, promotion-eligibility-v1 under promotion; extraction-artifact-v1 and canonical-json under contracts |
| Promotion status | `../src/defense-budget/promotion/slo-metrics-v1.js` |

The entire defense-budget Git tree is unchanged and byte-identical at `49a033881715fb1102e8941c9895664f585efae2`, covering the retained dependency source. This is source inventory/parity evidence; no dependency module was loaded or executed. Existing node:child_process/fs/crypto, dotenv, and Prisma imports remain the canonical script's imports. No new package dependency is needed for source mirroring.

The operator mirrors intentionally retain canonical `../src/...` imports and the extraction script argv verbatim. From `runtime-source/operators`, those paths are **not relocated executable module bindings**. Do not import or launch these mirror files as defense-api operators. This repair restores the mandated trusted source copy; it does not claim standalone executable mirror resolution.

Containment sources are unchanged and hashed in the trace receipt:

- `runtime-source/README.md:5` keeps infrastructure-bound and historical operator adapters outside src and the dark HTTP image.
- `apps/defense-api/tsconfig.json` has rootDir src and includes only src/**/*.ts; `nest-cli.json` also uses sourceRoot src. There is no separate tsconfig.build.json in this base.
- `src/runtime/phase1-7-runtime.manifest.ts` remains dark-inspect-only, with no operator executable registration. Its historical defenseBudget gitTreeSha metadata remains unchanged; this packet proves the actual computed source/mirror tree above, not a metadata reconciliation.
- `src/runtime/phase1-7-runtime.adapters.ts:42` hashes fixture slices; its moved root at line 83 reads retained fixture bytes and does not load these operators.
- `apps/defense-api/Dockerfile` copies compiled src/dist, generated client and existing job scripts, and contains no runtime-source COPY in either stage. This file is only inspected; no Docker operation was run.
- Package/config/runtime composition files are unchanged. Their build/typecheck aliases include Prisma generation and were therefore not invoked.

No imports were added to the compiled HTTP composition, no migration/promotion credentials or authority were introduced, and no new shared service/store or broad gate policy was added.

## Bounded inert verification

Reproducible commands, run from the worktree root:

```sh
node docs/cleanup-operator-mirror-repair-20261012/evidence/trace-and-equality.mjs
node --test docs/cleanup-operator-mirror-repair-20261012/evidence/inert-operator-source.test.mjs
```

The trace uses filesystem reads, installed TypeScript AST parsing, hashing, and read-only Git show/rev-parse. It is a separate narrow check; **the actual Session 4 verifier was not executed**. It records original driftCount 3 and repaired driftCount 0, zero changed imports, eight mapped byte-equal targets, and eight unchanged containment files.

The 50/50 author controls check exact bytes and retained baseline history; refuse one-byte mirror drift and changed source even if both copies are changed; parse syntax and compare unchanged imports; and inspect function-local Prisma plus require.main and finally/return source. Behavioral checks evaluate only actual function declarations or exact CLI validation prefixes before the first Prisma constructor, using VM contexts with synthetic argv/environment and inert recording ports. Both canonical and mirrored fragments are checked. Phase 6 tests cover no args/help, forbidden commit/promote, invalid/incomplete/extra arguments, all five inspect commands, exact extraction argv, and Windows pnpm.cmd. Promotion/status tests cover missing database config/required fields, hash/year/family/mode validation, existing unknown-family acceptance, and valid inputs stopping before Prisma. The plan/certification builders are inert stubs, not production policy acceptance.

No production module imports or top-level initialization ran. In particular, dotenv was not loaded, no actual Prisma constructor or database connection/query/SQL executed, no filesystem input payload was read by an operator, and no child process was spawned. The synthetic process spawn port only records arguments. TypeScript transpilation/parsing is not a strict application compile, native database/RLS acceptance, or an operational verifier result.

Retained failures: the baseline three-drift RED receipt/log, and the first inert run with 48 passes and one fixture failure. The fixture incorrectly expected the existing `unknown` budget-family enum member to fail. Its exact test source/log are retained; the final harness tests a truly unlisted value and explicitly preserves unknown acceptance. No production change fixed that test failure.

Independent reviewer acceptance is pending at author packet freeze. Root owns independent review and integration/publication; no new capacity-failed reviewer, model override, or environment bypass was requested here. The wider Session 4 replay/native gates remain open and unclaimed. This repair does not authorize the separately held application conversions or root Phase 1 alias change.
