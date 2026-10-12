# Exact-source integration matrix

Computed for source `9c2765224fc38d111df0fe184ca50229c6128373` against base `b1ac2649e134af560d41bee790cacbd61de01c9b`.
Refreshed main: `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`.

| Preserved candidate | Changed-path intersections with this prospect source |
| --- | --- |
| 2392 Cleanup | `packages/shared/src/index.ts` |
| 2373 Facility original | None |
| 2364 Reply | `apps/api/src/engagement/engagement.service.ts` |
| 2381 Attachments | `apps/api/src/engagement/attachments/outbound-attachment-access.spec.ts`, `apps/api/src/engagement/engagement.service.ts` |
| 2365 Prospect stages | None |
| 2371 Prospect contacts | None |
| 2362 Objectives | `apps/api/prisma/schema.prisma` |
| 2393 Sender | `apps/api/src/engagement/attachments/outbound-attachment-access.spec.ts`, `apps/api/src/engagement/engagement.controller.ts`, `apps/api/src/engagement/engagement.service.ts` |
| 2394 Facility reconciliation | None |
| 2395 Planner task command | None |
| 2396 Core quick log | `apps/api/prisma/schema.prisma`, `apps/api/src/clients/client-activity.service.ts` |
| 2397 Memory wording | None |
| 2398 Frontend handoff | None |
| 2399 Ordered owners | `apps/api/prisma/schema.prisma` |

The raw JSON records every exact head, merge base and candidate path. This is a
textual intersection report, not native qualification or a claim of semantic
independence. PR2393 is the required base; reply/attachment original work remains
attributed there. `sendSingleMail` is byte-identical to that base.

Cleanup intersects only the shared barrel here: retain both export sets. Its
exact-source release gate remains independent. Facility reconciliation, prospect
stages/contacts, Planner and memory wording have no prospect path intersection.

Core schema composition must include Objective PR2362, Quick log PR2396 and ordered
owners PR2399 deliberately. This prospect candidate does not change ClientsModule;
the coordinator still must compose those other three module registrations. Quick
log also intersects client-activity.service.ts: preserve its canonical wall checks
and transactional create while retaining prospect exclusion on document reads.

Allocated Core migration source order: activity commands `20281012010000`, ordered
owners `20281012020000`, prospect resources `20281012030000`. Workspace has a separate
migration history. No migration execution or wholesale candidate merge occurred.

Compile and test the final composed source; path disjointness alone does not prove
release compatibility. Dot owns deployment preparation and native qualification.
