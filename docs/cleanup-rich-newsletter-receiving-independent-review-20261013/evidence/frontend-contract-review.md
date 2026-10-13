# PR16 rich newsletter receiving and authoring contract review

Read-only source review, 2026-10-12. No native HTTP route, provider, database, build, install, frontend execution or source edit was performed. PR15 and every prior evidence packet remain untouched.

The first bounded frontend slice can use existing rich document authoring endpoints and the existing rich-record GET. It must not manufacture an Outreach record during routing. **A producer-owned, browser-safe runtime receiving contract is still missing from the distributed public package.** Request that contract before implementing a second frontend copy of rich DTO validation or casting unknown JSON to shared types.

## Exact provenance

- Backend PR2427 remained open/draft at `62d057b4a17b2c038920f10b93e83e51e46239bc`; PR2424 remained open/draft at `5470c6df029c9553dd49e531229c3c91b26275ef` when observed. [Head receipt](SOURCE-ORIGINS.json).
- Thirteen files were fetched through authorized GitHub read-only tools at the exact PR2427 commit. Every file's independently computed Git blob hash matches the returned blob identity. [Verification](SOURCE-VERIFICATION.json).
- The current Workspace controller/service and Core newsletter controller are byte-identical to their three corresponding preserved frontend handoff snapshots. Current Core service and canonical owner dependencies were fetched directly, rather than inferred from unchanged signatures.
- Package identity remains `@capiro/shared@0.0.0`, packed SHA256 `697d826647e88e7f8559da386be7de1ae6408dc61c73877b86c2e17275fd63ab`. This review reads the previously verified exact package's declaration files; it does not repack or re-execute it. Version `0.0.0` alone is not an immutable artifact identity.
- Draft PR status and source tests do not establish deployed backend availability, migrations, native authorization or provider acceptance.

## Receiving boundary and exact rich GET result

The authoritative [response-routing handoff](backend/docs/contracts/newsletter-outreach-response-routing.md) preserves the existing generic record kind `outbound_campaign` and adds only reserved optional response metadata:

| Input | Receiving behavior |
| --- | --- |
| Metadata absent/null, or stage hint absent | Ordinary existing workflow; an optional revision still needs valid reserved-field shape if present. |
| Present `newsletterStageId` | Must be a string matching the current stage owner's RFC-variant UUID versions 1–5: `/^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i`. Present null is malformed, not the same as an absent hint. |
| Present `newsletterRevision` | Positive safe integer provenance. It is not a CAS token or authoritative stage revision. |
| Malformed reserved value | Receiving failure; no silent fallback to another workflow. Preserve unrelated-field stripping; no blanket metadata passthrough. |
| Valid hint plus `outbound_campaign` | Candidate for dedicated owner GET by **existing record ID**, not proof of producer origin or any authorization. A wrong record kind must not enter the rich destination. |

Core `GET /api/engagement/newsletters/:recordId` has no body. Its exact assembly is [newsletter-outreach.service.ts:252](backend/apps/api/src/engagement/newsletter-outreach.service.ts), especially lines 294–323:

```text
{
  id: row.id,
  status: row.status,
  name: stage.name,
  stage: { id, documentId, revision, name, config, design },
  targets: metadata.newsletterTargets ?? [],
  senderConnectionId: metadata.newsletterSenderId ?? null,
  subject: row.subject ?? stage.config.subject,
  versions: [ { ...currentPreparedDraftVersion, recipientEmail } ],
  intentId: metadata.newsletterIntentId ?? null,
  excluded: metadata.newsletterExcluded ?? [],
  tests: [ { id, requestKey, senderConnectionId, versionId } ]
}
```

`versions` includes only metadata-selected prepared IDs that still equal an artifact's current draft version. `recipientEmail` comes from the tenant/user/record-bound recipient access row, or empty string if absent. Tests are scoped to the current sender, actor, record and prepared IDs. The spread version fields are exactly `id, artifactId, outreachRecordId, version, sourceVersionId, generationKey, recipientKey, audienceKind, subject, body, contentHash, generationStatus, auditStatus, approvalStatus, auditDecision, auditChecks, reviewRequestId, provider, model, promptSpecVersion, sendable, createdAt` from [outreach-draft.service.ts:1048](backend/apps/api/src/engagement/outreach-draft.service.ts).

This is the observed construction, **not a guarantee that every metadata-derived field has the apparent type**: generic metadata is caller-writable, and this service uses nullish defaults without validating `targets`, `senderConnectionId`, `intentId` or `excluded`. A producer runtime parser must specify and enforce these fields. The read result is neither generic `outreachRecord`, a V3 session receipt, nor the public `NewsletterStage` stage-creation receipt.

Core owner behavior for bad stage metadata is precise: record lookup first checks current actor ownership; absent/null metadata, absent/null/non-string stage ID returns 404; string ID failing the UUID expression returns 404; missing/cross-tenant/cross-Clerk-owner stage returns 404; denied source clients or record client return 404. `newsletterRevision` is not consulted. The current owner does not independently require `outbound_campaign` in this method, so the receiving kind check remains necessary. [Service lines 147–184](backend/apps/api/src/engagement/newsletter-outreach.service.ts).

The generic record owner scopes tenant, `createdByUserId === ctx.userId`, non-deleted rows and exclusion of internal record kinds. [Engagement lines 2690–2703](backend/apps/api/src/engagement/engagement.service.ts); [ownership helper lines 81–100](backend/apps/api/src/engagement/engagement-access.helpers.ts). Stage lookup separately scopes tenant and `owner_id === ctx.clerkUserId`, then checks every source client using current memory-wall access. A syntactically valid marker cannot grant access; generic create/update metadata can forge that marker.

Admission should bind request record ID, actor/tenant/client execution scope and current reader lifetime to the response. Invalid or denied current reads must not leave cached data eligible for actions. Replacement/unmount must discard old private display/editor state and late results. A differing stale hint or untrusted metadata revision cannot authorize automatic open, migration or a new association; the canonical current owner is authoritative.

## Rich document authoring endpoints

Private Workspace base is `/workspace-api/newsletters`, guarded through the canonical `@capiro/auth` TenantGuard seam. Relative routes below are from [newsletter.controller.ts:41–55,186–225](backend/apps/workspace/src/newsletters/newsletter.controller.ts).

| Method and relative path | Request | Response and authority |
| --- | --- | --- |
| GET `documents` | None | `{items: NewsletterCampaign[]}`; current tenant owner/editor visibility, current source-client access, newest 100. **Can activate pending invitations.** |
| POST `documents` | `{name?: string(max200), templateId?: string(max100)}` | New current-actor-owned `NewsletterCampaign`. No supplied `clientId`, tenant or owner field. Default/layout creation can apply current brand kit. |
| GET `documents/:id` | None | Current `NewsletterCampaign`; owner or current editor only, with all source clients checked. **May activate an invitation when a non-owner has no existing grant.** |
| PATCH `documents/:id` | `{revision: integer>=1, name: string(max200), design: object, config: object}` | Current `NewsletterCampaign` after atomic revision-checked update. Full document save, not a field patch. |
| POST `documents/:id/preview` | `{liveMergeTags?: boolean}` | `{html, plainText, checks: NewsletterCheck[]}` from the **saved current document**. Controller exposes no `recipient` field even though an internal service parameter exists. No revision/ETag receipt. |
| POST `documents/:id/stage` | `{revision: integer>=1}` | `{id, documentId, revision, name, createdAt, route}`; `route` is `/engagement/outreach?newsletterStage=<id>`. Explicit later intent, excluded from automatic routing/first slice. |

`NewsletterCampaign` is `{id,name,revision,status:'draft'|'staged',ownerId,updatedAt,config,design}`; `ownerId` is the document's Clerk owner, not a writable transport authority. Public [declarations](context/newsletter.d.ts) describe the design/config content. The backend private [validation owner](backend/apps/workspace/src/newsletters/newsletter-validation.ts) validates and normalizes content; it imports Nest, HTML sanitization and private font validation and is not a browser-safe public receiving parser.

Save first resolves the current owner/editor and current source access, validates design/config, unions previous and proposed source-client provenance, then updates only `{id, tenant, current document write scope, revision: suppliedRevision}`. Successful write increments revision by one and sets status `draft`. A zero-row CAS returns 409 with explicit reload/retain-unsaved-edits guidance. It then GETs current state to return the response. Thus failure after dispatch can occur after durable write; a generic transport/5xx failure is not proof that no save applied. [Service lines 268–301](backend/apps/workspace/src/newsletters/newsletter.service.ts).

Frontend requirements: retain local draft on definite validation/conflict errors; represent ambiguous dispatched create/save as unknown; prevent blind repeated create/save; use a deliberate current owner read and explicit adoption/rebase before renewed intent. A read establishes current state, not causal attribution. Create has no client idempotency/request key. Save uses revision CAS rather than request-key idempotency. Do not present a remote preview as representing unsaved local edits: it accepts neither those edits nor an expected revision. Any local draft rendering must remain distinguishable from saved server preview.

Staging atomically claims current write scope and exact revision, and upserts `(documentId,revision,ownerId=current Clerk actor)` with no update. The actor, including an authorized editor, owns that private immutable snapshot; it may differ from the original document owner. Invalid content is 400; stale revision is 409. This bounded upsert behavior does not establish global/cross-route idempotency. [Service lines 664–707](backend/apps/workspace/src/newsletters/newsletter.service.ts).

**Native GET caution:** list/get/review calls can invoke `activateInvitations`, persisting reviewer grants/activation and notifications for eligible current members. This does not create Clerk users or membership, but is effectful. Keep all such routes intercepted during synthetic qualification. Do not use a native list/detail/account-status read as a supposedly harmless connectivity probe. [Service lines 163–218,941–969,1038 onward](backend/apps/workspace/src/newsletters/newsletter.service.ts).

## Later explicit Outreach dispatch contract

Private Core base is `/api/engagement/newsletters`; RolesGuard requires `standard_user`. [Controller](backend/apps/api/src/engagement/newsletter-outreach.controller.ts).

| Method/path | Request | Response and semantics |
| --- | --- | --- |
| GET `stages/:id` | None | `{id,documentId,revision,name,config,design}` under current private stage authority. |
| POST `stages/:id/open` | No body | Creates/reuses an actor-owned legacy `outbound_campaign` draft for the stage; returns rich GET envelope. It never creates a V3 session. Mutating; never decoder/navigation side effect. |
| GET `:recordId` | None | Dedicated rich envelope described above. |
| POST `:recordId/prepare` | `{recipients: destination[1..500], targets: object[0..500], senderConnectionId: UUID, subject: string[1..300]}` | `{versions,excluded}` only. Current sender authority, draft status, sources, recipients, suppressions and required company/mailing address checks. No request key. |
| POST `:recordId/test` | `{requestKey: string[8..128], senderConnectionId: UUID, versionIds: UUIDv4[1..500]}` | `{intentId,deduped}`; service requires exactly one current prepared version. Runtime policy `outreach_test_send`. |
| POST `:recordId/send` | Same as test | `{intentId,deduped}`; all current prepared versions required. Runtime policy `outreach_send`. Receipt is queued intent identity, not completed delivery. |

Destination DTO: required email(max320); optional name(max200), clientId(UUID), directoryContactId(max200), company(max200), phone(max100), cc/bcc(email arrays max50). No `groupMembers` field; nonempty group destinations are rejected, not silently expanded. The existing input contract does not permit scheduling or alternate group workflows by inference from content configuration.

Prepare uses a record-scoped advisory mutation lock, creates recipient capability/artifact state and updates current prepared metadata. It is not a pure preview and can partially commit before failure; no automatic retry after unknown outcome. Send/test request keys are tenant/user scoped and compare record, sender, mode and sorted exact version set before returning a deduplicated receipt; reusing the key for different intent is 409. Current authority is resolved before dispatch/deduplication. There is no invented `expectedStateVersion`, stage-revision CAS or idempotency endpoint for these legacy routes. [Service lines 185–251,325–529](backend/apps/api/src/engagement/newsletter-outreach.service.ts); [intent owner lines 229–499](backend/apps/api/src/engagement/outreach-send-intent.service.ts).

Trusted import records the server-owned tuple `contentFormat: workspace_newsletter`, actual `newsletterStageId`, `generationStatus: manually_authored`, preserving canonical audit/approval. Generic caller JSON cannot confer that tuple. Queue and delivery recheck current active membership and all stage source-client grants. See [source access owner](backend/apps/api/src/engagement/newsletter-source-access.ts) and [draft import lines 1003–1045](backend/apps/api/src/engagement/outreach-draft.service.ts). Prepared HTML is not durable future permission.

## Keep the two staging families separate

| Rich newsletter | Saved Workspace revision |
| --- | --- |
| `WsNewsletterDocument` + immutable `WsNewsletterStage` | `WsDraft` + exact `WsDocVersion` snapshot/hash |
| Workspace POST `/newsletters/documents/:id/stage {revision}` | Workspace GET `/drafts/:draftId/versions/:versionId/outreach-revision` |
| Core legacy `/engagement/newsletters/stages/:id/open` and rich record flow | Core POST `/engagement/outreach-v3/sessions/:sessionId/newsletter-staging` |
| Stage owner is current Clerk actor; later legacy send request key/prepared-version rules | `{requestId,draftId,versionId,snapshotHash,expectedStateVersion}`; current existing V3 session and durable command receipt |
| Shared `NewsletterStage` creation receipt is not a Core stage-read DTO | Saved response includes hash format, author/saved fields, snapshot and plain content skeleton; V3 receipt includes stateVersion/specHash/receipt identity |

No UUID alias/bridge, copied ID, inferred session, auto migration or metadata revision substitution is supported. A WsDocVersion UUID used as a rich stage must be refused by the actual stage owner. [Preserved additive contract](context/BACKEND-CONTRACT-DELTA.md).

## Producer dependency for the immediate frontend slice

The two authorized public subpaths export content types, factories and render helpers. Neither declaration set exports a runtime campaign/preview/routing/rich-record decoder; rich Core envelope and stage-read types are not public. Existing backend validation is private and content-oriented. **Recommended next producer handoff:** browser-safe runtime receiving validators plus inferred/exported types for (1) reserved generic response metadata/discrimination, (2) rich document/list/create/save responses, (3) saved preview/checks, (4) Core stage-read and rich-record envelopes, reusing canonical draft-version fields. Preserve reserved-field rejection, ordinary/null-metadata behavior and unrelated stripping. Include malformed/unknown JSON fixtures and exact current returned fields; do not publish only interfaces or copy Nest/server imports into the browser.

This recommendation is a missing capability request, not evidence that those parsers already exist or permission to add a third public import path. The producer must publish a new immutable package artifact/hash and controlled export surface; frontend architecture allowlist, lock/vendor provenance and original renderer goldens must be requalified for that successor. Keep the current package sealed.

Synthetic acceptance should cover ordinary records, valid legacy marker, missing/null metadata, present null/invalid UUID/revision, wrong type, forged/stale markers, same-shape foreign tenant/actor/client IDs, revoked source access, saved-version ID masquerading as stage, current response identity mismatch and late scope results. Assert zero effectful collaborators during decoding/destination load. Authoring controls should cover create ambiguity, 409 retention/review, ambiguous save and deliberate readback, current server-only preview, and disposal after actor/tenant/client replacement.

Native acceptance remains separate: deployed backend revision/routes; complete schema/migration/RLS and identity/source owners; sender/mailbox authority; runtime action policy; durable audit/approval/send-intent worker behavior; asset and recipient public origins; effectful invitation/account/review boundaries; actual current grants and concurrency. This inspection neither invokes nor accepts those dependencies. The original handoff's eleven Workspace/five Core newsletter models and existing module/worker/config dependencies are retained as integration requirements, not newly verified deployment facts.

## Review limits and process

Static read-only source and declaration review only. No producer/frontend code changed; no route dispatch, provider call, paid action, migration, merge or deploy. No blanket rich UI, accessibility, Figma, native or image acceptance follows. One local evidence helper was corrected after assuming an absent preserved Core service filename; no source/evidence inputs were modified. An earlier oversized write-helper argv was replaced with bounded chunks; all thirteen resulting files were subsequently Git-blob verified.
