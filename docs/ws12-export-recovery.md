# Hill Day export request recovery

The existing Workspace export owner remains the producer. This contract extends
its current signer, stored PDF, document admission and status routes. It does not
add a render worker or promise that an interrupted render will resume.

## Requests and responses

`POST /workspace-api/hillday/documents/:id/exports` accepts
`{ pageSize?: "letter" | "a4", requestId?: UUID }`. Page size defaults to letter.
The authenticated tenant and actor come from TenantGuard, never the body.
Capture a new request ID before the first POST and retain it with the exact
document/page size. Identity is unique for tenant + actor, so reusing it for a
different document or page size returns 409. Exact replay returns the original
row, including a pending or failed result, without another render. Legacy calls
without requestId retain their existing non-recoverable behavior.

`GET /workspace-api/hillday/documents/:id/exports/requests/:requestId` returns
`ExportView | null`. It checks current document access before and after reading
the exact tenant/actor/document/request tuple. Null means no visible receipt;
it does not establish whether a previous request reached the server and never
authorizes automatic redispatch. Invalid request IDs return 400. Current access
refusals retain the existing document owner's 403/404 semantics.

The existing `GET .../exports/:exportId` and signed-file routes remain available.
All ExportView responses now additionally contain:

| Field | Meaning |
| --- | --- |
| requestId: UUID or null | Exact caller request; null for legacy calls/rows. |
| renderInputSha256: lowercase SHA256 or null | Captured assembled render input; not a whole-document revision. |
| contentSha256: lowercase SHA256 or null | Actual stored PDF bytes; null until ready or for historical rows. |
| sourceUpdatedAt: ISO timestamp or null | Document row timestamp observed by the assembled view; not a revision covering every meeting or external fact. |

Existing fields remain exportId, documentId, status (queued/ready/failed), format
(pdf), pageSize, filename, sizeBytes, url, expiresAt, error and createdAt. A
historical ready row may have null proof fields; never invent them at readback.
Only ready status with an issued URL supplies a download grant, and current
access plus the dedicated signing key still govern the grant and file access.

The render-input hash covers UTF-8 JSON.stringify of
`{format:"hillday-render-input-v1",view,pageSize,logoSha256}` in that property
order, where view is the captured JSON copy returned by HillDayDocumentService
and logoSha256 is the actual embedded logo bytes' SHA256 or null. View key order
is that of the producer's captured JSON, not a cross-language canonicalization
claim. The input is frozen once. PDF bytes and hash are committed together.
Later edits do not change either hash or cause an exact replay to render again.
Hill Day has no immutable whole-document version; its current view assembles
document and meeting rows and canonical display facts. These hashes prove the
captured input/output, not a transactional snapshot of all source owners.

## Uncertainty and consumers

The unique insert claims the request before rendering. Queued means a durable
claim without a settled outcome; after a crash it may remain unresolved. A new
process or readback never assumes the old renderer stopped and never starts a
second render. Failed renderer outcomes are also stable on replay. Creating a
new request is a separate deliberate action, not recovery of the original.

A database error during claim/ready publication may have committed. The POST
can fail while later readback is queued or ready. Ready publication is outside
the render-failure handler, so a lost database acknowledgement cannot downgrade
a committed PDF to failed. An unresolved database result stays unresolved.

The current frontend workspace-exports receiver ignores additional response
fields and its old POST still works. Its strict request schema does not yet
admit requestId and no request-read operation is registered. The downstream
consumer must add this exact operation/receiver, persist only request selectors,
validate response identity, retire stale lifetimes, and preserve UNKNOWN/no
automatic retry. No frontend implementation is included here. Integration owns
that shared adapter and Figma 3.4 governs any new controls.

## Native gate ownership

Release runs `apps/workspace/test/hillday-export-postgres.int-spec.ts` once after
independent review. It uses the existing A1 disposable PG helper with an explicit
loopback `a1_disposable_...` database and opt-in. It refuses elevated roles or
memberships. Release preinstalls citext/vector/pg_trgm/uuid-ossp in pg_catalog of
that fresh DB (Prisma's schema-only search path otherwise misses public types).
No shared/live database is valid. Generate the exact Workspace Prisma client
with the existing native runtime/engine before running; the author's engine-free
client generation and skipped collection are not a native pass.

The fixture builds the accepted dd03bc328f1aa3244aa7ea916202942fbfd57004 schemas,
seeds the canonical document parents and a legacy export, then applies only
20261026060000_hillday_export_request/migration.sql once in that same schema.
Raw pg is explicitly bound to and verifies the owned schema/database. All cases
use real Prisma, document admission/assembly, export service and PDFKit; only
external Core access/display facts and Directory branding are synthetic.
Query hooks execute actual SQL before withholding acknowledgements. The fixture
checks contention, persisted recovery, rollback/constraints and access release,
and cleans up clients/schema/temp files on failure as well as success. It does
not qualify full Core RLS history, external sources or native PDF fidelity.

The API and Onboard Prisma schemas, manifests, locks, production-closure pins,
WS10 generation and existing migration history are unchanged. This Workspace-
only additive schema does not change the API/Onboard closure inputs.
