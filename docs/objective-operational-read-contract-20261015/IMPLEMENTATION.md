# Bounded NON-MERI application candidate

This candidate implements explicit human Objective associations and current authorized
metadata reads. The reviewed wire remains the schema sealed at `6ce5cacd`; its source
pins describe that proposal's historical inputs. This document describes the application
increment, not deployment or migration execution.

## Routes and receiving

- GET `clients/:clientId/objectives/operational` requires `schemaVersion=1`,
  `objectiveId`, and `limit` (1–100). Optional flat query names are `strategiesCursor`,
  `projectsCursor`, `decisionsCursor`, `engagementsCursor`. Omit null cursors.
- POST `clients/:clientId/objectives/operational-associations` accepts the exact closed
  human link/unlink command. GET `operational-associations/:requestId` requires
  `schemaVersion=1` and `objectiveId` for actor-scoped receipt recovery.
- All successful routes return HTTP 200 with `Cache-Control: private, no-store`.
  The boundary also sets this cache policy before guard/parser refusal. Unsupported
  tenant impersonation is refused consistently with Planner. Current member, client,
  memory wall and Objective authority is rechecked inside every transaction.
- No request echo is added to `ReadResponse`. Receivers retain the decoded request and
  accumulated page context. `projectionDigest` represents equality, never progress order.
- Actions currently emitted: `edit_objective`, authorized ordinary `open_resource`
  with `contentView: current`, and `review_planner_approval` for an actual current
  pending approval task. No action confers mutation permission in an owner application.

Manual associations preserve original link revision, actor/time, immutable resource
identity and human cycle annotations. No current-version pin is invented: manual Strategy
rows have `savedVersions: []`. No generated-current or frozen-content action is emitted.
Existing strict generated receivers and application receipts remain unchanged.

## Persistence and transaction order

Source migration `20281015030000_client_objective_operational_links` adds only three
Objective tables. Engagement reserved the distinct `20281015040000_engagement_plans` on
its own branch. Neither migration was executed on a live database.

1. A short replay lookup resolves the actual current Objective revision and current
   actor authority, then reads this actor/request's immutable receipt. Matching payload
   returns the historical result before applying present CAS. Changed payload conflicts.
2. A new link transaction acquires the resource owner's mutation gate before Core locks.
   Planner uses the existing tenant advisory gate then its selected parent SHARE lock;
   Strategy uses its parent SHARE lock. Outreach holds its owner session UPDATE lock.
   Meeting links lock the current connection SHARE first, verify its identity while
   locking the meeting UPDATE, then lock current client people and meeting attendees
   SHARE in ID order. Optional cycle context parent locks follow in sorted identity order.
3. The existing Core authority helper holds current tenant/member/user/client/wall and
   Objective SHARE locks. The scoped association advisory gate is then exclusive, followed
   by the state row UPDATE lock. The receipt is rechecked after serialization, before
   submitted Objective/set CAS. A link must pass final owner/client checks under its gates.
4. One link insert or unlink tombstone, one set increment when changed, and one exact
   receipt commit together. No-op commands still append a receipt without incrementing
   the set. Any source error, row-count mismatch or receipt failure rolls back the whole
   transaction. Unlink does not mutate/delete the source resource. Re-link gets a new ID.

Meeting final validation accepts only the people/attendee IDs locked by its gate; later
inserts cannot become new unfenced eligibility witnesses. Connection ownership, meeting
fields and existing positive contact/attendee witnesses remain locked through commit.
Current client primary email is protected by the Core client SHARE lock. A changed
connection/gate is unavailable and rolls back; the application does not guess eligibility.

Reads hold current Core authority and a shared scoped association gate to observe a
consistent membership/set version. They acquire no owner mutation or row locks afterward.
Planner reads selected metadata, candidate tasks and referenced project grants in one
SQL statement; Outreach reads current spec and pending-presence in one statement. These
are owner-local observations, not a cross-service atomic snapshot. Strategy preserves its
strict current tenant rollout flag; ordinary Planner remains independent of that flag.

Transactions have a 15-second application timeout, 12-second statement timeout and
3-second lock timeout. There are no HTTP/model/provider calls inside them. There is no
automatic retry that could mint a different command identity. The same request can be
retried or reconciled by its exact receipt locator.

## Coverage and operational limits

- All explicit associations are considered. Page size is a transport page bound, not a
  project/task cap. Current readable nonarchived tasks deduplicate by ID across project
  memberships; human edits are read as current content. Approval decisions require the
  canonical approval subtype, pending state and unfinished task. Overdue uses the same
  pure scheduling implementation as Planner, with compatibility parity tests.
- Missing/denied/unverifiable source metadata is withheld. Affected totals and Planner
  counts are null; no hidden ID/title/provenance/count is supplied. A verified empty
  implemented set remains complete with zero. Unknown future-meeting coverage withholds
  a putative next engagement rather than asserting an unproved global minimum.
- Untitled Outreach proposals cannot satisfy the reviewed decision shape. Their presence
  makes decisions incomplete; IDs and fabricated titles are not returned. The existing
  Outreach feature flag, owner, sponsor, archive and exact state-version rules remain.
- Questions and automation remain explicitly `not_implemented`. There are no invented
  feasibility/window classifications, decision lifecycle, generated applied pointer,
  background execution, automatic activation, or changes to Objective readiness/status.
- Optional budget context references require their current owner access. Unavailable
  context withholds that immutable Strategy annotation row rather than rewriting its
  historical annotation. Internal lifecycle access preserves the configured tenant ID
  or current database slug policy of its owner.
- Cursors are HMAC protected and bind tenant, actor, Objective/current revision, set
  version, section, full owner witness, page size, offset and fixed as-of cutoff.
  Mixed cutoffs, drift or tampering return 409. The key is process-local: restart or
  another instance requires restarting pagination. No deployment-wide key is introduced.
- An oversized or slow uncapped owner union fails safely; it is never silently truncated.
  Further query batching and multi-instance cursor continuity are separate improvements.

## Qualification boundary

Focused parser, projection, orchestration, HTTP, owner ACL/schedule and isolated PGlite
checks accompany the candidate. PGlite uses synthetic typed table subsets and explicit
synthetic role/default privileges. It is not proof of native PostgreSQL/RLS inheritance,
real role grants, connection pools, or concurrent lock behavior. Native concurrent
link/unlink/replay, related-owner mutations, expiry/authority races and actual runtime
role privileges remain an integration gate. No cloud run, live SQL, deployment, merge,
Meri runtime, dispatcher or canonical applied publisher is part of this increment.

The local validation checkpoint has 309 passing non-SQL tests across eight suites
(including 12 synthetic HTTP cases and 56 existing Planner regressions), plus 22 passing
isolated SQL cases. Focused semantic TypeScript and isolated Shared TypeScript checks
exit zero. These use existing local installed dependencies on Node 24.19.0; no package or
lockfile was changed. Full Core/Strategy application and target Linux/native qualification
are not claimed. PGlite's naive Strategy timestamp conversion is compared with its own
independent raw SQL result, not assumed to prove the native Prisma driver's conversion.
