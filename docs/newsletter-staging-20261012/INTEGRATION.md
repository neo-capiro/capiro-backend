# Exact-source dependency and overlap handoff

Required base: PR2400 `6c26ac2dad3756a61b6733329dea7ce3c9138ece`.
Main last refreshed by the coordinator: `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`.
The exact ledger at `797e3a59158cff56b017ab7d01ee445bf624fced` remains preserved;
its older prospect status is superseded by PR2400's published CONTRACT/INTEGRATION.
Original and reconciled candidate heads remain untouched.

| Preserved candidate | Incremental newsletter source intersection |
| --- | --- |
| Cleanup2392 `03d85a40e390f8f52614aab20427a3a9433786bb` | `packages/shared/src/index.ts`; preserve both export sets |
| Facility2373 / Facility2394 | None |
| Reply2364 / Attachment2381 / Sender2393 | None; retained through required base |
| Prospect stages2365 / contacts2371 | None |
| Objective2362 | None with original candidate; do not recreate persistence |
| Planner2395 / Core Quicklog2396 / wording2397 / ordered owners2399 | None |
| Prospect Files/Workspace2400 | `VersionsService` and shared barrel; required base preserves all prospect restrictions |
| New objective-destinations slice (separate owner) | Outreach state controller and route fixture; retain its GET destination and this POST staging entry |
| New effective-date calendar slice (coordinator) | None expected; Core migration history remains separate from this Workspace migration |
| Scoped EngagementService reporting task | No EngagementService edit or branch access; unchanged unpublished owner work remains separately attributed |

`path-intersections.json` retains every exact preserved head, merge base, full
changed-path set and computed intersection. This is a textual source report, not
runtime compatibility proof. Do not cherry-pick this source onto main without the
PR2400 dependency or mix it with older incompatible resource owners.

Compose shared exports and build shared first. Compose the two additive Outreach
controller/fixture entries deliberately; the objective owner changes session
service/module, while this slice changes the existing command engine. Workspace
VersionsService retains current prospect behavior and adds only the bounded
saved-revision selection seam. The text-projection helper is re-exported under
its existing `meriImportText`/`htmlToPlainText` names; existing consumers are retained.

The new Workspace migration has its own history and does not compete with Core's
Objective/Quicklog/ordered-owner/prospect/effective-date migration slots. No
migration was executed. Final composed sources need their own type/build/tests,
role and native PostgreSQL qualification before release. Dot owns preparation.
