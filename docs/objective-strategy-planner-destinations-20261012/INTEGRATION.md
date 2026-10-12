# Published-source integration and owner boundaries

The frozen implementation is `d198733d66ea6b6b29eaafbccb6a76b6a174b239`,
tree `df1d72330029edbc0a250940a9adb98c14c8c87b`. The earlier contract checkpoint
`b5e61175eff7cebe28a70a79da41e12d8f584b28` remains an ancestor; the final source
adds explicit scalar UUID checks and their regression vectors. Review and
qualification receipts identify this implementation separately from later
documentation/evidence commits. Original candidates, the original PR2402 head
`30fa58467238542ff2b98137844ea02a3225e545`, and its corrected published head
`4a784b58a0d41251ae6d7dea75a9b4858abc8665` remain preserved. There is no main
merge or deployment. Read-only remote main refresh still returned
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace` before publication.

## Required source and operational prerequisites

This branch deliberately composes the corrected, reviewed PR2402 source. Its
Objective persistence originates in PR2362 at
`72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e`. No other candidate source was merged.
The immutable-revision permission correction is inherited unchanged: SELECT on
the immutable revision, with existing current authority/Objective row locks.
The canonical helper replaces the Core implementation through delegation;
Strategy and Planner delegate in their own existing resource transaction. Keep
that single authority implementation when reconciling Objective source.

PR2362's existing Core Objective tables/migration and the existing current
tenant/user/client grant tables are operational prerequisites. Strategy's Prisma
schema does not acquire Core models or own Core migrations. Schema/migration
source was never executed here. The coordinated Core/Strategy release must build
the changed `@capiro/shared` package first and include it in Strategy's runtime;
the package manifest, lockfile importer, and Docker build/runtime source express
that dependency. The Dockerfile was reviewed as source, never executed.

Newsletter PR2401 and prospect PR2400 are independent candidates, not dependencies
of these Strategy/Planner routes. The Workspace owner may selectively consume the
byte-identical published helper plus its shared export into its own PR2401-based
worktree. That consumption must retain exact publication provenance, PR2362's
operational table prerequisite, and a coordinated release with canonical Core
delegation. It must use its own published saved/current canonical client authority;
this helper supplies only Objective authority. General draft client inference,
durable associations and Objective-bound creation remain separate open contracts.

Frozen helper provenance:

- Git blob: `767a11ddff2ff43a39cdf572029b40a4976facac`.
- SHA-256: `a7fafdf28c55cb9af93b2faf5fbb4b824023622cc68b08501e0d367dcf4a5443`.
- Path: `packages/shared/src/client-objective-destination.ts`.
- Additive shared export: `export * from './client-objective-destination.js';`.

## Candidate overlap and reconciliation

`evidence/path-intersections.json` records exact preserved candidate heads,
merge bases, complete changed paths, and both incremental and whole-branch
intersections. Its incremental base is corrected PR2402 at `4a784b58...`; whole
branch comparisons use actual main `4be13b0...`. It is a frozen source snapshot,
not a claim that candidate publication heads cannot subsequently advance. Later
documentation/evidence additions do not change the implementation overlaps.

| Preserved candidate | Incremental source intersection | Required reconciliation |
| --- | --- | --- |
| PR2362 `72bfea4c...` | Core `objectives.service.ts` | Keep canonical Core delegation and original CRUD/authorization behavior. Do not create another Objective store. |
| PR2392 cleanup `03d85a40...` | Strategy package manifest, shared barrel, lockfile | Preserve cleanup's unrelated source decisions and this required shared dependency/export. |
| PR2395 Planner `c5e41e32...`; PR2396 Quick log `e2c2c110...` | Planner controller and service | Deliberately retain existing command receipts/expected scope and the new bounded read route. No abandoned commitment or counterparty semantics are introduced. |
| PR2400 prospect `6c26ac2d...` | Shared barrel | Retain both candidates' additive exports. Whole-branch comparison also intersects inherited Core schema. |
| PR2401 newsletter `3c20f798...` | Shared barrel | Retain saved-revision and Objective exports. Whole-branch comparison also intersects inherited schema and Outreach controller/manifest: retain both newsletter staging and Outreach Objective route entries. |
| Corrected PR2402 `4a784b58...` | Core Objective normalizer/service | Required base; retain shared delegation and plain immutable SELECT. Its original `30fa5846...` head remains preserved. |
| PR2403 original calendar `f5a043c2...`; corrected current `762aea00...` | None | Both exact heads are in the matrix; corrected tree `c349623a48a16b8f4d197c66706f06fb95b04de2`. Whole-branch comparisons intersect inherited Core schema. Reconcile schema source deliberately; this slice adds no schema or calendar behavior. |
| Original/reconciled facility, reply, attachment, prospect stages/contacts, sender, memory wording, handoff, ordered owners | None | Whole-branch ordered-owner comparisons include inherited Core schema/clients module. Disjoint paths are not runtime/native acceptance. Exact pins remain in the machine-readable matrix. |

The EngagementService reporting owner's work and branches are untouched. This
matrix does not imply acceptance or loss of that independently owned unpublished
work. Root's reconciled handoff tracks later candidate corrections separately.

## Owner closure matrix

| Kind or operation | Canonical owner | This source result |
| --- | --- | --- |
| `outreach_session` read | Existing Outreach session service | Corrected PR2402 inherited; Core authority now delegates to the same shared helper. |
| `strategy` read | Existing Strategy service | Bounded current same-client/revision resolution implemented. |
| `planner_task` read | Existing Planner service | Bounded current explicit-client/revision resolution with existing viewer ACL implemented. |
| Exact `workspace_saved_revision` read | Existing Workspace saved-version owner | Separately assigned; waits for reviewed helper publication. Not implemented or claimed closed here. |
| Arbitrary Workspace draft read | Existing Workspace owner | Open: free text and a draft claim do not establish same-client authority. |
| Objective-bound creation or durable association | Existing destination command owner | Open separate contract: this read result is an observation, not a capability/receipt/store. |

Every destination open must recheck the actual current owner route. No browser
binding, revision UUID, old unbound GET or cached response grants future access.
