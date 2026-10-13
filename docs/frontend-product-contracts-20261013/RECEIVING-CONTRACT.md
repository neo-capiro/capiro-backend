# CORE-109 / MCAL-010 / PROS-024 receiving contract

This mapping binds accepted backend PR2468 `35374ac826edf10c84061b255380d1165538b6b9` (tree `67f4171db2ee7a1c0eb629dd050ede435d50ad28`) and the exact frontend delta at `1da8a551b00bba0f98e87954ef0a87566db236e6` (tree `e1e96cff6d4cd864a86c00775777aeb5ea7d7141`). The delta blob is `3248545b0d637ad70f421c17e5e819eb6f698e03`, SHA-256 `8cbd12c3d5380fdf41d86935f694d701379ee7ad5580cf1f06a89aa74d73f143`; its verification source is parent `ae8da60e6d63d02b65a6ff9eb71c90554f213a10`. No native row is accepted. Service paths below are relative to the existing Core `/api` or Workspace `/workspace-api` prefix.

## CORE-109: existing activity and Classic Outreach owners

`GET /clients/{clientId}/activity` already emits `{sourceType:"outreach",sourceId:recordId,origin:"derived"}`. ClientActivityService applies the current client wall, tenant/client filters and the existing caller-owned Classic Outreach predicate; reserved `outreach_v3` parents are excluded. Do not duplicate these records or treat an activity ID (`outreach:{id}`) as the resource ID.

The existing destination is `/modules/engagement?clientId={clientId}&draft={sourceId}`. Fresh `GET /engagement/outreach/{sourceId}` through the canonical owner is the destination read. Before rendering or editing, require its exact `id` and `clientId` to match the current requested pair; a fresh denied/error/mismatched read must conceal the old record and must not create a blank replacement. The URL and prior activity receipt grant no authority. Current frontend OutreachView checks the returned record ID but lacks this client association check; ActivityFeed lacks the Outreach source link. These are frontend receiving gaps. The separate V3 campaign parameter is `session`, not `draft`.

Protected unpublished EngagementService reporting source is not inspected or modified. The activity service, published controller and shared access predicate establish this mapping; native destination authorization remains a separate qualification gate.

## MCAL-010: comments and funding stay distinct

`GET /federal-register/documents/{documentNumber}` is the existing regulatory detail owner. Its `commentEndDate` is a public-comment deadline. `GET /federal-register/upcoming-deadlines` is only the next 30 days and at most 50 records. `GET /federal-register/documents?dateFrom&dateTo` filters publication dates, so it cannot be reused as a comment-deadline range feed. This slice adds the bounded, paged read below to the existing FederalRegisterService. Existing authoritative `effective-date-calendar`, document detail and upcoming-deadline behavior remain unchanged.

### Added cached comment range contract

`GET /federal-register/comment-deadline-calendar?dateFrom=2026-09-01&dateTo=2026-12-31&page=1&limit=50` uses the existing authenticated `standard_user` controller. Dates must be real `YYYY-MM-DD`, ordered with a span of at most 366 days. Both endpoint days are inclusive in UTC; `page` defaults to 1 and is bounded to 1–10000, `limit` defaults to 50 and is bounded to 1–100. Invalid input fails before a source read. The read selects only `commentEndDate`, ordered by that field and unique `documentNumber`, with rows, candidate count and latest ingestion metadata in one RepeatableRead snapshot.

The exact response shape is:

```ts
{
  data: Array<{
    documentNumber: string; title: string; agencyNames: string[]; htmlUrl: string | null;
    date: string; dateKind: 'comment_deadline'; precision: 'date';
    provenance: {
      source: 'federal_register'; sourceField: 'comments_close_on';
      cachedField: 'commentEndDate'; rawPublisherValueVerified: false;
    };
  }>;
  range: { dateFrom: string; dateTo: string }; page: number; limit: number;
  pagination: {
    totalCandidates: number; returned: number; excludedOnPage: number;
    hasMoreCandidates: boolean;
  };
  coverage: {
    scope: 'locally_ingested_comment_deadlines'; complete: false;
    allFederalDocuments: false; asOf: string;
    latestIngestion: null | {
      source: string; startedAt: string; finishedAt: string | null;
      status: string; rowsUpdated: number; errorCount: number; stats: unknown;
    };
    limitation: string;
  };
}
```

Only canonical midnight UTC cached dates inside the range become calendar entries. Missing, non-midnight or unusable candidates are excluded without publication/effective-date substitution. Follow `hasMoreCandidates` and advance candidate pages even when a page returns no entries; `totalCandidates` counts stored candidates, not accepted calendar entries. The persisted ingestion parser does not preserve the raw publisher string, so this response makes no raw-string or complete publisher-coverage attestation.

`coverage.asOf` is the read time, not a publisher freshness timestamp. `latestIngestion` describes the most recent ingestion attempt, including its status and completion time; even a successful attempt leaves `complete:false`. No per-record freshness limit or complete-calendar guarantee exists for cached comment dates. A refresh is a new authorized read after the separately owned ingestion updates; this route does not call the provider, refresh storage or fabricate success on read failures. Corrections replace the cached fact through that ingestion owner and appear on subsequent reads. Use `documentNumber` for the canonical detail link, not title or a generated calendar ID. The contract is tied to frozen source `2e18581dbb096dae36505f5a787c018c1e4259fa` / tree `951fdf6eed7cfd81de03ba22434451f0f6fa6315`; native and deployed acceptance remain open.

Funding already has `GET /intelligence/opportunities/v2/search` with `mode=all`, `sources=sam_gov,sbir_sttr`, `deadlineFrom`, `deadlineTo`, `deadlineWindow=any`, `sort=deadline`, `direction=asc`, `page` and `pageSize` (1–100). Bounds filter stored normalized deadlines inclusively. Use the echoed criteria, paging, `total`, `totalIsCapped`, `catalogComplete`, per-source freshness/provenance and unavailable source states; a capped/stale/disabled feed cannot imply completeness. Optional client scope remains authorized by its owner.

Exact detail is `GET /intelligence/opportunities/v2/detail/{source}/{sourceRecordId}` with the same optional `clientId` and mode. Published shared types are `OpportunitySearchResponseV2` and `FundingOpportunityV2DetailRecord`. The authoritative display fact is `opportunity.dates.responseDeadline={value,precision,timezone,sourceRaw,unavailableReason}`, with `sourceReference` and cached `provenance`. Keep `date`, `timestamp` and `raw` precision distinct; SBIR date-only values are not instants. SAM raw deadlines may carry an offset/zone and normalize differently from the flat search deadline. Treat search as candidate discovery, retain that limitation, and never substitute close/archive/posted/forecast dates. Unusable raw dates remain unavailable; existing source health does not prove completeness of a client calendar projection. No new funding store/service is needed for this contract.

## PROS-024: current Workspace document and version owners

`GET /drafts?prospectId={P}` and `GET /drafts/{D}` expose the existing canonical prospect-bound draft, current owner/collaborator access and its document tabs. Require current `{tenantId,prospectId,draftId}` and exact `document.id`/`document.draftId` membership; do not infer identity from titles, free-text client or the first tab. Prospect origin is immutable and current converted-client wall checks remain additive.

Document editing is `PATCH /drafts/{D}/documents/{J}` with the existing `{name?,ordinal?,body?:object}` DTO. `WsDocument.body` is JSONB containing ordered rich blocks and round-trips as a complete JSON object. The backend does not declare a reviewed generic text/mark/table serialization beyond that stored body; frontend schema/toolbar/preview fidelity needs an explicit concrete block contract. Draft title/config autosave is separate `PATCH /drafts/{D}`.

`POST /drafts/{D}/versions` creates an existing `WsDocVersion` snapshot `{docTitle,config,ask,documents:[{id,name,ordinal,body}]}`; `GET /drafts/{D}/versions` reads history and `POST /drafts/{D}/versions/{V}/restore` restores the whitelisted state. Saved-version immutability migration `20261012040000` is source-only, not an executed native guarantee. Snapshot/restore already preserve rich JSON, but current PATCH followed by snapshot is two operations: no server expected revision or request-keyed atomic save receipt exists. A browser updatedAt check does not provide CAS, and document edits do not stamp the parent's updatedAt.

Core brief versions remain a distinct owner (`BizdevBriefService`, bounded text sections/citations, immutable numbered versions and expected-version saves). They expose no authoritative Workspace draft/document association. Current Workspace origin binds a prospect only, not a Core brief/version. Workspace proposals are existing draft/template products; no separate Core proposal-record identity is declared here. Existing exact Workspace draft/document IDs can support a proposal document without a second store.

Current Core brief endpoints are `GET /business-development/prospects/{P}/brief`, `GET /business-development/prospects/{P}/brief/versions`, and `GET /business-development/prospects/{P}/brief/versions/{versionNumber}`. The source version exposes exact `id`, `versionNumber`, `sectionsHash`, `snapshotHash`, bounded sections/citations and source snapshot. `PUT /business-development/prospects/{P}/brief/versions` is the existing Core edit owner with an idempotency key and expected version number; it is not a rich Workspace body save.

### Approved product behavior — bridge implementation is a separate slice

Neo approved an independent editable Workspace copy pinned to the exact original saved Core brief version, with Workspace-owned edits and history and no Core writeback. The backend must retain and validate exact prospect/brief/version identity and source hashes, revalidate current source and destination authority, and own atomic save/replay semantics. A newer Core current version must not silently rebind the selected historical version. Request IDs, hashes and saved links do not replace current authority.

That approval resolves the product choice only. This calendar publication does not implement the association or atomic save route. The next separate source slice will publish its exact schema/pins and independently test conflicts, retries, interruption and wrong-client association before frontend consumption. Existing two-operation saves described above are still the current implemented behavior until that slice is accepted.

## Delivery and overlap

| Contract / owner | Dependency | This publication | Remaining receiving gate |
| --- | --- | --- | --- |
| MCAL-010 comment dates / FederalRegisterService | Backend PR2468 exact base; existing ingestion/cache schema | Adds one bounded read route; no schema/provider write | Frontend consumes candidate paging/provenance; native and deployed qualification |
| MCAL-010 effective dates / existing evidence owner | Existing authoritative effective calendar on PR2468 | Existing bodies and date authority retained | Existing explicit coverage/refresh/correction limits remain |
| MCAL-010 funding / Intelligence V2 owner | Existing search/detail contracts on PR2468 | Mapping only; source identity unchanged | Source precision and candidate-discovery limitation retained |
| CORE-109 / ClientActivity and Classic Outreach | Current same-client canonical destination read | Mapping only; protected reporting unchanged | Frontend source link and exact returned client/resource pair check |
| PROS-024 / Workspace Drafts, Documents, Versions plus Core brief owner | Neo-approved exact historical pinned copy | Approved intent documented; bridge not implemented here | Separate validated association and atomic save/replay source slice |
| Intelligence bills cleanup / PR2469 | Donor `b78f9d4ce28089139d60b2c7a601750c99f67e69`, tree `264d044daa4c1e8c606f49793ffa612d7957e535` | Preserved ref and separate queued worktree only | Owner final evidence and coherent receiving composition; no donor consumed here |

This publication adds comment-deadline range coverage in the existing Federal Register owner. CORE-109 needs the existing source link and a current destination pair check in the frontend. PROS-024 proceeds separately under the approved pinned-copy behavior, using existing Drafts/Documents/Versions owners and a concrete rich-block and atomic-save contract. The queued Intelligence bills ownership donor PR2469 is a separate cleanup dependency; it is not consumed by this calendar slice. No generic contract framework, new service/store, generation/send, database/migration execution, source/artifact policy activation, AWS operation, main merge or deployment is included. Native/design acceptance remains open. All earlier source and qualification heads remain preserved.
