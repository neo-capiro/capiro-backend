# Remaining contracts against existing resources

Source review at main `4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace`, plus the
preserved candidates in `LEDGER.md`. These are bounded proposals and decision
holds, not implemented endpoints or accepted audit rows. No migration has been
allocated, authored, or run by this task.

## Quick log: one durable command and receipt

Existing owners:

- Core `clients/client-activity.service.ts#create` owns activity. It validates
  recordable kinds, occurred-at instants, non-archived tenant clients and same-client
  `ClientPerson`; commitment/request can have `dueAt`. It lacks structured direction,
  objective/task lineage and a command receipt.
- Core `EngagementService#createTask` owns `EngagementTask` with tenant/client/meeting/
  contact/thread, a Core user UUID owner, SQL DATE `dueDate`, and a partial unique
  `(tenant_id, source_type, source_id)` index. Its internal transaction/source hook
  already exists. This is suitable for an Engagement follow-up, not a replacement
  for the Planner task service.
- Strategy `planner.service.ts#saveTask` owns Planner tasks, project memberships,
  visibility and optimistic versions. `planner.validation.ts` already distinguishes
  calendar `dueOn` from optional `dueTime` plus IANA `timeZone`. Assignees use Clerk
  subjects. Its task-import receipt is an existing specialized idempotent mechanism;
  do not misuse CSV import or map a Core UUID to a Clerk subject by string equality.

Proposed command owner: a cohesive Core activity-command module invokes the chosen
existing task owner through a typed boundary. Input carries a UUID request key,
commitment direction, bounded same-client counterparty reference, objective/version
and optional strategy-step reference, with separately validated follow-up assignee
and due value. Tenant, actor and effective client access are bound/rechecked on the
server; free JSON metadata and caller-provided sourceType/sourceId confer no authority.

Persist a normalized request hash and receipt under tenant/actor/client/request key.
Same key + same content returns the existing receipt; different content conflicts.
Receipt includes command ID/version, activity ID, task owner/type/ID (if created),
exact lineage and `completed | activity_saved_task_pending | needs_attention` state.
A read-only command lookup must recover a lost response without another create.

If Engagement is chosen, use its existing transaction hook and unique lineage to
commit activity/task/receipt together after both owners' authorization checks. If
Planner is chosen, use a durable local receipt/outbox and an idempotent Planner
command keyed by that command ID; cross-service work is a recoverable sequence,
not an atomic pair of frontend POSTs. Resume only the unfinished step after fresh
authorization; never recreate the activity or duplicate a task after an unknown
remote result. Automatic notifications are not part of this command.

**Material decisions:** Which task audience is intended by this Figma flow—an
Engagement follow-up or a project-visible Planner task? Recommendation for the
Planner-facing workflow is Planner ownership, with Core retaining activity and
receipt. Who owes whom, whether Directory offices may be counterparties, and which
objective/strategy-step relations are writable need approved domain rules. Preserve
a date-only deadline as `YYYY-MM-DD`; never coerce it to implicit UTC/browser midnight.
A true timed deadline requires an explicit IANA zone and time. Overdue cutoffs,
reminder times and timezone changes are product choices, not inferred instants.

Acceptance must cover partial failure at every persisted boundary, concurrent key
replay, changed-payload conflict, loss of client/assignee access, tenant/client and
identity-space mismatch, DST, date-only round trips, and exact activity/task read-back.

## Prospect Files / Workspace: explicit parent, preserved provenance

Extend Engagement's existing attachment lifecycle rather than creating a second file
service. `EngagementAttachment` currently has client/meeting/mail parents; retain
its uploader/viewer predicate, scan/readiness policy, current-version checks, content
integrity, storage key ownership and signed URL policy. An optional `prospectId`
needs a tenant/prospect composite relation and index. Validate the same canonical
BD prospect at presign, confirm, list and read; an existing upload receipt cannot
be rebound by changing parent IDs during confirm replay.

Workspace `WsDraft` has tenant and Clerk owner; its `client` is free text, not an
authority key. `WsDocVersion` has a tenant/draft/version ID and saved snapshot. Bind
an accessible draft/version to the canonical tenant/prospect through a deliberate
Workspace contract; do not list by matching titles or client names. Existing draft
collaborator/editor rights remain authoritative. A Core actor UUID is not a Workspace
owner identity. Any cross-service read must use an approved verified principal
translation and exact tenant/prospect relationship.

Proposed conversion rule: retain immutable prospect origin and exact attachment or
draft/version identity; add a separately authorized client association on conversion,
without copying bytes, changing upload authorship or broadening viewer permissions.
Conversion and association update must be idempotent and recoverable. If the client
has stricter access, the stricter authorized read applies. Do not confuse a prospect
UUID with its later client UUID. Archived/converted records may retain read history;
writes require the lifecycle policy to be decided explicitly.

**Material decisions:** May a converted record retain both parents, and who can see
historic prospect content once client walls apply? Does conversion attach every
accessible draft/file or only an explicit reviewed selection? Who owns recovery
across Core/Workspace? Prospect contacts PR2371's carry-over is a related separate
contract. Allocate migration identities centrally only after these decisions, with
composite FKs, RLS, grants, indexes and rollback review. Do not run migrations here.

## Ordered Primary–Quaternary owners

Existing single-owner owner is `ClientAccountOwnerService`, storing nullable
`clients.account_owner_user_id`. `ClientTeamService` preserves general membership
and free-text roles, emitting the owner once and retaining an explicit team role.
It does not encode rank. Keep that meaning and the batch primary-owner filter.

Proposed representation: tenant/client-scoped versioned ordered list of zero to
four distinct active tenant member UUIDs, contiguous positions; zero retains the
existing unassigned-client state. Backfill the current single owner as rank 1.
Every replacement locks/versions the same client aggregate and atomically writes
all ranks, primary projection, version and audit receipt. Reject duplicate IDs,
gaps, more than four, inactive/nonmember/foreign identities before any write.
Non-admin writes remain forbidden; inaccessible client references are non-disclosing.
A stale expectedVersion is 409 with no partial updates or silent last-writer win.

Do not repurpose `client_team_members.role`, delete team rows, or erase free-text
roles. Read composition emits each user once with rank separately from team role.
Membership deactivation does not silently promote another person or delete history;
mark the assignment unavailable and require an explicit authorized replacement.
Revalidate all assigned members and client authority during each replacement.

Proposed legacy compatibility: zero/one-owner clients keep existing single-owner
PUT semantics through the same canonical transaction and increment the same version.
For multi-owner clients, a no-op legacy PUT may return the current primary; a change
must return a typed conflict requiring ranked replacement. This avoids silently
erasing secondary owners or inventing reorder behavior without a version input.

**Material decisions:** Approve that multi-owner legacy conflict policy versus a
specified primary-only swap policy; decide display/retention for inactive assigned
members. Allocation and native contention/RLS qualification are required before any
schema source. Test rank replacement versus legacy PUT versus deactivation writers;
a service-only read/recheck is not a shared write fence.

## Objective navigation

Reuse PR2362 `72bfea4c5f574c2d9dba63c6bbc63dac1c7e377e` unchanged: versioned drafts,
revisions, idempotent create, readiness and canonical client walls already exist.
Add bounded persisted destination references only after destination contracts agree:
`strategy` (strategy ID and objective revision), `planner_project` / `planner_task`,
`engagement_plan`, `directory_target` with exact supported kind/ID, and context file
with attachment or Workspace draft/version ID. No arbitrary URL or generic link is
an objective-bound relation. The destination owner validates existence, tenant/client
association and current caller access on creation and navigation; the objective
owner validates its client wall and expected version. Missing/deleted/inaccessible
references return an unavailable destination without exposing foreign metadata.

**Material decisions:** Which destination models actually persist objective lineage?
Should Files/Calendar offer a clearly labeled client view, or an objective-filtered
view requiring new associations? Navigation must not generate, approve or activate
Strategy/Meri work; generic URLs cannot imply an approval workflow.

## Newsletter to Outreach

Workspace `WsDocVersion.snapshot` is the exact saved source, identified by tenant,
draft ID and version ID; mutable current draft content is insufficient. Existing
Outreach V3 state controller commands require `batchId` and `expectedStateVersion`;
`OutreachCommandEngineService` owns version/hash checks and context reauthorization.
Reuse these commands and exact authorized context references for a staging bridge.

Proposed bridge receipt binds request key, source draft/version/content hash,
source author provenance, destination session and resulting state version. Validate
source read permission and target session/client/sponsor authority at execution and
replay. Same key/content replays the stored receipt; changed content conflicts.
A newer newsletter save requires a new explicit staging decision. Incomplete bridge
work must reconcile by receipt; no hidden regeneration, send intent, recipient
activation or provider send. Never trust browser-submitted newsletter HTML as proof
of a saved revision.

**Material decisions:** Define section-to-Outreach content mapping and whether the
bridge creates a session or stages into an explicitly selected session. Confirm
cross-service identity/read authority and destination context kind. No generation
or send enablement is included.

## Effective-date calendar and Engagement aggregates

Core `FederalRegisterService#getUpcomingDeadlines` filters `commentEndDate` for the
next 30 days, capped at 50. Intelligence `rule-source-data.repository.ts` selects
publication/comment dates. Other Intelligence alert-packet/dossier structures can
carry effective dates, but their presence is not a complete dated calendar feed.
A dated item needs source document ID/revision/URL, explicit date kind, date-only
versus instant/zone, verification/as-of, and correction/retraction lineage. Unknown
effective dates stay absent. Do not synthesize effective dates from publication or
comment-close dates. The source owner must define coverage, range and pagination
before the calendar claims complete effective-date coverage.

Existing `EngagementService#reportOverview` reads target offices, caller-owned
meetings and mail, plus tasks; meetings are capped at 2,000. Tenant target data plus
caller-owned communications does not establish a team-wide or DC-wide audience.
Before extending it, define self/team/client audience, membership and client-wall
rules, independent source pagination/caps, as-of/watermarks, partial/failed source
status and denominator semantics. Missing or clipped sources yield explicit
incompleteness; they are not zero activity or complete plan coverage. Avoid building
another overview endpoint until the audience/product definition is agreed.
