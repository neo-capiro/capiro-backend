# Backend dependency and ownership reconciliation

Refreshed origin heads 2026-10-12; main remains
`4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`. This ledger supersedes the earlier
remaining-contract status in PR2393 without altering that candidate. All rows
are source status; none implies deployed or database-qualified behavior.

## Published source work (all draft, unmerged)

| Candidate | Exact head | Closed source contract / dependency |
| --- | --- | --- |
| PR2393 | `b1ac2649e134af560d41bee790cacbd61de01c9b` | Exact authorized mailbox selection, minimal projection, matching provider/From/provenance, thread pin and ambiguous-outcome receipts; preserves reply2364 and attachment2381. |
| PR2394 | `5d075af9b376cd3ed67256b5c38e4a2a2130a51d` | Facility2373 reviewed semantic CAS reconciled with Cleanup script lifecycle; no migration. |
| PR2395 | `c5e41e320af4b4d841d4b3136777d712116916ed` | Existing Planner task owner gains private idempotent create-command receipt/recovery. |
| PR2396 | `e2c2c110edd986e799d47d43b0db50b24fab0201` | Core atomic activity/intent + explicit recoverable generic Planner follow-up; based on2395 and adds Planner expected-scope checks. Full commitment still open. |
| PR2397 | `4915f3fa5c938182b2624377375674654baa5337` | Requested governed-memory wording only; existing mandatory pending/admin authority unchanged. |
| PR2399 | `0783423aeaaa8b65f289d0927d605142816d8cfe` | Atomic versioned Primary–Quaternary replacement, protected legacy writes and preserved team roles. Reviewed source/tests `5f7308891e9bb3f0561804a0895b4372030c0d38`; independent107/107, Core primary TypeScript/Nest pass. Migration source only. |

Preserved original candidates: Cleanup2392 `03d85a40e390f8f52614aab20427a3a9433786bb`;
Facility2373 `6e5774a14c73ea04f0a77650a5bbd33173bcc9b3`;
Reply2364 `4b3c672574ed3738e42b1c5e1f7483e32f358095`;
Attachment2381 `171ec869ed3928c96172c8790a9aeb3b4de901ae`;
Stages2365 `fd6ed6c017ae91ab774fd34f74475a746de13b68`;
Contacts2371 `6c6f88e9e5ba077452716f3a0db0dd3bbea2963f`;
Objectives2362 `72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e`.
No branch is overwritten. Cleanup's exact-source release gate is independent.

## Remaining responsibilities and implementation boundaries

| Gap | Canonical owner / existing facilities | Source boundary and unresolved behavior |
| --- | --- | --- |
| Prospect Files | EngagementAttachment, existing scan/version/viewer/uploader ACL and S3 lifecycle; BD prospect is distinct from Client | Optional tenant+prospect FK alone is insufficient. Presign must bind prospect identity through confirm, replay and all signed/read/send/delete/supersession paths. Current presign returns a tenant-prefixed key without a durable prospect intent. Conversion retains prospect; files should retain immutable origin and require current linked-client wall rather than be copied or widened. A cohesive prospect association change must include every reader and preserve2393. No implementation claim. |
| Prospect Workspace | WsDraft, WsDocVersion and CollaboratorsService | Current free-text client is not authority. List/byId/mutation/version/export/collaboration need canonical prospect binding and access checks. Existing sourceAccess handles Intel source receipts, not BD. Retain draft/version/author identity and collaborator ACL across conversion; do not expose all tenant drafts. No second draft store. A joint Core/Workspace boundary is still needed. |
| Ordered owners | ClientAccountOwnerService plus ClientTeamService | Closed in source by PR2399: zero to four distinct active tenant members, contiguous positions, versioned atomic replacement; keep clients.account_owner_user_id as Primary compatibility projection. Preserve free-text team rows/roles. Details below. |
| Objective navigation | Preserved PR2362 versioned drafts/revisions/idempotent create and client walls | Bounded destination kind + canonical resource ID + objective revision and same-client authority must be rechecked by each destination owner. Existing generic navigation is not objective-bound creation. Do not recreate objective persistence. |
| Newsletter to Outreach | Exact WsDocVersion snapshot and existing OutreachV3 versioned commands | Require saved draft/version/hash provenance, selected authorized Outreach session and expectedStateVersion with a durable staging receipt. Never imply generation/send is enabled. Current source does not establish a saved-revision staging bridge. |
| Effective-date calendar | FederalRegisterService and rule source repository | Existing upcoming-deadline data is comment-end date (30-day/50 cap), not effective-date evidence. Add only records with authoritative effective-date provenance, date kind and coverage; publication/comment timestamps cannot substitute. Coverage/refresh and corrected-date lifecycle remain contract work. |
| Engagement aggregates | EngagementService.reportOverview | Current mixed audience: tenant target offices, caller-owned mail/meetings/tasks and a meeting cap. Define audience and bounded source completeness before exposing totals as organization/client analytics. No replacement overview service. |
| Full commitment | Core ClientActivity + PR2396 + Planner + PR2362/Directory | Date-only commitment, direction, canonical counterparty and objective/step lineage are not in current activity schema. PR2396 closes durable recovery only. Figma confirms Planner ownership and internal-only task wording. Party interpretation is the one pending product question below. |

Prospect association remains the highest-priority broader integration, but the
ordered-owner contract was implemented independently in [PR2399](https://github.com/neo-capiro/capirov2/pull/2399) without choosing new
cross-service sharing/conversion behavior. Prospect association remains open.

## Ordered-owner design implemented in PR2399

Implemented in isolated main-based branch `codex/client-ordered-owners-20261012`, separate from all preserved candidates.
Canonical ordered ownership lives beside ClientAccountOwnerService; the existing
single-owner API delegates writes into the same transaction. A thin ordered route
accepts only `{expectedVersion,userIds}`; array order expresses ranks and removes
rank-gap ambiguity. Empty is valid, matching existing unassigned clients.

Use a deliberately allocated additive migration after the reserved objective and
quick-log migrations. Preserve existing single owner as Primary with version0;
ranked replacement locks the client, validates current actor/wall and all active
tenant members, checks version, writes the entire set + Primary + audit atomically.
No membership mutation or automatic ethical-wall grant follows an assignment.
Existing owners who later become inactive remain visibly unavailable; never
promote another rank automatically. Explicit replacement must use active members.

Legacy writes with zero/one owner still work and advance the same version when
changed. With multiple owners, an exact Primary no-op is safe; a different Primary
or clear returns a typed conflict directing the caller to the ordered route. This
prevents a versionless old dialog from deleting additional assignments. General
team rows and free-text roles are preserved, merged once per user, and ordered
owners appear with additive rank information. Team removal cannot remove an owner.

Focused checks: four-rank reorder/clear/readback; duplicates/malformed IDs/foreign
or inactive member; archived/missing/walled client; role/actor revocation;
concurrent stale replacement; legacy multi-owner conflict/no-op; team dedup/role
preservation; migration source tenant FK/RLS/backfill and path intersections.
Independent review accepted exact source/tests `5f7308891e9bb3f0561804a0895b4372030c0d38`:107/107 tests across nine suites, including29 retained independent adversarial tests. Author97/97 across seven suites overlaps that count; primary Core TypeScript and Nest build passed. Migration SQL was not executed; native concurrency/RLS qualification remains a separate gate.

[Exact owner contract](https://github.com/neo-capiro/capirov2/blob/0783423aeaaa8b65f289d0927d605142816d8cfe/docs/ordered-client-owners-20261012/CONTRACT.md) and [qualification receipts](https://github.com/neo-capiro/capirov2/blob/0783423aeaaa8b65f289d0927d605142816d8cfe/docs/ordered-client-owners-20261012/QUALIFICATION.md) define the deliberate hard-user-delete restriction and coordinated migration/writer rollout. All47 evidence file hashes were verified against published Git blobs; post-review changes are docs/evidence only. Changed-path intersections are only schema.prisma and ClientsModule with Objective2362 and QuickLog2396; Cleanup and all other preserved candidates have no intersection.

## Commitment design evidence and smallest question

Read the published Portfolio PR6 contract reviews and current Figma metadata for
[411:42992](https://www.figma.com/design/Zc2dEN5aLU47dVdsewDmiJ/Capiro-3.0-UI-Redesign?node-id=411-42992)
on2026-10-12. The dialog explicitly shows We owe / They owe, Sen. Wicker staff as
counterparty, a calendar due date, a separate occurred-at instant, optional
objective, Planner follow-up with assignee/date and strategy-step link, and
“Internal only. Never shown to the client.” Canonical Core/Strategy schemas have
no structured owed-by/counterparty commitment model to settle the party meaning.

Pending question: does “we” mean the firm (recommended) or the selected client?
No dependent commitment fields are implemented while that question is pending.
The observed date-only field can stay a date without inventing midnight UTC;
an eventual reminder/deadline instant needs explicit timezone semantics. Directory
office/person identity must remain distinct from ClientPerson; objective/step
references require destination-owner authorization rather than free JSON.

## Qualification route independent of source completeness

The proxy rejects normal HTTPS CONNECT to `binaries.prisma.sh:443` with Envoy403
before TLS. Environment owner must authorize that ordinary egress route; then use
the existing pinned Prisma5.22 toolchain with checksums intact. No alternate host,
manual engine, proxy or checksum bypass. Native PostgreSQL/RLS/concurrency checks
also require explicit authorization for a disposable qualification database and
migration execution; no authored migration has been run, even ephemerally.

ESLint is a separate repository source-tooling gap (scripts refer to it but the
dependency/parser/config is absent). Existing synthetic tests, primary TypeScript,
Nest builds and official WASM/no-engine schema generation are source evidence,
not native runtime qualification. Deployment preparation goes through dot.

Frontend-owned auth/client context and Intel receipt validation remain frontend
work. Intel already normalizes/rejects targeting; HQ impersonation already has
audited one-hour sessions. Meri preferences belong to the new Meri owner.
