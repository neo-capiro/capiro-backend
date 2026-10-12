# Integrated source composition

Frozen implementation: `11903f32f6257a47e42f49c1abe92c0e0fb0e4fb`, tree `b10a7ed7e2e19d371ad46bfc2a6b57efdbaa997c`. Refreshed main: `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. All 19 relevant source/document PR heads are ancestors; full Cleanup 2392 is preserved separately and contributes only three exact pure guard blobs. [Exact inputs](evidence/published-dependency-refresh.json), [final remote refresh](evidence/final-remote-refresh.json), [190 pairwise path comparisons](OVERLAP-MATRIX.json) and [runtime blob manifest](SOURCE-MANIFEST.json) make this composition reviewable. No original branch is rewritten.

| PR | Exact published head | Composition |
| --- | --- | --- |
| #2362 | `72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e` | Original history retained |
| #2364 | `4b3c672574ed3738e42b1c5e1f7483e32f358095` | Original history retained |
| #2365 | `fd6ed6c017ae91ab774fd34f74475a746de13b68` | Original history retained |
| #2371 | `6c6f88e9e5ba077452716f3a0db0dd3bbea2963f` | Original history retained |
| #2373 | `6e5774a14c73ea04f0a77650a5bbd33173bcc9b3` | Original history retained |
| #2381 | `171ec869ed3928c96172c8790a9aeb3b4de901ae` | Original history retained |
| #2392 | `03d85a40e390f8f52614aab20427a3a9433786bb` | Three exact pure guard files; full history excluded |
| #2393 | `b1ac2649e134af560d41bee790cacbd61de01c9b` | Original history retained |
| #2394 | `5d075af9b376cd3ed67256b5c38e4a2a2130a51d` | Original history retained |
| #2395 | `c5e41e320af4b4d841d4b3136777d712116916ed` | Original history retained |
| #2396 | `e2c2c110edd986e799d47d43b0db50b24fab0201` | Original history retained |
| #2397 | `4915f3fa5c938182b2624377375674654baa5337` | Original history retained |
| #2398 | `797e3a59158cff56b017ab7d01ee445bf624fced` | Original history retained |
| #2399 | `0783423aeaaa8b65f289d0927d605142816d8cfe` | Original history retained |
| #2400 | `6c26ac2dad3756a61b6733329dea7ce3c9138ece` | Original history retained |
| #2401 | `3c20f798c731403ffe2bbb6fa75dcb1bbf80bb16` | Original history retained |
| #2402 | `4a784b58a0d41251ae6d7dea75a9b4858abc8665` | Original history retained |
| #2403 | `39b4ae45db578d121b18db9f95029a8c3ec293a2` | Original history retained |
| #2404 | `0716767e8b6ff323b2516d166b22edb4d2413e57` | Original history retained |
| #2405 | `c05b85a29a75cbaaa8538fd7f9a97e298a23913e` | Original history retained |

The comparison matrix measures each candidate against current main, including ancestor changes in stacked branches. Shared paths require the semantic decisions below; zero intersection is not acceptance.

| Intersection / dependency | Resolution |
| --- | --- |
| Core Prisma schema: Objective2362, activity2396, owners2399, prospect2400, calendar2403 | Union all canonical models/fields and existing backrefs. Independent review compares each published model owner body. No replacement store. |
| ClientsModule: Objective2362, activity2396, owners2399 | Preserve all owner imports/controllers/providers. Export the existing Objective owner module; Outreach imports it and removes the duplicated provider. |
| EngagementService/controller/tests: reply2364, attachment2381, sender2393 | Reviewed 2393 combined sender source wins at conflict paths. Original histories/assertions retained; test fixtures select the exact mailbox. Existing reportOverview equals main. No unpublished reporting read or implementation. |
| Planner controller/service:2395/2396 and2404 | Union canonical task-create command/recovery with expected scope and Objective read. Existing tenant advisory lock and shared tasks remain authoritative. |
| Outreach controller:2401 and2402 | Union saved-revision staging with Objective read; existing commands/receipts/state CAS unchanged. |
| Shared barrel:2400/2401/2404/2405 | Retain client/prospect/saved-revision exports and exact canonical Objective helper. Core, Strategy and Workspace consume the same helper blob. |
| Workspace VersionsService:2401 and2405 | Saved selection/staging contract plus bounded Objective saved-version read; no live text substitution or new authority origin. |
| Contacts2371 with 2400 current authority | Allocate existing proposal at Core11030000 and register existing module. Lock original prospect FOR UPDATE first; then published prospectResourceScope read authority before contact reads/replay/mutations. Current membership/tenant feature/client wall applies. Converted history and exact committed POST recovery remain read-only; new writes409. |
| Calendar 2403 script lifecycle and existing guards | Add missing DATABASE_URL guard before Prisma construction and require.main import guard. Preserve evidence, correction and checkpoint behavior. Update two VM fixtures to model entry execution and add four no-constructor/no-provider lifecycle tests. |
| Workspace migration names in2400/2401 versus offset policy | Only unapplied candidate paths become20261012030000/20261012040000; SQL bytes unchanged. Core remains two-year offset. All568 main migration files unchanged. |
| Cleanup 2392 | Copy only exact migration-integrity, timestamp and cli helper blobs. Main retired Meri stub and isolation validator remain unchanged. Full Cleanup source is not accepted or merged. |

Merge failures, resolutions, fixtures and source-check failures remain under evidence; migration allocation proof is [byte-pinned](evidence/workspace-migration-allocation.json). Build/config/migration prerequisites and deferred gates are centralized in [RELEASE-MANIFEST.json](RELEASE-MANIFEST.json) and [HANDOFF.md](HANDOFF.md). Prior per-slice handoffs remain historical exact-head receipts; the integrated handoff controls candidate allocation/module status.
