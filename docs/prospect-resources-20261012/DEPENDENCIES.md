# Prospect resource integration ledger — 2026-10-12

Worktree `capirov2-prospect-resources`, branch
`codex/prospect-resource-origin-20261012`, deliberately based on reviewed sender
PR2393 `b1ac2649e134af560d41bee790cacbd61de01c9b`. Main refreshed at
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. This candidate owns backend source only.
No shared frontend or meri-greenfield writes. No original candidate branch changes.

## Resource and authority owners

| Resource | Existing owner | Integration boundary |
| --- | --- | --- |
| Prospect identity/lifecycle/conversion | Core BusinessDevelopmentProspect/BusinessDevelopmentService | Retain exact tenant/prospect UUID. Dismissal is soft; conversion updates linkedClientId on that same row. No copy or client-name matching. |
| Uploaded bytes and attachment lifecycle | EngagementAttachment/EngagementService | Preserve scan, content digest, current-version, uploader/viewer, S3 deletion and existing source provenance. A durable prospect upload intent binds presign to confirm/replay. |
| Current Core actor/tenant access | users + active tenant_memberships | Resolve Clerk subject to Core UUID inside tenant; require current membership and existing BD role floor. Never cast Clerk IDs to UUIDs. |
| Converted-client wall | clients + client_memory_access | Apply current linked-client wall in addition to the prospect and existing resource ACL. No admin bypass. |
| Workspace draft/documents/versions | Workspace WsDraft/WsDocument/WsDocVersion | Immutable canonical prospect origin; free-text client remains descriptive only. Existing owner/collaborator rights still required. |
| Workspace collaborators/source receipts | CollaboratorsService and ws_source_action | Preserve role matrix and Intel-origin access. Prospect membership adds a restriction, never an implicit collaborator grant. |
| Public sharing / generated cross-service context | Existing delivery/generation owners | Prospect origin must not become an anonymous share or an unrelated client/context source. Unsupported paths fail closed; no new generation or send activation. |

## Deliberate schema allocation (source only)

Reserve Core `20281012030000_prospect_resource_origin` after Quick log
`20281012010000_client_activity_commands` and ordered owners
`20281012020000_client_ordered_owners`. Workspace owns its own migration directory
and `ws_*` schema only; no Core tables are added to its Prisma schema, and no new
cross-schema foreign-key ownership is assumed. All migration SQL is reviewable
source only and MUST NOT be executed, including in an ephemeral database.

## Preserved candidates / merge dependencies

| PR | Exact preserved head | Relationship |
| --- | --- | --- |
| 2392 Cleanup | 03d85a40e390f8f52614aab20427a3a9433786bb | Independent exact-source release gate; preserve shared lifecycle/config/tests. |
| 2373 Facility original | 6e5774a14c73ea04f0a77650a5bbd33173bcc9b3 | Preserved CAS original. |
| 2364 Reply | 4b3c672574ed3738e42b1c5e1f7483e32f358095 | Attributed work already reconciled in PR2393. |
| 2381 Attachments | 171ec869ed3928c96172c8790a9aeb3b4de901ae | Attributed work already reconciled in PR2393. |
| 2365 Prospect stages | fd6ed6c017ae91ab774fd34f74475a746de13b68 | Recompute schema/prospect path intersections; no wholesale merge. |
| 2371 Prospect contacts | 6c6f88e9e5ba077452716f3a0db0dd3bbea2963f | Preserve prospect conversion/contact semantics. |
| 2362 Objectives | 72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e | Core schema/ClientsModule integration must be reviewed separately. |
| 2393 Sender | b1ac2649e134af560d41bee790cacbd61de01c9b | Required base, exact sender/provenance/reply/attachment authorization preserved. |
| 2394 Facility reconciliation | 5d075af9b376cd3ed67256b5c38e4a2a2130a51d | Independent; native concurrency qualification still separate. |
| 2395 Planner task command | c5e41e320af4b4d841d4b3136777d712116916ed | Existing task owner; no task-service rebuild. |
| 2396 Core quick log | e2c2c110edd986e799d47d43b0db50b24fab0201 | Owns activity command; schema/ClientsModule composition only, no copy. |
| 2397 Memory wording | 4915f3fa5c938182b2624377375674654baa5337 | Independent wording-only source. |
| 2398 Frontend handoff | 797e3a59158cff56b017ab7d01ee445bf624fced | Contract documentation source. |
| 2399 Ordered owners | 0783423aeaaa8b65f289d0927d605142816d8cfe | Schema/ClientsModule composition only; preserve versioned ranks/legacy owner adapter. |

Before publication, recompute exact changed-path intersections for this candidate
and all refs above. A shared schema filename does not authorize cherry-picking all
other candidates. No merge, migration, deploy, provider messages/uploads or paid
model runs are authorized. Native SQL/RLS/concurrency qualification stays unrun.

## Pending choices and access review

Neo removed the new Commitment UI scope at 04:41 UTC and requested reference-based
dead-code cleanup at 04:42 UTC. Firm-vs-client/WeOwe/TheyOwe semantics are no longer
a pending build decision. The existing activity contract and PR2396 generic
activity/Planner command remain in scope and are preserved. Prospect resource origin will survive conversion;
current linked-client access is additive and no resource is copied into a client
library. Detailed lifecycle/read/write and sharing rules will be recorded with the
implementation. Independent reviewer is auditing alternate resource readers,
conversion/revocation, durable recovery and the Workspace service boundary.
