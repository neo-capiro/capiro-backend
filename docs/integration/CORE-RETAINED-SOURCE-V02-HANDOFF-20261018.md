# Core retained source 0.2 handoff — 2026-10-18

This branch is stacked on Core PR #86 at `b40971b1f8de888687a8fb92fbdf4ff653fe10d3`. The matching Meri source work is draft PR #158, observed at `969b0879b8de1ef5b2cf5fc38b16bacc98e62a91`. The eleven operations below are **not available in the preview runtime**. The source receiver returns `MERI_RETAINED_SOURCE_UNAVAILABLE` after task-bound admission; the preview listener and tool manifest were not expanded.

## Transport and authority

The eleven retained operations use the existing exact `POST /api/clio/tools/<operation-id>` Option B target with a single-use `CapiroMeriRead` tool token. Core accepts the new IDs only at version `0.2.0`; legacy token shapes stay unchanged. Meri's token request includes `correlationSha256` for these IDs only. The signed token binds the exact POST body bytes, route, operation, call key and a separately authenticated correlation digest. Core checks the Meri `UNKNOWN` reservation and original seven-field ADMITTED binding under the admission lock. It preserves the distinct six-field Option B writer fence.

The `x-meri-read-correlation` header is unpadded base64url of canonical JSON UTF-8, at most 8192 decoded bytes, with exactly `{binding,subject,policyRevision,normalizationContext}`. Core verifies its bytes against the token claim before consuming the token. The body is exactly `{input,metadata}`; the token's `bodySha256` hashes the emitted `JSON.stringify` bytes, while `argumentsSha256` is the canonical hash of normalized `input` and `requestSha256` is the canonical hash of `{input,metadata}`. A wrong or missing header refuses before JTI consumption. Release still rechecks the delegation, run, consent, membership and selected-client wall before any bytes could return.

Meri must produce this correlation from its task effect authority and issue the token only after its `UNKNOWN` reservation. The shared dispatch owner must pass the trusted invocation ID and `toolCredential` to each retained adapter. The normalizer's metadata is never trusted as authority. A profile `asOf` value cannot be reported as a Core observation time unless its canonical owner read actually corresponds to that instant.

## Source status

| Operations | Core source preparation | Remaining runtime dependency |
| --- | --- | --- |
| `resolve_entity`, `find_contacts` | Trusted default Congress and canonical candidate deduplication; selected-client AND contacts/history filters with wall checks | Exact Meri 0.2 result validation and source lineage at the receiver |
| `get_client_context` | Six-section coverage/cursor projection refuses mismatched selection or observation | Canonical handler must truthfully project the trusted `asOf`, then full output validation |
| `read_monday_client_boards` | Current managed board mapping, row scope and receipt checks | Same-read mapping/version and row inventory from the Monday owner, plus output validation |
| `read_client_documents` | Selected-client, source hash and price/cap checks | Actual pre-call audio duration enforcement and measured pricing evidence before any paid extraction; owner result and full validation |
| `mail.list_messages`, `mail.search_messages`, `mail.read_thread` | Conservative page/body projector with unknown coverage and UTF-16 body proof | Same-read mailbox inventory, handles, per-row scope/active state, recipient completeness and output validation |
| `meeting.list_upcoming_meetings`, `meeting.query_debriefs`, `meeting.read_client_meetings` | Conservative inventory/body projector with unknown coverage | Trusted request/trace IDs, source inventory/read time/limitations from the owner and output validation |

No route calls a broad legacy handler as a substitute for these missing facts. The source projectors refuse absent evidence. Personal mail/meeting source reads need an explicit personal subject and a separate owner authorization decision; the selected-client delegation alone does not grant personal or Portfolio scope. Portfolio entity selection and portfolio-wide `query_tasks` remain separate Meri authority work.

Focused verification in this branch: 24/24 pure profile/Monday/documents/mail/meeting projection tests, 6/6 identity/contact owner tests, and 49/49 read-delegation/admission/token tests after the end-to-end correlation test was added. These are source checks only; there was no live AWS mutation, live SQL, paid build or paid source call. Runtime source facts, composed Meri relay, full result validation, preview forwarding and live readback are still required before any operation can be described as enabled.

## Fresh conversation finding

The N21 FE17 New Conversation blocker has an existing Core path. On the preview host, a live unmarked Clerk session can read the top-level client array from `GET /api/clients`; the preview read service filters it to current nonarchived, wall-visible clients. After explicit selection, `POST /api/clio/conversations/bootstrap` accepts `{schemaVersion:1,requestId:<stable UUID>,clientId:<selected UUID>}` and returns an idempotent receipt with `conversationId`, `tenantId`, `actorId` and `clientId`. Meri must verify identity and context before the initial run. An old `ATTEMPT_LOST` run can remain in history; current `NOT_FOUND` should leave the independent New Conversation selector available. The legacy `POST /api/clio/conversations` is not forwarded by the preview listener. Core bootstrap does not accept a clientless selector; no fabricated client ID or journal reset is appropriate. Deployed N21 listener and `PREVIEW_NATIVE_GETS_ENABLED` readback remain for the deployment owner.
