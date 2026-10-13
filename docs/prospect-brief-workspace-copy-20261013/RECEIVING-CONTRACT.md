# PROS-024 — independently editable pinned Workspace brief copy

Neo approved a Workspace copy pinned to the exact original saved Core brief version. Workspace owns its edits/history; Core remains unchanged. This slice extends the existing Documents, Versions and prospect-draft owners, with a Core saved-source seam beside the existing shared prospect authority policy. It introduces no service, store, Core ORM model, generation, send or external provider call.

Base: published calendar/receiving PR2470 `46aa2164c299151225c6cdb9f3cc565fee347657`, tree `4fbcf7aa57df661faaf0fac12251c3788ae1edc4`. Frozen code: `f073aacdef4fbf0ca860b9bfe0debd94022b9c1a`, tree `f957843c0709fa64081b8084b7d356c251a07a12`. Source qualification and independent review are recorded separately; schema/client/native/deployed gates must not be inferred from a source commit. The exact frontend receiving delta remains `1da8a551b00bba0f98e87954ef0a87566db236e6`.

## Exact source and current authority

The only accepted source identity is:

```ts
type Source = {
  kind: 'core_prospect_brief_version';
  prospectId: string; briefId: string; versionId: string;
  versionNumber: number; // integer 1–100
  sectionsHash: string; snapshotHash: string; // lowercase SHA-256 hex
};
```

UUIDs in new commands are canonical lowercase. The existing Core brief/root/version reads supply this tuple; titles, free-text client names and current-version shortcuts cannot substitute. Exact `(tenant,prospect,brief,versionId,versionNumber,sectionsHash,snapshotHash)` is re-read through the Core-owned saved-version seam inside the same tenant transaction. Source sections/snapshot hashes are verified before import. A newer current Core version never changes the selected version. A neutral `Core brief copy — version N` tab label avoids claiming that the current root title was saved with a historical version.

The current prospect authority must pass active tenant/member/role, `businessDevelopment.enabled`, `businessDevelopment.brief.enabled`, current converted-client status/wall/grant and exact prospect identity. Workspace owner/editor rights are additional requirements for copy/save; owner/collaborator read rights apply to reads. Administrators receive no wall bypass. The exact nullable `expectedClientId` must be present in every command and equal the current live linked client (`null` means unconverted). A request UUID, hash, old receipt or stored association grants no later authority.

Existing Core identity/grant/feature rows are SHARE locked and the exact Workspace parent is FOR UPDATE locked through command commit. Current authority also applies to established Workspace reads of a draft containing a copy, so an old draft/detail/history/export route cannot bypass the Core brief flag or deleted source. Up to 20 copied tabs per draft are supported; identical source tuples are deduplicated during authority checks. Ordinary tabs keep their existing behavior and do not count toward that copy bound.

## Existing DocumentsService routes

All paths are under `/workspace-api`, use the existing TenantGuard and canonical server tenant/actor context. Both reads use `Cache-Control: private, no-store`.

| Route | Input / result |
| --- | --- |
| `GET /drafts/{D}/documents/brief-copy-state` | Current authorized baseline: `{schemaVersion:1,tenantId,draftId,prospectId,clientId,stateHash,hashFormat:'workspace-prospect-draft-state-v1',documents:[{id,name,sourceBriefVersion}]}` |
| `GET /drafts/{D}/documents/{J}/brief-copy` | Exact current copy detail: the same scope/hash fields plus `document:{id,name,ordinal,body,sourceBriefVersion,createdAt,updatedAt}` and server-owned `sourceEvidence:{sections,citations,sourceSnapshot}`. Wrong draft/document or denied source is unavailable; there is no first-tab fallback |
| `POST /drafts/{D}/documents/core-brief-copy` | `{requestId,expectedStateHash,expectedClientId,source:Source}`. Server imports only the exact saved version and creates a new document tab plus its saved version/receipt atomically |
| `POST /drafts/{D}/documents/{J}/brief-copy-save` | `{requestId,expectedStateHash,expectedClientId,body,name?,ordinal?,docTitle?,label?}`. Exact bound document only; full body and optional display fields plus history/receipt commit atomically |

New copy/save DTOs reject unknown command fields. `name` is 1–300 characters, `docTitle` 1–500, `label` at most 300 and `ordinal` an integer 0–100000. The rich `body` is complete ordered JSON with required `blocks`, at most 1000 blocks and 4,000,000 UTF-8 canonical JSON bytes. Each block has a unique nonempty ID of at most 64 characters and existing `section|photo|table|logo` type; optional title/content are strings. Extra rich fields, marks, cell structures, images and order round-trip as JSON. Non-JSON values, forbidden prototype keys, more than 100000 nodes or nesting beyond 32 fail before persistence. The bounded whole-draft state is at most 8,000,000 JSON bytes.

The initial five blocks follow Core section order and contain escaped original text in the existing section-block representation. Full original section provenance/citation indexes, citation identities and source snapshot remain server-owned `sourceEvidence` in each atomic saved version and the fresh detail read. Client edits cannot replace that evidence or the immutable source column. Saved evidence identifies the original Core source; it does not assert that newly edited text is supported by those citations. Backend saves preserve JSON and perform no HTML rendering; frontend editor/rendering fidelity remains separately qualified.

The baseline hash covers exact draft/prospect IDs, current title/config/ask/display/status/packet fields and every ordered document's ID/name/ordinal/body/source association. Document-only edits change it even when the legacy parent timestamp did not. Documents are ordered by ordinal then ID. It is an expected content-state CAS, not an entitlement or monotonic revision: an exact return to the same content state has the same hash. A changed current state conflicts; there is no silent overwrite or automatic retry.

## Durable atomic response and replay

Both commands return:

```ts
{
  schemaVersion: 1; replayed: boolean;
  receipt: {
    tenantId: string; draftId: string; prospectId: string;
    operation: 'copy_core_brief' | 'save_brief_copy';
    requestId: string; requestHash: string; actorId: string;
    documentId: string; clientId: string | null; source: Source;
    stateHash: string; versionId: string; snapshotHash: string;
    hashFormat: 'workspace-snapshot-canonical-json-v1';
  };
}
```

The existing `WsDocVersion.id` is the request UUID; its immutable snapshot holds the server receipt, full draft/document state and source evidence. `snapshotHash` is SHA-256 of the existing canonical Workspace snapshot JSON. No additional receipt table is created. The server fingerprint binds operation, tenant, actor, destination, complete exact source/content, expected state/client and submitted fields. All document/state/version writes share the authorized parent transaction; interruption before commit rolls them all back.

Every retry first revalidates current source and destination authority. A matching request returns the original exact document/version receipt with `replayed:true` before comparing its now-stale expected-state hash. It performs no new write. Reuse with different content, actor or expected binding conflicts. A UUID collision elsewhere is a generic conflict without foreign receipt data. Deadlocks, permission errors and interruptions remain errors; the server does not invent a success or retry automatically.

A replayed receipt proves the original saved version, and may be older than the current editor state after a later edit. It is not a current-body response. Verify exact tenant/actor/prospect/client/draft/document/request association, then perform the fresh detail/baseline read before rendering or starting another save. Retained frontend intents reuse the same request UUID/input until reconciled; do not replace uncertain requests with blank copies or new UUIDs automatically.

## Legacy paths and deletion policy

Legacy document PATCH and tab removal reject a bound copy with `WORKSPACE_BRIEF_ATOMIC_SAVE_REQUIRED`; the check is inside the parent lock and handles uppercase UUID aliases. Existing version restore rejects a draft containing a copy under the same lock, including a copy inserted after its pre-read. Submit explicitly reviewed restored content through the atomic save command instead. Ordinary documents/restores remain on their established path.

Legacy prospect draft PATCH re-reads the current locked state before merging config/packet fields. Ordinary snapshot creation remains non-receipt history and retains source associations; it is not claimed to atomically save changed content. Existing whole-draft deletion policy remains a current owner/editor plus historical read-scope operation and cascades that draft's versions. A deleted destination/receipt is unavailable on retry and is never recreated implicitly. New copy/save themselves require active write scope.

Stable command conflicts include `WORKSPACE_BRIEF_STATE_CONFLICT`, `WORKSPACE_BRIEF_REQUEST_CONFLICT`, `WORKSPACE_BRIEF_COPY_CONSUMED`, `WORKSPACE_BRIEF_COPY_LIMIT` and `WORKSPACE_BRIEF_ATOMIC_SAVE_REQUIRED`. Invalid input is 400; missing/denied/mismatched current identity is 404; infrastructure failures propagate. No error response grants a destination.

## Source schema, staging and overlap

Source-only Workspace migration `20261013090000_prospect_brief_workspace_copy` adds the nullable immutable `ws_document.source_brief_version` JSONB column. Its exact shape is checked, binding is INSERT-only, row identity/tenant/draft transfer is prohibited and the inserted source prospect must equal the parent origin. Existing saved-version immutability source remains a dependency. No migration is executed or native Prisma download/checksum bypass is attempted. Deployment requires the schema/client/build and native transaction/permissions qualification by their owners; source tests are not PostgreSQL/RLS acceptance.

| Lane | Exact dependency / overlap | Status |
| --- | --- | --- |
| Workspace copy / this slice | PR2470 exact base; existing Core prospect/brief and Workspace document/version owners | Concrete source routes/schema/CAS/replay; receiving qualification here |
| Regulatory calendar / PR2470 | Head `46aa2164...`, tree `4fbcf7aa...` | Published and frontend Calendar owner reports consumption; no native row acceptance inferred |
| Protected Engagement reporting | Separate owner and unpublished reviewed code | No body read, branch change, source duplication or loss claim |
| Cleanup PR2469 + PR2471 | `b78f9d4c...` then `4970927f...`, preserved exact refs | Both queued, unconsumed; compose together after this interface publishes, with one receiving cycle |
| HTTPS staging | See [STAGING-INTEGRATION-PLAN.md](STAGING-INTEGRATION-PLAN.md) | Preview template production-bound; isolated backend/Meri/database/auth unverified; activation/write E2E held |

All prior source/evidence heads remain recoverable. Main merge, deployment, real messages/uploads/provider/model/customer writes, credential/permission changes, AWS and security/network changes remain outside this source task.
