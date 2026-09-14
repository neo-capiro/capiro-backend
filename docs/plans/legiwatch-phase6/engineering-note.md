# Phase 6 engineering note

Status: implementation, qualification, normal merge, live deployment and internal canonical preview verification complete. Client automation and recipient activation remain gated; see [release-qualification.md](release-qualification.md). The supplied handoff is a specification; the user subsequently authorized completion and rollout.

Before final native release qualification, merged refreshed main `99ca7f8b07c7cec4d14b3db60c13094bc37c764e` to preserve intervening managed-connector and meeting-preparation releases. The shared tool registry merged without conflict.

## Result and ownership

Folder staff can review keyword or Meri suggestions with exact source excerpts, freeze a selected batch, add/dismiss/exclude, see per-item stale/denied outcomes, inspect history and safely undo an untouched sole automation contribution. Existing assignments, per-folder position/priority/comments and Fast Tagger behavior remain authoritative. Manual removal suppresses every automatic rule for that folder/bill until deliberate manual restoration. Imported/manual assignments are never relabeled as automation-created.

| Owner | Changed contract and files | Release artifact |
|---|---|---|
| API | Canonical document and committed calendar/publication projections; existing lifecycle inbox gains `bill_keyword`; authenticated Meri bridge in `src/meri/meri-tools.service.ts` | API image and 3 migrations |
| Intel | `src/sourcedata/keyword-source.repository.ts`; `src/tracker/folders/folder-decisions.ts`; `src/tracker/keywords/*`; canonical folder/import writer, report runtime/delivery and task runner | Intel service + existing report worker image and 7 migrations |
| Workspace | `src/drafts/preparation-source.controller.ts`, dedicated shared-secret guard, `preparation-content.ts`, transaction-aware `drafts.service.ts`; immutable source action receipt | Workspace image and 1 migration |
| Meri/shared | Four full-chat tools, explicit read/write classification, governed proposal application, scope-bound canonical bridge | Meri image; shared compiled into consumers |
| Web | Folder Bills entry points, KeywordReview/ImportReview/DeliveryHistory, WorkflowReview, report deep links, preparation privacy split | web-vnext image |

No Engagement task is created: the initial added-bill output is an owner-scoped internal review item with a stable action link. Engagement canonical task visibility/idempotency remains an expansion gate. Existing Phase 5 approval, source/publication, private-document and outbound authority is reused.

## Matching and decision contract

Parser v1 is deterministic and bounded: 4,096 expression characters, 128 tokens, depth 16, 2,000,000 evaluated text characters. Supports qualified phrases, implicit AND, grouped Boolean operators, Unicode/case normalization and bounded prefix/suffix wildcards. Mixed unparenthesized AND/OR, ambiguous unsupported punctuation and prohibited phrase/wildcard forms are held. Requires a positive term. No user code or SQL expressions execute. AND/NOT are evaluated within one document; missing/partial text yields unknown, never a complete negative. Excerpts preserve original UTF-16 offsets.

Current API-owned source projections bind document/extraction revisions to canonical jurisdiction/session/bill IDs. Stable keyset pages (25 default, 50 maximum) progress beyond UI limits; scans retain checkpoint, counts, gaps, rule version and activation baseline. Full-document coverage remains explicitly unqualified. Meri contributes grounded suggestions only; model confidence cannot authorize automatic additions.

Assignment, immutable decision receipt and membership provenance commit in the canonical folder transaction under folder/source locks and current version checks. Manual exclusions, multiple contributions, repeated applications and unsafe undo remain visible. History survives assignment removal. Rule edits pause activation; from-now activation fences older scans and suggestions. Configuration control changes and overlapping-rule delivery references are append-only.

## Durable internal follow-up

Four fixed templates: hearing preparation, added-bill review, published-record review and report review. Preview freezes inputs without creating outputs. Configurations start paused; activation explicitly chooses from-now. The existing `run-report-updates` task calls keyword discovery, typed keyword delivery, committed-event detection and leased internal actions, followed by existing report/record work. The committed-event ledger avoids skipping late commits behind a timestamp cursor. There is no new provider poller or generic workflow engine.

Workspace resolves the immutable action through Intel's current authorization callback, then atomically creates the draft, document/config, private grounding context and receipt. Lost acknowledgements reuse that output; four injected write-step failures roll back. Retries preserve human edits, and deleted outputs are not resurrected. Source/calendar/assignment changes hold stale work. Published-record review delegates to the existing Phase 5 reconciler; report review uses the existing generator and never approves or sends.

Public preparation sections and public config contain published facts and snapshot IDs/hashes. Private folder notes remain a separate internal grounding item. Semantic source quotes are checked against canonical document ID/hash/offset; API injects the authenticated tenant/actor and rejects conflicting client/scope.

## Delivery and controls

Keyword messages use the existing report delivery intent/recipient queues, lease/fence, SES transport, inbox and uncertain-outcome handling. Rule delivery activation is separate from matching and automatic addition. Dispatch checks current active staff membership, owner/recipient client walls, source and folder versions, suppression, opt-out, rule and tenant/runtime gates. Overlapping rules retain independent authorization references without changing a frozen body. End-of-day grouping includes private owner identity and uses the existing timezone/DST schedule calculation. Held items retain a reason and require exact body-hash review; uncertain sends are reconciled, never blindly retried.

See [operator-runbook.md](operator-runbook.md) for gate names, adapter configuration and recovery. See [ten-rule-ledger.md](ten-rule-ledger.md) for every imported rule and [acceptance.md](acceptance.md) for measured evidence and limits.

## Migration ownership

Deploy API, then Intel, then Workspace additive migrations. Existing migration IDs remain unchanged. Clean and populated isolated databases applied 460 migrations each, including these 11, using `capiro_master` with the observed broad default grants to `capiro_app`. Decision/control/reference/remote receipt update/delete privileges are explicitly revoked; owner RLS and immutable triggers provide retained history.

- `api/20280913020000_legiwatch_keyword_source_projection` — SHA-256 `7e81a66e5edede6c02605fd56c61fd07be60d028a7a54ad1f061283efbdeee6f`
- `api/20280913021000_legiwatch_workflow_source_projection` — SHA-256 `c01ffb35c4d145fb7b18d20c7e250a2034d7fc7c0011edc0ce2c63b0844352e4`
- `api/20280913022000_legiwatch_keyword_inbox` — SHA-256 `8197924ac886a44039e0feaa4888c6c79d605a759f2bb1290cf519f5a5a95d1b`
- `intel-api/20260913020000_legiwatch_keyword_decisions` — SHA-256 `faabc24649bc91a4b7d314ec753a39955508faf7af5a0dd8bbdd5486c2972c20`
- `intel-api/20260913021000_legiwatch_keyword_history` — SHA-256 `1e0298f397fac0109ca1bcbfa4ee079f713248a9089bc863b87e8177849f81c5`
- `intel-api/20260913022000_legiwatch_keyword_worker_read` — SHA-256 `622a6fb17a4b61588efc85d5dcebecc560d35bbf57fa494d944a825499745a79`
- `intel-api/20260913023000_legiwatch_internal_workflows` — SHA-256 `c8f6011cd2c1e2f1ab8499f330bd9f1c2fe7f5010db9ed415d8fa91790e56b60`
- `intel-api/20260913024000_legiwatch_keyword_delivery` — SHA-256 `ea07785e616c3a087e82759527e650a196e1b106e3fa1100a7754976dccf7bf0`
- `intel-api/20260913025000_legiwatch_workflow_seen` — SHA-256 `637b4c16f8df905c1f131d2fbdd037896a594efc07c18abc8ea51303cc89d0bb`
- `intel-api/20260913026000_legiwatch_keyword_delivery_history` — SHA-256 `047a3d8b2a38000b2b719068f88cc2a5e4bc8c591b12e036bad2fa86bdafe47e`
- `workspace/20260913020000_legiwatch_preparation_actions` — SHA-256 `80dbc77755ba01033e9db4552c8aacacbc0a4d9cd59776c2afb9cc68f7c636e0`

The end-of-day delivery regression uses the actual dispatch time after cutoff so its lease is not artificially backdated. The cutoff/DST assertions and production lease protections are unchanged.
