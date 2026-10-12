# Effective-date calendar integration matrix

Main was refreshed and remains `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`.
This candidate is independently main-based, separate from all preserved branches.
It has no dependency on sender, prospect resources, Objectives, Planner, ordered
owners, or the ongoing EngagementService reporting slice. No EngagementService
file or reporting-owner branch was inspected or changed by this slice.

| Preserved candidate | Exact preserved head | Changed-path intersection with effective-date source |
| --- | --- | --- |
| Objectives2362 | `72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e` | Core schema |
| Reply2364 | `4b3c672574ed3738e42b1c5e1f7483e32f358095` | None |
| Stages2365 | `fd6ed6c017ae91ab774fd34f74475a746de13b68` | None |
| Contacts2371 | `6c6f88e9e5ba077452716f3a0db0dd3bbea2963f` | None |
| Facility2373 | `6e5774a14c73ea04f0a77650a5bbd33173bcc9b3` | None |
| Attachments2381 | `171ec869ed3928c96172c8790a9aeb3b4de901ae` | None |
| Cleanup2392 | `03d85a40e390f8f52614aab20427a3a9433786bb` | `apps/api/scripts/sync-federal-register.ts` |
| Sender2393 | `b1ac2649e134af560d41bee790cacbd61de01c9b` | None |
| Facility2394 | `5d075af9b376cd3ed67256b5c38e4a2a2130a51d` | None |
| Planner2395 | `c5e41e320af4b4d841d4b3136777d712116916ed` | None |
| Quick log2396 | `e2c2c110edd986e799d47d43b0db50b24fab0201` | Core schema |
| Wording2397 | `4915f3fa5c938182b2624377375674654baa5337` | None |
| Handoff2398 | `797e3a59158cff56b017ab7d01ee445bf624fced` | None |
| Ordered owners2399 | `0783423aeaaa8b65f289d0927d605142816d8cfe` | Core schema |
| Prospect resources2400 | `6c26ac2dad3756a61b6733329dea7ce3c9138ece` | Core schema |

The full computed JSON records exact source/tree, each candidate merge base and
actual intersecting paths. Textual intersections are evidence for integration
review, not native compatibility acceptance. All fifteen heads were refreshed
read-only and remain unchanged; all candidate objects were fetched without moving
those branches. No original head, worktree or publication was overwritten.

Core schema changes are independent additions inside FederalRegisterDocument;
preserve the Objective, activity/command, owner and prospect schema blocks on
composition. Migration slot `20281012060000` is deliberately later than the
reserved Objective, activity10000, ordered-owner20000 and prospect30000 sources.
No migration is executed, and Workspace retains its own migration history.

Cleanup's script change adds its DATABASE_URL entry guard and require.main wrapper.
Compose those with this candidate's exact source evidence writer, publication
completeness checks and explicit historical effective-date refresh path. Retain
Cleanup's independent exact-source release gate; do not substitute these synthetic
checks for it.

The optional RunCounts.stats property and SyncRun persistence are backwards
compatible with callers that omit it; retained ingestion regression suites verify
that behavior. Route registration stays in existing FederalRegisterModule.
There are no frontend/meri-greenfield edits or dependency/permission changes.
The excluded Commitment / We owe / They owe / counterparty UI and full commitment
semantics remain unimplemented; existing shared activity/Planner/task owners are
preserved. This slice adds no dead commitment scaffolding.

Compose and qualify the final source under dot's release process. Standalone
source checks do not authorize native DB/RLS/constraint/concurrency execution,
AWS operations, provider calls, main merge or deployment.
