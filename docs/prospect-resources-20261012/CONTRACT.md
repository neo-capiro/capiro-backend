# Canonical prospect Files and Workspace contract

Source candidate based on PR2393 `b1ac2649e134af560d41bee790cacbd61de01c9b`.
This is an additive backend contract. No frontend, database, provider, deployment
or generation activation was performed. Two reviewed migration sources and a
coordinated Core/Workspace release are prerequisites for use.

## Canonical authority and conversion

Core `BusinessDevelopmentProspect` remains the identity/lifecycle owner. Resources
store the exact tenant/prospect UUID as immutable creation origin. There is no
free-text matching, backfill, copy to a client library, or post-create reparenting.
Conversion preserves that origin and consults the prospect's current linked
client on every authorized operation. Removal of the prospect fails closed.

The shared prospect scope composes with existing resource permissions:

1. Current active tenant, actual boolean `businessDevelopment.enabled`, and a
   current active Core tenant membership with the existing BD role floor
   (`standard_user`, `user_admin`, `capiro_admin`). Assigned prospect owner is not
   a private access list. Workspace resolves the authenticated Clerk subject to
   Core UUID through the current tenant membership; Clerk IDs are never cast to UUID.
2. If converted, the current linked client must exist in the same tenant and the
   existing canonical `clientMemoryAllowed` wall must allow the current actor.
   Administrators, uploaders and draft owners do not bypass the wall.
3. Existing attachment viewer/current-version/scan/lifecycle checks or Workspace
   owner/collaborator role policy still apply. Prospect scope grants no implicit
   collaborator or outbound distribution rights.

New content and edits require an active, undismissed prospect and a linked client
that is not archived. Existing history may be read, exported, or deleted by an
otherwise authorized actor after archival/dismissal. Current membership, feature
flag and client wall still apply. Internal pending invitations can be accepted or
declined only by the addressed currently eligible actor; existing role rights
remain enforced and archived content remains unwritable.

Writes compose authorization and the mutation in one database transaction. The
source locks prospect conversion, tenant settings, current membership/user, client
wall and the actual wall grant, then the resource/collaborator row. Native PostgreSQL
RLS, lock ordering and concurrent revocation qualification has NOT been run.

## Files: existing Engagement attachment routes

`POST /api/engagement/attachments/upload-url` accepts the existing metadata plus:

```json
{
  "prospectId": "<canonical UUID>",
  "requestId": "<stable request UUID>",
  "fileName": "memo.pdf",
  "contentType": "application/pdf",
  "contentLength": 12345,
  "checksumSha256": "<64 lowercase hex characters>"
}
```

For a prospect upload, all legacy parents (`clientId`, `meetingId`,
`mailMessageId`) must be absent. The durable upload intent is committed before
presigning and binds tenant, actor, prospect, exact metadata, digest, bucket/key
and expiry. Response preserves `url`, `fields`, `s3Key` and adds `uploadIntentId`,
`requestId`, `expiresAt`. The form must submit the returned fields unchanged.
The signed policy binds the exact key, content type, length and SHA-256 checksum;
S3 POST checksum field semantics follow the
[AWS POST Object contract](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/RESTObjectPOST.html).
No real upload was used in qualification.

UUID letter case is normalized for request/prospect identity.
Reusing the request UUID with identical pending input returns the same key within
its original five-minute expiry. Changed input returns 409
`prospect_upload_request_conflict`; expired pending intent returns
`prospect_upload_expired`; an already confirmed intent returns
`prospect_upload_already_confirmed` with the original attachment ID. Use the
original confirm request to recover its receipt, not a fresh upload intent.

`POST /api/engagement/attachments/confirm` requires the same prospect, key, filename,
content type and checksum. `source` must be absent or `manual`. It rejects a reserved
prospect key without its canonical prospect, a foreign actor, changed metadata or
changed bytes before creating an attachment. Existing scanner/readiness and stored
server digest remain authoritative. Scope is checked before external reads and
again in the final attachment/receipt transaction. Attachment creation and recording
its ID in the intent commit together. Exact retries return that same row without
another provider read; deleted, superseded or deletion-in-progress receipts return
409 `prospect_upload_consumed` and cannot resurrect the object.

`GET /api/engagement/attachments?prospectId=<UUID>` is the canonical Files list.
It retains existing uploader display, readiness/blocked-reason, preview/download
URLs, viewer ACL and current-version filters. General unlinked/client/mail/meeting
lists exclude prospect resources. Recheck current scope before returning newly
signed URLs. URLs are existing five-minute bearer capabilities: revocation prevents
new issuance; it does not invalidate already-issued S3 URLs immediately.

The existing delete route and supersession service path retain S3 deletion
retry/lifecycle semantics. No new supersession HTTP route is introduced.
A replacement must have the same immutable prospect origin and be currently usable
and authorized. Failed deletion retains the row and consumed upload receipt.
The intent survives final attachment deletion. The attachment uploader field can be cleared by existing user erasure while the
intent retains its original actor UUID; reassignment is forbidden. No receipt
cleanup that permits key replay is introduced. Orphaned presigned objects retain the existing storage cleanup
ownership; this candidate does not create a new storage-retention service.

Prospect files are excluded from outbound sends, client KB, extraction/context
imports, Outreach evidence/send manifests and unrelated client deliverables. These
paths fail closed; they do not copy bytes or infer client authority from conversion.
A future explicit distribution contract is required to enable them.

## Workspace: existing drafts and subordinate resources

`POST /workspace-api/drafts` accepts optional canonical `prospectId` and, when
present, requires stable `requestId`. Existing `industry`, `product`, free-text
`client`, and `docTitle` seed fields retain their meaning. Creation commits the
canonical draft, primary document and immutable create receipt together. The
receipt is keyed by tenant, authenticated Clerk owner and request UUID and binds
the normalized seed fields. Exact retry returns the same draft/documents under current read scope, including
authorized archival history; new creation still requires write scope. Changed
input is 409 `prospect_draft_request_conflict`; deleted original is 409
`prospect_draft_consumed`. A receipt cannot recreate a deleted draft.

`GET /workspace-api/drafts?prospectId=<UUID>` filters the existing owner/shared list
by the exact canonical origin. The slim projection adds `prospectId` and the latest
saved version's ID/creation time, without returning full config. General Workspace
lists may include only prospect drafts that pass the same current scope and ACL.
`client` is display metadata and never an authorization predicate.

Draft ID reads/edits/deletes/anonymize, document tabs, comments, local context items,
versions, checks, edit locks and exports all apply the current prospect restriction.
Current owner/collaborator role is checked within the resource transaction, not just
at the route. Version restoration uses the existing whitelist and cannot rewrite
prospect origin. Export rechecks current access after rendering and before returning
bytes. A revoked pending editor does not receive an edit-lock handoff.

Invitations are limited to existing current Core teammates eligible for that
prospect. Email-only/external invitations are refused. Acceptance requires the exact
addressed pending invitation and current eligibility. Notifications with prospect
metadata are filtered by current scope and current owner/active collaborator or the
exact pending invitation; missing drafts are unavailable. List counts describe
visible records at their individual checks, not a promised aggregate snapshot.

Public token shares/guest comments, client approval delivery, memory promotion,
Meri draft imports, copying prior drafts/context into generation, and queued/agent
model generation refuse prospect drafts. These exclusions apply to by-ID and worker
paths as well as list projections. Manual editing and existing saved versions/export
are supported. No new generation/send enablement or generic objective-bound link
claims are included.

## Source integration and remaining qualification

Core migration slot `20281012030000_prospect_resource_origin` adds the nullable
attachment origin, composite tenant/prospect FK and parent check, permanent upload
intent and immutable-origin/receipt triggers. Workspace's separate slot with the
same name adds its own origin/receipt and immutable triggers. Workspace owns only
`ws_*` ORM models and retains the existing no-Core-FK boundary. Receipt tables use
forced tenant RLS; no policy grant, service credential or database access was changed.

Both Prisma schemas validate and generate via the pinned Prisma WASM tooling for
local typing. Native migration application, database permissions, RLS execution,
real PostgreSQL MVCC/concurrency and real provider checks remain unrun. Route this
preparation through dot and qualify the exact integrated source before release.
See the dependency ledger and computed path intersections. Source work closes the
canonical association and durable retry contracts within these bounded operations;
it does not establish cross-service distribution, effective-date sourcing, objective
navigation or aggregate audience/completeness contracts.
