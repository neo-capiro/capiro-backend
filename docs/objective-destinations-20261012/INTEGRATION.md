# Exact-source Objective destination integration

The resolver is stacked on preserved Objective PR2362
`72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e`, with current main
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace` merged as parent
`68ffba6fe7f6b89c049555a17e3308926f21be56`. It does not mix sender,
prospect, Planner or quick-log candidate source into this worktree. Existing
Objective tables/revisions and migration are reused unchanged.

The source checkpoint after strict typing repair is
`49c6fe290cfc4f02552b05357ae00df1f6750b67`, tree
`b3119cffa84304611f53c9627b2de665b1556df5`. The raw matrix records each exact
candidate head, its computed merge base against main and its full changed paths.
Its initial checkpoint `68de4c51a72bb6e4b1e661c367339183ca18825a` has the same
changed path set as the repair. Textual intersections do not prove runtime or
semantic compatibility.

| Preserved candidate | Resolver increment intersection | Whole stacked branch intersection |
| --- | --- | --- |
| Objective2362 | `objectives.service.ts` | Its existing 15 Objective source/docs paths are inherited; only service is extended. |
| Quick log2396 | None | `apps/api/prisma/schema.prisma`, `apps/api/src/clients/clients.module.ts` |
| Ordered owners2399 | None | `apps/api/prisma/schema.prisma`, `apps/api/src/clients/clients.module.ts` |
| Prospect Files/Workspace2400 | None | `apps/api/prisma/schema.prisma` |
| Cleanup2392, Facility2373/2394, Reply2364, Attachment2381, Prospect stages2365, Prospect contacts2371, Sender2393, Planner2395, Memory wording2397, Handoff2398 | None | None |

Merge Objective persistence/schema/module deliberately once. Compose Quick log
and ordered-owner schema/module additions with that existing Objective source;
compose prospect immutable origins and receipt models in the same Core schema.
This resolver adds no schema/migration source of its own and does not alter
`ClientsModule` beyond inherited PR2362. No inherited candidate head is replaced.

The separately active Newsletter revision staging source intersects this resolver
at `outreach-v3-state.controller.ts` and
`__fixtures__/outreach-v3-route-manifest.v1.json`. Preserve its POST
`sessions/:sessionId/newsletter-staging` beside this GET
`sessions/:sessionId/objective-destination`, including both route-manifest rows.
Its command-engine/CAS/staging-receipt behavior and Workspace source owner stay
with that owner. This resolver changes the session service constructor to require
the existing `ClientObjectivesService`, registered directly in Outreach state
module. It does not register Objective CRUD controllers on Engagement runtime.

The active reporting owner in task01a12dc9-21a3-7062-908e-b6fabc37c027 and all
EngagementService source remain untouched. Its reviewed unpublished code is not
included in this source matrix and is not claimed lost or duplicated. The active
effective-date calendar slice has no resolver path intersection; exact final
composed source still requires qualification. No main merge or deployment occurs.

## Next bounded destination-owner inventory

The next coherent read-only resolver candidates are canonical Strategy and Planner
task owners in `apps/api-strategy`; they already store explicit canonical client
UUIDs and have their own resource policy. They must independently recheck the
current active tenant/membership, resolve Clerk subject to Core actor UUID, apply
the client ethical wall, and verify an existing current Objective revision. A
source helper can compose with the owners' existing shared-database transaction;
it must not introduce a second Objective store or trust browser bindings.

Strategy `SpStrategy.clientId` is canonical but its legacy by-ID read is only
tenant-scoped. A bounded destination read must also refuse archived strategies and
recheck the current same-client wall and Objective revision, then return its own
live plan projection. Planner task `data.clientId` is canonical when explicitly
set and validated by its existing links owner. Its current task/project ACL is
authoritative; an absent client or a multi-project association is not a client
inference. Resolver access must serialize project grants/task edits using the
existing Planner tenant lock, preserve task viewer policy and refuse archival.

General Workspace `WsDraft.client` remains free-text display metadata, including
after PR2400. PR2400's immutable prospect origin and current linked-client wall
provide prospect resource restrictions but do not provide canonical Objective
association for arbitrary drafts. Do not resolve a draft by name or assign client
authority from the display string. Durable Objective-bound creation/association
has no specified atomic owner-write contract in these sources and remains open;
this published read-only observation is not such a write contract.
