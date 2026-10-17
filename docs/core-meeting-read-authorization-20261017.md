# Core Meri meeting read authorization

This source-only correction starts from Core PR #68 head
`8d6733c38044cc45ceae60acdd09a2d837ccc197`. PR #68 and the published
first-chat PR #81 are separate branches; this change does not rewrite PR #81.
The separately cited local Fable Meri commit `6236873197` was unavailable
from published PR #121 during this check, so its unpublished bytes are not
asserted here.

`searchResearchSources` previously spread the local meeting ownership `OR`
and then assigned a text-search `OR` to the same Prisma object. The latter
replaced ownership. The query now intersects ownership and text search,
alongside its tenant and optional client filters. `listUpcomingMeetings`
retains its tenant, owner, optional client and time filters. Both reads exclude
canonical `cancelled`, `canceled` and `deleted` statuses in Prisma.

`Meeting.status` is an unconstrained string, and the meeting update API can
persist mixed-case or padded values. Both reads therefore filter normalized
inactive statuses before returning results. Stable `startsAt` plus unique `id`
cursor paging fills the requested result limit after filtering. The helper
scans at most 250 rows and returns a service-unavailable error if that bound
cannot establish a complete page; it does not claim there are no meetings.
The upcoming read selects attendees during this bounded scan, so live latency
still needs qualification.

The focused test covers same-tenant nonowner, connection owner, tenant/client,
text and time bounds; canonical, mixed-case and padded inactive statuses;
limit-one cursor paging with an inactive row before an active row; and a
251-row cap exhaustion that returns 503. Its in-memory Prisma query model
honors ordering, `take`, cursor and `skip`. Focused Jest passed 5/5 with
open-handle detection. It does not exercise a database or provider.

A scoped imported-graph TypeScript run produced no diagnostics in either
changed source file, but exited nonzero on 18 `S3Client`/`BedrockRuntimeClient`
`.send` diagnostics in unchanged client, directory, embedding and Engagement
files. This is not recorded as a TypeScript pass. The task used an existing
read-only dependency installation from PR #81. The two lockfiles differ only
by PR #68's direct shared-package development dependency on `@types/node`;
their runtime package resolutions are otherwise identical. No install or
generated client operation ran. No migrations, credentials, auth middleware,
public route, frontend, Meri runtime or AWS state changed.

## Follow-on read boundaries

- `ownMeetingWhere` in this service lacks the deleted-row filter present in
  the Engagement helper. Exact-ID meeting brief and ownership helpers need
  separate caller and currentness tests before changing that shared local
  predicate.
- `ensureClientVisible` in this service and the corresponding Meri service
  helper resolve a tenant-owned nonarchived client but do not test the client
  memory wall. `readClientMeetings` has a stronger current association/wall
  check. Research-source search runs client descriptions and other content
  queries before such a wall check, including with no `clientId` supplied.
  An unscoped read of an associated client must not route around that wall.
- Research-source search still includes tenantwide directory contact notes
  even with a client filter; those notes have no client association. Mail
  ownership predicates remain separate from this meeting correction.
- `queryOutreach` computes a campaign list total before slicing, and its
  detail path can load nested meeting, prep, debrief and client data before a
  client-wall check. The Engagement outreach context library also aggregates
  tenantwide client notes and meeting-derived content. Clientless campaign
  visibility needs an explicit product decision before tightening list policy.
- BizDev dossier evidence can still invoke live SAM while its Meri caller
  requests suppressed JEV. Its facility footprint lookup selects a same-tenant
  client without archive or memory-wall checks. These are separate provider
  and client-resource gates to resolve before qualifying that read.
