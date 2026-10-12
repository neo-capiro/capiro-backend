# Remaining Capiro source contracts: reconciled handoff

This handoff owns only Objective destinations, saved newsletter revision staging
and authoritative effective-date calendar sourcing. Main is still
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. All publications are draft, unmerged,
source-qualified candidates in separate worktrees. Original and intermediate heads
remain preserved. There are no capiro-frontend or meri-greenfield edits here.

## Published reviewed slices

| Source slice | Draft PR | Immutable published source/evidence pin | Exact tree | Qualification |
| --- | --- | --- | --- | --- |
| Saved newsletter revision staging | [2401](https://github.com/neo-capiro/capirov2/pull/2401) | `3c20f798c731403ffe2bbb6fa75dcb1bbf80bb16` | `188d94ee4cda563a6543468544fd7d1f9885b3f8` | 40 independent adversarial cases; Core/Workspace strict typing and Nest builds |
| Objective-bound Outreach resolution | [2402](https://github.com/neo-capiro/capirov2/pull/2402) | `4a784b58a0d41251ae6d7dea75a9b4858abc8665` | `3e04cc68d00373632d4bc86c935d37e672b2d221` | 130 combined cases after independently reviewed immutable-revision privilege repair; Core strict typing |
| Effective-date calendar | [2403](https://github.com/neo-capiro/capirov2/pull/2403) | `35abc148e301b5b0b0baa4f5b284757079d9d91d` | `38c8529eb308631922bee8d1c3f4d920bc4a0bf3` | 181 combined cases, including 109 independent after reviewed checkpoint correction; Core/script strict typing; original API Nest/WASM pass |
| Objective-bound Strategy/Planner resolution | [2404](https://github.com/neo-capiro/capirov2/pull/2404) | `0716767e8b6ff323b2516d166b22edb4d2413e57` | `207657e1ae89de5790816e07b5fa149512381955` | 50 independent / 109 combined cases; full Core/Strategy typing and Nest builds |
| Objective-bound saved Workspace revision | [2405](https://github.com/neo-capiro/capirov2/pull/2405) | `c05b85a29a75cbaaa8538fd7f9a97e298a23913e` | `cb0a9d47c0328e2d9b31e9b2e47dbcc08517bf5e` | 82 independent / 133 combined cases; 90 focused author regressions; full Workspace typing, Nest and shared builds |

Calendar's immutable corrected runtime/source pin above is reachable from the
updated PR2403 publication; its later test/evidence/docs head is recorded in the PR
and completion receipt. The original publication `f5a043c2558c1073b46bbeab81e60c403830d299`
(tree `73dfb7fa3857e3fc23a3de0a7d410859c5498350`) remains preserved. The reviewed
checkpoint correction uses only complete protocol-success receipts; original skipped-tail
RED proof and all prior and 181-case evidence remain published.

The original Outreach publication `30fa58467238542ff2b98137844ea02a3225e545`
(tree `32142bbbc0ba12d7f973520c626d4a8167f612d8`) remains an ancestor. Cross-contract
review found its immutable revision locking SELECT conflicted with the preserved
SELECT/INSERT-only revision contract. The corrected head reads that immutable
revision without a row lock while retaining the mutable Objective/current-authority
locks. No grant or schema expansion occurred. Initial accepted tests, original RED
privilege proof, incomplete repair attempt and reviewed GREEN receipts are retained.
The privilege rule is defined by the
[PostgreSQL SELECT contract](https://www.postgresql.org/docs/16/sql-select.html).

Each corrected candidate's final runtime source matches its independently accepted
runtime blobs; later publication additions are tests/docs/evidence. Their original
published heads remain ancestors. Counts overlap author/regression runs and
must not be added into a misleading overall total. Failed and passing receipts are
preserved under the per-slice docs directories, with exact SHA-256 manifests.

## Canonical contract boundaries

Newsletter staging uses the exact authorized `WsDocVersion`, complete canonical
snapshot hash, current source ACL/member/client wall, selected existing Outreach
session and `expectedStateVersion`. It applies one existing SET_CONTENT_SKELETON
command and atomically records an existing command-batch receipt. Exact retries
recheck both current owners and recover the original receipt without restaging.
Changed hashes/identities/expected versions conflict. It creates no new session,
message artifact, target, sender, attachment, generation or send intent.

Current saved/current canonical config.clientId declarations must agree and pass
the current client's authority; a declaration never grants access. Legacy display
labels, prospect drafts and every immutable Intel source origin are refused.
The Workspace version immutability migration is source only. Core's shared-DB
Workspace read seam and exact native role privileges require coordinated release
qualification; no permission grants are authored or executed.

Every Objective destination is a bounded observation returned by the canonical
resource owner, with literal kind, actual resource ID, exact current Objective
version and immutable revision ID, and freshly checked same-client authority.
Existing Objective PR2362 remains the persistence owner. Reused responses are not
capabilities; UI consumers must call the relevant owner resolver on every open.
No generic link, second Objective store, creation/association or historical revision
upgrade is implied. Outreach requires its caller-owned active session and exactly
one client sponsor equal to the Objective client. Current member, client wall and
Objective revision locks are source-reviewed; native concurrency remains unrun.

| Bounded destination kind | Canonical read owner | Current authority required |
| --- | --- | --- |
| `outreach_session` | Outreach session service, PR2402 / shared delegation in PR2404 | Exact caller-owned active session; one current client sponsor; current Objective revision and live client authority |
| `strategy` | Strategy service, PR2404 | Exact nonarchived same-client plan; current Core member/client authority and Objective revision; existing plan mutation lock |
| `planner_task` | Planner service, PR2404 | Exact nonarchived task; current task/project viewer ACL; explicit task client UUID; current Objective revision and client authority; existing tenant advisory lock |
| `workspace_saved_revision` | Workspace version service, PR2405 | Exact immutable saved version and parent draft; current source owner/collaborator ACL; matching saved/current canonical client UUID; current Objective revision and client authority; exact PR2401-eligible subset |

Every row describes a read-only observation. It does not authorize a later write,
persist an association, create a resource or substitute for another owner's
authorization. Consumers must re-resolve with the current owner on every open.

The effective-date calendar uses only current RULE publisher effective_on evidence
and canonical matching official edition references, labels date kind/provenance,
excludes unsupported/stale/unresolved corrections, and exposes coverage/freshness.
Publication/comment-end dates never substitute. The existing source owner records
changed/withdrawn dates atomically, rejects delayed observations, and authors a
historical identity refresh path. Coverage explicitly does not claim all Federal
rules, full Dates text or separately issued correction resolution. The official
PDF reference is not a claim of downloaded/interpreted PDF content.

## Dependency and overlap matrix

| Candidate | Required published source contracts | Composition intersections / gate |
| --- | --- | --- |
| Newsletter2401 | Prospect2400 `6c26ac2dad3756a61b6733329dea7ce3c9138ece` → Sender2393 `b1ac2649e134af560d41bee790cacbd61de01c9b` | Existing shared barrel, Workspace owner seam/version paths; separate Workspace immutability migration40000 |
| Outreach destination2402 | Objective2362 `72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e` + refreshed main | With2401 preserve BOTH state controller routes and route-manifest entries; Core schema includes inherited Objective persistence |
| Effective calendar2403 | Refreshed main; independent of other new slices | Core schema additions beside preserved Objective/activity/owner/prospect blocks; Cleanup2392 sync entry guard/main wrapper must survive composition; Core migration60000 |
| Strategy/Planner destination2404 | Corrected Outreach2402 `4a784b58a0d41251ae6d7dea75a9b4858abc8665` → Objective2362 | Core delegates to canonical shared helper; preserve newsletter/prospect shared exports, Planner2395/Quicklog2396 existing controller/service behavior, Cleanup2392 shared dependency/package/lockfile decisions |
| Saved Workspace destination2405 | Newsletter2401 exact `3c20f798c731403ffe2bbb6fa75dcb1bbf80bb16`; only byte-identical helper plus additive export from2404 | Versions controller/service and shared barrel intersect2401; helper and shared barrel intersect2404. Preserve both export sets, unchanged staging/source seams, existing Objective2362 tables and corrected Core delegation release prerequisites; no new migration/store |

The raw `current-published-source-matrix.json` records the five immutable candidate
pins, the freshly verified fifteen original heads, explicit actual PR bases,
implementation bases and both incremental and whole-candidate intersections.
Earlier three- and four-slice matrices and their original hash manifests remain
byte-identical snapshots; the initial publication matrix also remains preserved.
Calendar's source/evidence pin is taken before this docs-only reconciliation;
the PR metadata and completion receipt report its later publication head.
PR2401 vs2402 overlaps the Outreach state controller
and route manifest incrementally, plus Core schema through their required bases.
Calendar2403 has no incremental2401 intersection; full candidates share schema.
Textual intersections are integration evidence, not qualification of a combined
unpublished tree. No incompatible mixed-source runtime or release claim is made.

## Remaining source scope and excluded work

Strategy/Planner source is now published and independently accepted. Preserved
initial checkpoint:
`b5e61175eff7cebe28a70a79da41e12d8f584b28`, tree
`9f1885726d8f2ac02a12a3ee096b63f6330888c7`; author worktree subsequently holds
`d198733d66ea6b6b29eaafbccb6a76b6a174b239`, tree
`df1d72330029edbc0a250940a9adb98c14c8c87b`. The exact current published source
contract is PR2404 above. Its independent shared-helper reviewer and the
Newsletter/Workspace owner returned explicit usage-limit errors during the earlier resume attempt.
Neo then authorized one retry in each same session. That retry produced independent
acceptance of the exact `d198733d66ea6b6b29eaafbccb6a76b6a174b239` source:
50 independent cases and 109 combined cases across seven suites passed. The
evidence-only reviewer commit is `c42aa5a5ee9bf5f59d4ac15ff4c6f8223ef315ad`,
tree `5baa9f01441dfbd8410c29d7176114b00c68aa5d`. The scalar-input RED and launcher
failure remain retained. The actual PR2404 publication was independently verified
draft, open, unmerged and mergeable at 08:26 UTC; all accepted runtime blobs are
unchanged. Workspace may now consume only its exact helper bytes and additive
export, with explicit original Objective migration/runtime prerequisites.
No model/environment switch, replacement session or quota bypass occurred.

The saved Workspace revision destination is independently reviewed and published
as PR2405 for PR2401's strict eligible subset. Accepted implementation
`490076ab8a9a5db72eda97b0d576a81e87f81cbb`, tree
`bfb8195babb0a25863a2ccde0e050b2ebc2a9c95`, remains unchanged in the publication.
Its six changed source/test blobs and two existing published helper identities
were independently verified. The helper Git blob is
`767a11ddff2ff43a39cdf572029b40a4976facac`, SHA-256
`a7fafdf28c55cb9af93b2faf5fbb4b824023622cc68b08501e0d367dcf4a5443`, exactly PR2404;
the saved-revision seam is exactly PR2401. Independent evidence commit
`3d176c130fde76fa31db233d42518866bbb22bdf`, tree
`95097f7e74ba5be5932946e6b4a4e228f2399a64`, records 82 independent / 133 combined
cases, including confirmed authority-change await gaps and fourteen infrastructure
error phases. Author checks pass 90 focused regressions, shared/full Workspace
typing and production Nest build; overlapping counts are not summed. All raw
setup failures and passing receipts remain published. No source blocker remains
for these bounded observations. General free-text-only drafts are not made
authoritative. Existing worktrees, authored source/check receipts and all
published candidates remain preserved; no loss is inferred from executor/model
status. The executor itself recovered and was directly verified usable at
2026-10-12T07:44:47Z, 07:53:43 UTC, 08:20:52 UTC and 08:59:19 UTC. All fifteen
original heads were freshly verified unchanged, draft and unmerged at 08:43 UTC.
The PR2405 API and remote branch confirm its exact draft/open/unmerged head;
live main remained unchanged at 08:59:19 UTC. All authorized same-session retries
succeeded without model/environment changes; no usage-limit blocker remains here.
General Workspace drafts lacking canonical current/saved client declarations,
durable Objective-bound creation/associations, and comprehensive legal date/correction
interpretation remain outside these bounded source contracts. Missing scope is
refused, never widened or filled by labels/publication/comment dates.

The separately owned EngagementService reporting task
`task01a12dc9-21a3-7062-908e-b6fabc37c027` is untouched. Its reviewed unpublished
source remains owned there; this work neither duplicates it nor presumes it lost.
The original ledger's commitment party question is superseded by Neo's explicit
exclusion. No Commitment / We owe / They owe / counterparty UI or abandoned party
semantics is implemented, and no such dead scaffolding is introduced. Existing
shared activity/task/Planner functionality and all original candidates are retained.

## Known native concurrency scenario

Existing `ClientsService.setMemoryAccess` removes grant rows before updating the
client wall, while the new bounded readers lock client then grant. A simultaneous
wall toggle plus grant removal can therefore form a client/grant deadlock. The
transaction abort fails closed and infrastructure errors remain visible; it is no
access grant or authorization bypass. This inherited writer ordering is a concrete
native qualification/availability gate, not a promise that synthetic tests proved
lock compatibility. No unrelated wall writer or permission configuration was changed.
Qualify this exact interleaving and permitted retry behavior before release.

## Source-only release boundary

Native Prisma downloads remain blocked at ordinary HTTPS CONNECT to
binaries.prisma.sh; there is no bypass, alternate host or checksum disabling.
WASM/synthetic/type/build checks are not native PostgreSQL/RLS/constraint/permission/
MVCC/concurrency acceptance. No real messages/uploads/provider sync, paid models,
customer mutations, credentials/permissions, AWS, security/network changes,
database/migration execution, main merge or deployment occurred.

Dot owns authorized native qualification and coordinated release preparation.
Use the exact published dependency heads and merged schema/module/export/route
matrix; preserve all raw failed/pass evidence and Cleanup's exact-source gate.
