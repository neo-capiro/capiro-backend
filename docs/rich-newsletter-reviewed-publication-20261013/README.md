# Rich newsletter receiving publication

This slice implements the receiving dependency requested by frontend PR16 qualification `b945b799591c7a0345441a489b27cdadee202235`, implementation `b0098f905e07a0e667566d7d7b0a8f7a8938423c`. It uses the existing public `@capiro/shared/newsletter` path and existing canonical Workspace/Core owners. Editable types, package metadata, persistence, controllers, renderer bodies and delivery policy remain preserved. The frontend owner can consume the qualified package and continue explicit operations; frontend consumption is not asserted here.

Final source is `38fec5c83585850ed75a7d3693b3b90d517e70af`, tree `b5aef300e56fae9b523d7525f1abd0f9c6baec75`. The [composition receipt](COMPOSITION.json) binds author, independent review, immutable package and exact declaration reuse. The current [contract handoff](../cleanup-retirement-additional-reviewed-inputs-20261012/HANDOFF.md) and [routing contract](../contracts/newsletter-outreach-response-routing.md) state the operation boundaries. Their prior PR2435 bytes are preserved in this directory.

| Direct owner response | Public receiving export |
| --- | --- |
| Document list `{items}` | `parseNewsletterDocumentList` |
| Create/get/save campaign | `parseNewsletterCampaign` |
| Saved preview `{html,plainText,checks}`; check list | `parseNewsletterPreview`, `parseNewsletterChecks` |
| HTML-check report | `parseNewsletterHtmlCheck` |
| Existing stage-creation receipt | `parseNewsletterStageReceipt` |
| Dedicated stage read | `parseNewsletterOutreachStage` |
| Dedicated record/open result | `parseNewsletterOutreachRecord` |
| Reserved metadata and ordinary/rich routing candidate | `parseNewsletterReservedMetadata`, `parseNewsletterRecordDiscriminator` |

These functions validate bounded JSON and optional expected resource/revision bindings. They preserve resource spelling and validated JSON fields without invoking accessors or producing side effects. They do not grant tenant, actor, wall, sender, approval or send authority. Creation receipts and dedicated stage reads have distinct envelopes. Rich `WsNewsletterStage` IDs remain separate from exact saved `WsDocVersion` and authorized existing OutreachV3 command receipts. HTML is untrusted text for the browser's sanitation boundary.

The existing canonical record owner additionally requires `outbound_campaign`, matching current primary client, and a valid matching reserved revision when present, before draft/effectful operations. Absent revision remains legacy compatible. Current stage ownership/source clients and record client authority continue through existing owners; all other14 methods and existing send/approval/idempotency bodies remain exact. No new store or service is added.

The final receiving correction accepts legitimate historical tests after current artifact-version rollover. The actual getter filters `versions` to current artifact versions but returns historical tests for prepared version IDs. Parser37 incorrectly required membership in the returned current-version set. Its RED witness, source37, earlier162-control acceptance and f23 package stay intact and are superseded for producer compatibility. Only that invented relation is removed; UUID, current sender, version parent/duplicates and expected resource checks remain. Historical test presence does not supply current approval.

The canonical17-segment Core typecheck passed at composition `cbbd197c66e8d623e94fb65c084e7af9f99a0beb` with `PE_PHASE_A_B_SAFETY_OK`. It used the exact794 declaration surface through a task-owned dependency overlay; final package declaration equality is required by the composition receipt. Raw output, empty stderr, command, source and overlay manifest are retained under `evidence/`. This is compiler/source acceptance, not runtime or native rich-lifecycle acceptance.

All original renderer corpus/goldens, source candidates, author and independent failures, earlier tarballs and raw physical whitespace evidence are preserved. The original116 legacy renderer cases use an explicitly declared original-export projection; receiving cases use the complete new public namespace. Complete namespace additions and private-subpath/browser closure checks are separate. Full physical whitespace remains OPEN; source-only checks do not waive it.

The schema/migration617-path inventory and Objective/saved-version/effective-date contracts remain unchanged. Protected unpublished EngagementService reporting work and excluded Quick log Commitment/We owe/They owe/counterparty UI remain outside scope. No provider/model/message/upload, live API/account invitation, database/migration, AWS/security/network-policy operation, main merge or deployment occurs. Native rich lifecycle, fresh frozen install, hosted supported-Node CI, authentic complete coverage floor and frontend route/browser/operator acceptance remain open as previously recorded.
