# LegiWatch folder tracker — implementation record

Base: `8f65c0eb219b77e9dc56970d7add043d2394d65a`, isolated branch
`agent/legiwatch-phase1-lobbytools`. No overlapping folder tracker was found in
open PRs; #1469 is an independent hearing workflow and remains untouched.

## Ownership and pause boundary

The active vNext BillsTab calls intel-api `/clients/:clientId/tracker/board`.
Bill 360 composes global API-owned state/federal records with intel-owned client
context. New independent folders and assignments belong to intel-api. They never
create `intel_tracked_bill` rows, notification subscriptions, detector watermarks,
or delivery rules. Removing a folder assignment cannot untrack a legacy bill.
`legiwatch_folder_tracker_v1` requires an explicit enabled row even internally.
Existing flag defaults and Hearings landing remain intact.

API and Intel task definitions both select database `capiro` in us-east-1, account 967807252336. Both migration trees use the shared Aurora ledger. The approved API
runner is `capiro-dev-api-migrate` (observed rev 107); never admin-migrate. Intel's
automatic failed-ledger rewrite is removed. Neither runner may repair a ledger.
Physical host equality was verified from both task configurations and the resolved
Aurora endpoint. The live ledger contained 442 applied entries and zero unresolved
failures. Point-in-time recovery retention is 35 days. These read-only checks do
not constitute a production migration or restore rehearsal.

## Runtime reference, 2026-09-10

Authenticated active board: 29 assignments, 28 federal and one state. Opened
CA AB 1093 through Bills and the drawer, then full page `/bills/ca-2025-ab1093`.
It shows To Governor, latest official action 2026-09-03 and a 78–0 concurrence
vote. The existing Synced label uses a legislative date; provenance needs repair.
Federal regression reference: H.R. 8800, National Defense Authorization Act for
Fiscal Year 2027, currently in the Passed Chamber board across multiple clients.

## Evidence and design

Evidence ZIP SHA256:
`6c902fec04f031ec7d62ba15fdf1ae7f411c1b354c6b5182e4e3735bf0edd658`.
All 41 manifest entries verified; raw evidence stays outside the repository.
Expected inventory: 210 folders, 1,928 assignments, 857 source bill IDs. Durable
namespace is an explicitly mapped source account + object type + source ID;
capture namespace is separate. No tenant/client/user mapping is guessed.

Product Figma `2aa9ipR2qOfumaixZErCfU`, Bills `869:3111` read with design context.
Current mappings include CapiroButton (actions), CapiroBadge, GlobalSearch;
table primitives are `vnext/components/tables`. Preserve Hanken Grotesk, IBM Plex
Mono metadata and Capiro/Untitled UI tokens. LobbyTools screenshot 008 controls
the workflow: 240px folder rail, dense sticky-header table, session/jurisdiction
filters, FastTagger preview, independent context editor and scoped export.
Phase 1 design work uses a new working page, not vendor or canonical frames.

Working page: [Phase 1](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU/?node-id=1393-4175).
The six 1600 × 1000 frames reuse Capiro buttons, inputs, badges and typography:

| View | Working frame | Implementation |
| --- | --- | --- |
| Folder table | [1393:4176](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU/?node-id=1393-4176) | FolderBillsTab |
| Context editor | [1401:2725](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU/?node-id=1401-2725) | FolderContextPanel |
| FastTagger | [1402:2981](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU/?node-id=1402-2981) | FolderBillsTab bulk resolver |
| Saved view | [1403:3235](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU/?node-id=1403-3235) | SavedViewsOverlay |
| Import reconciliation | [1404:3467](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU/?node-id=1404-3467) | FolderImportReview |
| Report preview | [1405:3691](https://www.figma.com/design/2aa9ipR2qOfumaixZErCfU/?node-id=1405-3691) | FolderReportPreview |

## Qualification and unresolved mappings

The private capture expands to 3,542 normalized records. Both complete local
rehearsals and repeat CLI invocations retained one durable run per manifest and
identical outcome counts. Internal staging contains 1,391 inactive definitions;
client staging contains 1,404, including all 13 user definitions. No captured
users were provisioned. Both runs retain 210 blocked folders and 1,928 blocked
assignments until their owners are provisioned and mapped to active membership
in the target tenant. No legacy tracked-bill rows were created.

Florida lookup aliases normalize H/S and HB/SB within the selected Florida
session. Canonical IDs are never rewritten. Live catalog qualification resolves
1,919 assignments to 850 distinct canonical bills. Nine references to seven
proposal IDs remain unresolved; HCB, SAB, GOS, BUC and WMC are never coerced to HB.

The report rehearsal reads the real 11-bill selection and source records through
2026-06-26, with actions restricted to June 22–26 inclusive. It has source summaries
and pre-cutoff history for all 11 bills. Capture observations and canonical
publication dates remain separate: for example the capture's HB 47 observation
is June 25, while the [official history](https://www.flsenate.gov/Session/Bill/2026/47)
also records chapter publication on June 26. Source history is not rewritten to
force screenshot equality. Preview never enables report delivery.

The disposable upgrade applied 386 prior migrations, seeded existing state and
federal tracking with private context, then applied the three new migrations.
The old generated client and baseline state repository returned identical data;
all prior ledger entries were unchanged and old source-check fields remained
unknown. The rebuilt Intel image returned exit 1 / P3009 against a failed ledger,
with the failure still unresolved. Durability checks used PostgreSQL fsync on.
Broad fixture runs also used a disposable database with fsync temporarily off;
that setting was restored and is not part of CI or production configuration.

Independent review covered migration ownership, tenant/privacy boundaries,
canonical alias resolution, owner checks, import recovery, document identity,
export limits and release order. No remaining actionable backend finding was
reported after repairs. Release approval must still refer to the exact commit.

## Release order

`api-image` and `intel-api-image` publish ARM64 images and mutable latest tags,
but do not deploy HTTP services. Inventory and pin affected scheduled consumers
before publishing schema-dependent images. `web-vnext-deploy` automatically
deploys production os.capiro.ai from main changes including shared/lockfiles.
Backend migrations and dark API deployment must precede frontend merge. Record
reviewed SHA, digest, task revisions, tests, canary/import reconciliation and
detector-cycle proof independently. No production mutation has occurred yet.
