# Prospect access-path coverage

Inventory used `rg` over Core attachment and Workspace draft/document/version/context
readers and writers, excluding tests. The raw inventories are included in evidence.
This records entry-point ownership; it does not claim native SQL qualification.

| Surface | Prospect behavior |
| --- | --- |
| Engagement upload/confirm/list | Durable actor/prospect intent; exact key/checksum/length; current scope before external reads and final commit; viewer/version/scan/lifecycle retained. |
| Delete/supersede | Current scope + viewer; transactional claim/replacement; existing recoverable S3 deletion and permanent intent tombstone. |
| Core meeting/mail/notetaker artifacts, artifact sharing/approval, mailbox knowledge | Existing mandatory meeting/mail parent excludes prospect resources through the new exclusive-parent constraint; immutable origin prevents post-create relabeling. |
| Core system erasure/deletion reconciliation | Existing system-owned retention behavior preserved. Intent survives erasure. No user-facing system erasure route added. |
| Uploader user erasure | Existing FK `ON DELETE SET NULL` remains possible; origin and durable intent actor UUID survive, uploader reassignment remains forbidden. |
| SingleMail/record campaigns/Outreach send intents/V3 | Prospect selection refused before byte/provider work; preserved sender B/thread A authorization and provenance logic. |
| Extraction, client KB, profile fill, client Files/activity, Outreach evidence/context and Meri deliverables | Explicit prospect exclusion; no inferred client entitlement/copy on conversion. |
| Workspace create | Current Core write scope and same-transaction draft/document/receipt; exact replay uses current read scope, including archival history; deletion consumes receipt permanently. |
| Workspace drafts list/ID/edit/delete/anonymize | Canonical UUID list filter; current prospect source gate AND owner/collaborator; mutation/recheck transaction; origin never accepted on update. |
| Documents/comments/context/checks | Parent resolution followed by the same current scope and existing role policy; model-backed suggestion refuses prospect draft. |
| Versions | Current role for list/create/restore; fresh source snapshot inside create transaction; immutable origin excluded from restoration whitelist. |
| Export | Current scope before rendering and again before returning bytes. |
| Collaborators/invitations | Current owner role and recipient eligibility; external/email-only prospect invites refused; addressed pending invitation accepted/declined under current scope. |
| Edit locks | Current read/edit policy; revoked pending requester does not receive handoff. |
| Notifications | Current Core scope and owner/active collaborator/exact pending invitation; missing draft unavailable; denormalized title/count filtered. |
| Hill Day combined/client library | Prospect drafts excluded; display-name client matching does not establish canonical association. |
| Meri imports/quick-draft prior draft/context, blueprint use, memory promotion | Prospect source excluded before copy/metadata promotion. |
| Document agent/quality/revision, generation endpoints and worker/status/retry | Prospect origin refused on direct and queued paths; no model activation. |
| Public share/guest comments/client approval | Prospect origin refused before tokens, bytes, comments or distribution. |

Existing Intel source receipts remain an additional AND restriction in
CollaboratorsService.sourceAccess. No source-receipt endpoint, HQ impersonation
backend, or frontend client-scope implementation was replaced.
