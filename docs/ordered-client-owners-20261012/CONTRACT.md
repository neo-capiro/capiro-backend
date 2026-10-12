# Ordered client ownership source contract

Main-based isolated candidate; no dependency on PR2393–2397 at runtime. Migration
source20281012020000 follows reserved Objective20281011010000 and QuickLog20281012010000.
No migration has been run, even against an ephemeral database.

`GET /api/clients/:clientId/account-owners` returns
`{tenantId,clientId,version,owners:[{userId,rank,label,available,person}]}`.
Ranks are contiguous1–4, labeled Primary/Secondary/Tertiary/Quaternary. `person`
is `{id,email,firstName,lastName}` for an active tenant member or null when
unavailable. An inactive/departed owner retains their UUID and position; no
automatic promotion. The empty list means unassigned.

`PUT` on that same route accepts only `{expectedVersion,userIds}`; UUID array
order defines ranks, with zero to four distinct active tenant members. UUIDs
normalize to lowercase. Expected version is an integer0–2147483646. Both verbs
return200. Unknown fields, duplicate/malformed IDs and inactive/foreign requested
members return400. Missing/archived/walled client returns nondisclosing404.
No current active actor, wrong identity or insufficient role returns403. GET
requires standard_user or higher, PUT user_admin or higher. Current DB membership
is rechecked; a stale middleware role cannot grant a replacement.

The client row lock serializes read, ranked replacement, legacy owner write and
team operations. After acquiring it, the service rechecks and share-locks actor
membership/identity and existing wall grant before later membership waits.
Requested owner memberships are share-locked through commit. Owning a client
does not grant ethical-wall access; even an administrator needs an existing grant
to read/edit a walled client's owners. No membership/team/wall change follows an
owner assignment. Existing list/options read APIs recheck active actor; the batch
owner filter omits currently denied clients and remains a Primary-only filter.

Replacement writes rows, Primary compatibility column, version and audit in one
transaction. Any failure rolls back all of them. `owner_version_changed`409
requires read-back and a fresh deliberate save. Exact current-version no-op keeps
the version; stale same-payload retry still conflicts. There is no request-ID
command ledger for this replacement API. On an uncertain PUT result, GET and
compare the complete persisted order/version before deciding whether to save
again; do not retry using a guessed increment.

Legacy GET/PUT `/api/client-account-owners/:clientId` retains its wire shape.
Zero/one-owner writes use the same canonical transaction and increment version
only when changed. With multiple owners, the same Primary is a no-op (including
an inactive historical Primary); changing/clearing Primary returns409
`ordered_owners_required`. The legacy editor cannot erase Secondary–Quaternary.
Version exhaustion yields409`owner_version_exhausted`, with no mutation.

`GET /api/clients/:clientId/team` merges all owners and general team members once
per user. It adds `ownerRank:number|null` and `ownerAvailable:boolean|null`;
`isOwner` keeps its legacy meaning of Primary only. Owners come first in rank
order, others retain alphabetical order. Free-text team roles are preserved,
including when a user is also an owner. Team removal refuses every ranked owner;
remove ownership explicitly first. General team roles/rows are not rewritten by
rank replacement.

The additive SQL prepares a tenant/client composite FK, unique ranks/members,
rank bounds, FORCE tenant RLS with WITH CHECK, and deferred checks for contiguous
ranks and Primary agreement. Existing nullable Primary backfills to rank1/version0,
including historical inactive users. Client deletion cascades the set. User hard
deletion is restricted while assigned; existing soft deactivation preserves
historical ranks. This deliberate behavior avoids incidental promotion/deletion.
Backfill volume, invoker-right trigger/RLS interaction, hard-delete compatibility,
grants and native concurrency all require qualification before deployment.

Old server code cannot write only the Primary column after the new deferred
consistency guard is active; migration and canonical writer rollout must be
coordinated through dot. No SQL trigger grants authority or bypasses RLS. The
application owns version increment/audit; direct SQL owner mutation is unsupported.
No paid-plan entitlement is introduced.

Schema/user lifecycle changes and the two shared ClientsModule/schema paths need
explicit reconciliation with PR2362/PR2396; do not cherry-pick whole unrelated
candidates. Exact intersections and independent review receipts accompany the
published candidate. Synthetic tests do not qualify PostgreSQL locking or RLS.
