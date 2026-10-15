# Government and relationship context reconciliation

## Existing authority and coverage

Core remains the authority for saved Objective intent, government profile, client relationships, facilities and authorized history. Do not create a second profile/relationship corpus in Strategy or Meri. Runtime input is an operation-scoped projection with provenance, not a replacement source of truth.

`apps/api/src/context/objective-generation-context.service.ts:45–112` declares inventories for government profile support, government targets, represented facilities, target recommendations, member notes, state Directory, current Directory and relationship history. It reads the exact saved ready Objective/revision (`:286–311`), observes current staff/member/state details (`:150–248`), inventories included/absent fields recursively (`:378–415`) and binds those records to packet/source/coverage digests. Current staff classification is re-derived; registration fields alone are not government-relationship coverage.

`strategy-context-plane.service.ts:145–190` re-resolves authorized client/mailbox context and history. Its postmodel check reruns the resolver without recompiling a packet. `objective-generation-completion.ts:25–87` reobserves external/history context outside the write transaction, then fences current same-database authority and sources inside publication. The receipt's `compiledAt` and `reobservedAt` are observation times. It does not claim Directory or all history remains locked/current through commit. Preserve that honest as-of guarantee.

## Current limitations that prevent a complete-input claim

The existing Objective path fails closed rather than silently truncating rich required records: `objective-generation-context.service.ts:418–444` checks1600 characters per record and24000 aggregate, including original records/provenance; `strategy-context-plane.service.ts:23–24,256` also checks projection/provenance budgets. A rich Directory entry or facility/history inventory can therefore block a valid generation. Raising arbitrary limits alone does not define a complete or bounded input contract.

Generic domain projections are not full relationship evidence. `strategy-context-plane.service.ts:598–646` projects outreach subject/channel/sentAt/recipientCount/deliveryStatus but not body or recipient identities. Mail includes subject/from/to/snippet/thread, not full body or complete recipient roles/thread evidence. A retrieval pagination-complete flag cannot make omitted critical fields complete. The history digest witnesses the selected safe projection; it is not a digest of every underlying field.

The government profile inventory currently includes EIN (`objective-generation-context.service.ts:65`). Source enumeration or storage permission is not a reason to put that identifier in a general model prompt. The revised projection must omit EIN from general generation unless a specifically necessary purpose and approved policy explicitly allow it; represent the omission truthfully. Do not delete it from its authoritative owner merely to change model exposure.

## Proposed v2 coverage contract

Define a compact, exact critical inventory for this operation before changing either compiler or runtime schema. It must retain all required relationships, identities, source references and dependencies, with stable source keys and versions/as-of; do not substitute registration-only summaries. Reuse existing authorized owners/resolver paths for detail retrieval through bounded reference/window requests. Directory and history bodies remain at their owners, not duplicated into a new corpus.

Coverage must distinguish at least these meanings; exact enum/wire names require owner review:

| Meaning | Required truth |
|---|---|
| Included | Critical value/evidence is represented in the operation input or an authorized, successfully read referenced window. |
| Absent | Authoritative source was enumerated and the field/relationship genuinely does not exist. Empty collection alone is insufficient if enumeration failed. |
| Unavailable | Required owner/read/window failed, expired, was denied or could not be fully enumerated. It cannot be counted as absent or complete. |
| Policy omitted | Data exists or may exist but the operation policy deliberately excludes it. State the omission and its effect on readiness without leaking the protected value. |
| Pending/rejected enrichment | Proposed value has not become an accepted authoritative fact, or was rejected. Never treat it as an included accepted fact. |

Record requested/read counts, enumeration/window completion, exact critical field inventory, authorized source IDs/versions, as-of timestamps, dispositions and readiness issues. A source window that ends at a budget boundary must expose remaining work and refuse a false complete result. No silent1600/24000 truncation, first-N relationships, mailbox fallback, content-only summary or unsupported completeness flag.

Design authorized mail/outreach evidence to include the critical body, recipients/roles, thread and relationship provenance required for this task, subject to current mailbox/client permission and a reviewed compact/window policy. Restrict prompts and retrieval to the current tenant/client/purpose. Sensitive detail and provider/session credentials do not belong in public coverage receipts or logs.

## Enrichment and review boundary

Use existing fill/enrichment owners and their accepted/pending/rejected lifecycle. Carry source/version/as-of and decision status through the workflow. Where a missing accepted fact matters, return a precise blocked/review-required condition and, after allocation, a linked extension task. Do not infer acceptance from a fill job finishing, a UI review-ready state or a model's confidence.

An Objective or generated Strategy can be ready for human review while factual issues remain open. It must not be described as fully accepted, activated or executable while required relationship/approval dependencies remain unresolved. Consequential context-only approval dependencies require review even when every action task was created.

## Acceptance evidence still needed

Cover large nested Directory/staff records, many targets/facilities and moved relationships; zero genuinely absent sources versus denied/unavailable reads; current client/mailbox revocation; mail/outreach critical fields and recipient roles; complete window exhaustion and resumable bounded retrieval; concurrent source/revision change; external observation timestamp truth; rejected/pending findings; explicit policy omission/EIN exposure prevention; and public/log projections that exclude sensitive contents. Bind successful runtime inputs and immutable results to the reviewed inventory/hash. No provider calls, context API changes or source-owner migrations are authorized by this document.
