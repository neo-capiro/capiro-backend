# Core retained source 0.2/0.3 handoff - 2026-10-18

Core PR #87 (`codex/core-retained-reads-20261018`) is stacked on PR #86 at
`b40971b1f8de888687a8fb92fbdf4ff653fe10d3`. The matching Meri source is
PR #158, latest observed at `11617c26`. This is a local source handoff: **none
of the eleven operations is available in the preview runtime**. The retained
receiver admits only source families with current owner facts and full pinned
Meri output validation for all nine wired 0.2 operations. The two disabled
families still answer
`MERI_RETAINED_SOURCE_UNAVAILABLE` after task-bound admission.

Core commit `5ef9e131d` gates `get_client_context` at **0.3.0 only**. The other
ten retained operations remain exact **0.2.0**. The profile receiver stays
closed while Meri's 0.3 `readWindow` schema and byte hash are pending.

## Transport and authority

The eleven retained operations use the existing exact `POST /api/clio/tools/<operation-id>` Option B target with a single-use `CapiroMeriRead` tool token. Core accepts `get_client_context` only at `0.3.0` and the other ten IDs only at `0.2.0`; legacy token shapes stay unchanged. Meri's token request includes `correlationSha256` for these IDs only. The signed token binds the exact POST body bytes, route, operation, call key and a separately authenticated correlation digest. Core checks the Meri `UNKNOWN` reservation and original seven-field ADMITTED binding under the admission lock. It preserves the distinct six-field Option B writer fence.

The `x-meri-read-correlation` header is unpadded base64url of canonical JSON UTF-8, at most 8192 decoded bytes, with exactly `{binding,subject,policyRevision,normalizationContext}`. Core verifies its bytes against the token claim before consuming the token. The body is exactly `{input,metadata}`; the token's `bodySha256` hashes the emitted `JSON.stringify` bytes, while `argumentsSha256` is the canonical hash of normalized `input` and `requestSha256` is the canonical hash of `{input,metadata}`. A wrong or missing header refuses before JTI consumption. Release still rechecks the delegation, run, consent, membership and selected-client wall before any bytes could return.

Meri must produce this correlation from its task effect authority and issue the token only after its `UNKNOWN` reservation. The shared dispatch owner must pass the trusted invocation ID and `toolCredential` to each retained adapter. The normalizer's metadata is never trusted as authority. For profile 0.3, the gateway's `asOf` remains gateway provenance. Core must capture bounded owner-read start and completion times and use the completion time as `generatedAt`; the gateway `asOf` cannot be relabeled as Core's observation. The exact `readWindow` schema and hash must come from Meri before Core can mirror and enforce them.

## Source status

| Operations | Core PR #87 local source status | Remaining dependency |
| --- | --- | --- |
| `resolve_entity`, `find_contacts` | Source wired: canonical owner reads, selected-client contacts/history wall checks, and complete byte-pinned Meri 0.2 output schemas with semantic source lineage. | Signed Meri relay and preview activation/readback. |
| `get_client_context` | Core now accepts only version `0.3.0`; **receiver remains 503**. The earlier pure six-section 0.2 projector/schema mirror is historical source preparation, not a qualified 0.3 result. | Meri publishes its exact 0.3 `readWindow` schema/hash; Core mirrors it, captures bounded canonical owner-read start/completion, sets `generatedAt` to completion, and adds focused receiver/release checks. |
| `read_monday_client_boards` | Source wired: current managed mapping before and after the canonical owner read; exact row board/request scope, result hash and byte-pinned Meri 0.2 output schema. | Signed Meri relay and preview activation/readback. |
| `read_client_documents` | Pure selected-client, source hash and pricing/cap checks exist. **Receiver remains 503**; an unmeasured or unenforced tariff cannot be treated as available. | Measured vision and Whisper prices, a reliable pre-call audio-duration cap in the actual extraction owner, and complete pinned output validation before receiver integration or a paid call. |
| `mail.list_messages`, `mail.search_messages`, `mail.read_thread` | Source wired: same-read mailbox inventory, handles, per-row mailbox scope and active-state checks, UTF-16 body proof, and complete byte-pinned Meri 0.2 output schemas. Coverage stays conservative. | Signed Meri relay and preview activation/readback. |
| `meeting.list_upcoming_meetings`, `meeting.query_debriefs`, `meeting.read_client_meetings` | Source wired: current owner result and source inventory, request/trace identity and limitations, and complete byte-pinned Meri 0.2 output schemas. Coverage stays conservative. The pre-release output ceiling is 16 MiB. | Signed Meri relay and preview activation/readback; admission does not yet expose a lower claim-specific output budget. |

The disabled families do not fall through to a broad legacy handler. Wired
families call their canonical owners with same-read checks, and their
projectors refuse absent evidence. Personal mail/meeting reads need an
explicit personal subject and a separate owner authorization decision; the
selected-client delegation alone does not grant personal or Portfolio scope.
Portfolio entity selection and portfolio-wide `query_tasks` remain separate
Meri authority work.

The nine source-wired operations are local Core preparations, not preview
availability. All eleven require Meri's signed Option B relay and task-bound
caller composition, the read-delegation signer/key and database facts grants,
the preview listener change and live readback of the service, keys and route.
The reserved Core migration `20281018060000_meri_read_delegation` and Meri's
four facts views have not been applied here. No live AWS mutation, live SQL,
paid build or paid source call was made for this handoff.

Objective D7-3 is a separate runtime dependency: Core has a bounded seven-
phase relay parser and pure Meri echo, but no mounted `/credentials` issuer or
post-effect revalidation route. Later-phase native SQL/resource adapters and
an authenticated original Meri ISSUED-run readback are still absent. Meri
must carry a stable operation ID across issue/release and reconcile uncertain
effects by read; Core must preserve durable proof-use and unique effect claims.
The Objective delegation migration still enforces `CHECK(enabled=false)`.
The policy revision, RSA caller public pin, RS256 issuer private key, fence
decision and runtime readbacks remain prerequisites. See
`OBJECTIVE-D7-3-SOURCE-STATUS.md` and
`OBJECTIVE-D29-SEVEN-PHASE-RELAY-CONTRACT-20261018.md`.

The user-approved Core preview capacity is encoded in source as **1 vCPU / 2
GiB per task** (`cpu: 1024`, `memoryLimitMiB: 2048`). The running task
definition and service still require live readback before and after the
coordinated change; no capacity deployment is asserted here.

## Fresh conversation finding

The N21 FE17 New Conversation blocker has an existing Core path. On the preview host, a live unmarked Clerk session can read the top-level client array from `GET /api/clients`; the preview read service filters it to current nonarchived, wall-visible clients. After explicit selection, `POST /api/clio/conversations/bootstrap` accepts `{schemaVersion:1,requestId:<stable UUID>,clientId:<selected UUID>}` and returns an idempotent receipt with `conversationId`, `tenantId`, `actorId` and `clientId`. Meri must verify identity and context before the initial run. An old `ATTEMPT_LOST` run can remain in history; current `NOT_FOUND` should leave the independent New Conversation selector available. The legacy `POST /api/clio/conversations` is not forwarded by the preview listener. Core bootstrap does not accept a clientless selector; no fabricated client ID or journal reset is appropriate. Deployed N21 listener and `PREVIEW_NATIVE_GETS_ENABLED` readback remain for the deployment owner.
