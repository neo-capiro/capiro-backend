# Exact-source integration and overlap

Source base is ONLY PR2401 `3c20f798c731403ffe2bbb6fa75dcb1bbf80bb16`;
its tree is `188d94ee4cda563a6543468544fd7d1f9885b3f8`. The new branch preserves
that candidate unchanged. PR2404 `0716767e8b6ff323b2516d166b22edb4d2413e57`
contributes ONLY the reviewed byte-identical shared helper and an additive shared
barrel export; no Strategy/Planner/Outreach/Core schema source is wholesale mixed
into this candidate. The helper's accepted implementation is `d198733d66ea6b6b29eaafbccb6a76b6a174b239`.

Operational prerequisites remain preserved Objective2362 schema/migration and the
coordinated corrected Core delegation from2404. The original Objective2402
`30fa58467238542ff2b98137844ea02a3225e545` is preserved in history but has a
known immutable-revision lock privilege defect; corrected2402
`4a784b58a0d41251ae6d7dea75a9b4858abc8665` and published2404 use plain immutable
revision reads. No permission expansion occurred.

| Candidate / owner | Incremental overlap or dependency |
| --- | --- |
| PR2401 newsletter source | VersionsService/controller and shared barrel; required base, original staging/helper bodies preserved |
| PR2404 Strategy/Planner Objective owner | Shared helper and barrel; helper is exact byte identity, retain both export sets |
| PR2400 prospect resources | VersionsService and shared barrel; immutable prospect/source transfer exclusions retained |
| Cleanup2392 | Shared barrel; retain both export sets and its separate exact-source release gate |
| Original Objective2362 / corrected2402 | Existing Core Objective tables/migration and canonical authority release prerequisite; no new Workspace Core ORM/migration ownership |
| Sender2393 / Reply2364 / Attachment2381 | No incremental path intersection; inherited through2401/2400 ancestry |
| Facility2373/2394, stages2365, contacts2371, Planner2395, Quicklog2396, wording2397, owners2399 | No incremental path intersection |
| Effective-date2403 | No source intersection; current published handoff head `7b6fdae2b9ff1fa6d3fbe594ff1a5a0084f6fa5f`, tree `ffa64055b5c14fe8b2807919aa4dfc7e0fefcd29`; accepted runtime source35abc preserved |
| Scoped EngagementService reporting task | No file/branch access or edit; separately owned reviewed unpublished work remains untouched |

The raw matrix records all exact heads, merge bases and computed changed-path
sets. Intersections describe text paths, not release compatibility. Shared export
composition and final integrated source checks remain necessary; Core/Strategy
changes from other candidates are not silently imported. No main merge or deploy
occurs. Dot owns coordinated release and native qualification, including the
concrete existing client/grant lock-order race in CONTRACT.md.
