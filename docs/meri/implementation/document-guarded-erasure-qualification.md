# Canonical synthetic document erasure — bounded qualification

Source: `7e685d18b` over `a43c77072`. Verdict: **PASS for the internal guarded owner path**, not complete fixture reset or served acceptance.

The existing Engagement attachment deletion owner now exposes an internal synthetic-fixture method through ClientDocumentWriterService. It requires the exact authorized namespace and tenant slug, current active membership and role, client access, canonical uploader/content-derived ID, fixture marker, storage location, immutable metadata and original PostgreSQL row version. The claim transaction locks the relevant existing authority rows and attachment before recording a durable deletion intent. Storage deletion remains outside the transaction. Final deletion rechecks current identity and authorization in another locked transaction.

Storage failure preserves the intent and records `delete_failed`; retry requires the original guard, including its original row version. Generic failed-delete reconciliation excludes synthetic fixture rows so it cannot bypass those checks. Ordinary null/non-synthetic sources retain existing reconciliation behavior. Both the writer boundary and Engagement proxy reject this new external-write method in shadow mode. No controller, DTO, routing, migration, production model setting or shared-environment change is included.

## Direct evidence

Evidence directory: `C:/dev/cap-meri-foundation-evidence`.

| Evidence                                                         | Actual result              | Scope                                                                                                   |
| ---------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `document-guarded-erasure-build-final.log` and exit receipt      | exit 0                     | API TypeScript production build, incremental disabled                                                   |
| `document-guarded-erasure-postgres-final.log` and exit receipt   | 13 tests, exit 0, no skips | Actual Prisma/Engagement owner methods against a unique local PostgreSQL schema; sandbox object storage |
| `document-guarded-erasure-runtime.log` and exit receipt          | 29 tests, exit 0           | Writer and direct Engagement proxy external-action boundaries                                           |
| Changed-file Prettier check and `git diff --check`               | exit 0                     | Source/test formatting                                                                                  |
| `review-document-guarded-erasure.jsonl`, exit and usage receipts | SCOPED PASS, exit 0        | Independent Hermes/Bedrock Kimi static review of the exact source                                       |

Database tests cover deletion of owned row/object, requested KB purge, immutable metadata and version refusal, forged-role/namespace refusal, missing-storage/client-wall refusal, durable storage-failure retry, ordinary reconciliation, retained changed row after storage deletion, and the earlier PDF/PPTX/XLSX source-read cases. The concurrency test observes the owner waiting on a real competing PostgreSQL row lock, changes the locked row, then proves refusal before any storage delete.

The first build failed with TS2322 because the failure-recording callback returned two incompatible Promise result types. The callback now awaits either mutation and returns void. The earlier 12-test run used emitted output from that unsuccessful compiler run and is not the final build qualification. The final 13-test run followed the successful final build; both failures and final evidence are retained.

## Limits and review corrections

- The test database uses a minimal owned schema, not the complete migration/RLS environment. Object storage is an in-memory sandbox; no AWS deletion, provider call or shared database write occurred. Each owned test schema was removed.
- If storage deletion succeeds and final authorization/identity validation fails, the object may be gone while the row remains `delete_pending`. The method rejects; it does not promise atomic rollback across PostgreSQL and object storage.
- KB purge is requested asynchronously by the existing owner. Its completion and absence of other projections are not established by this qualification. Same-key storage replacement/version history is not qualified. Existing authorized ordinary/system erasure paths are not redefined as globally guarded fixture operations.
- The document fixture port, runtime registration and reset/retirement receipts remain closed pending cleanup evidence and retry/reconciliation integration. This commit does not declare the attachment owner available for full acceptance or widen LIVE guards.
- The reviewer mischaracterized the tagged Prisma SQL interpolation as needing a prepared parameter. Prisma already parameterizes these tagged substitutions; no string-built SQL is used. The reviewer also described the content-derived ID as a v5 UUID: it has a version-5-shaped field but uses the existing SHA-256 application identity algorithm, not the RFC UUIDv5 algorithm. Broad replay-prevention claims are not adopted: the original intent deliberately permits bounded retries.

Full original File01/01-1/01-B acceptance, other fixture owners, complete source/effect/build capture, hosted CI, database release clearance, both-main GitHub integration and deployment remain open. UI remains web-vnext at os.capiro.ai. No release completion is claimed.
