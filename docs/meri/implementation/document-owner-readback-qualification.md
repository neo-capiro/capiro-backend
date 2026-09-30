# Canonical fixture document readback qualification

Source: 125cd2d4a, over 02c89715d.

A concrete reader is now available for the existing ClientDocumentWriterService fixture port. It binds the configured uploader, exact authorized synthetic namespace/tenant slug, content-derived document ID, source marker, immutable provenance/version, expected bucket/key, file metadata and stored hash declarations. It uses EngagementService.extractAttachmentText with contextSourceOnly, which enforces current viewer, parent and readiness checks before downloading and hashes the actual stored bytes without parsing, provider use or extraction-result writes. The fixture reader never bypasses quarantine or directly calls S3.

Current database membership and client-wall access are checked before and after the canonical read. The row version and selected identity/lifecycle metadata must remain unchanged across the read. Declared content hashes alone cannot prove success: altered object bytes fail against the canonical reader's computed digest. This is bounded observed-state verification, not a guarantee against every future or transient concurrent change.

PASS, actual exit 0:

- Six actual local PostgreSQL tests with real Prisma owner queries, ClientDocumentWriterService runtime policy and EngagementService upload/source-read methods. Frozen PDF, PPTX and XLSX bytes upload and read back correctly; deterministic retries do not upload twice, and source-only reads leave extraction status/metadata unchanged.
- Negative cases cover object tampering despite unchanged row hashes, namespace mismatch, nine owner/provenance/version/storage/view/review/share/supersession metadata changes, quarantine refusal before object GET, client-wall denial, membership revocation during GET and row drift during GET.
- Eleven existing uploader identity and frozen binary content checks; changed-file formatting and whitespace checks.
- Independent Hermes/Bedrock moonshotai.kimi-k2.5 static review: SCOPED PASS, exit 0. The reviewer did not execute tests. Its initial setup-failure wording is corrected here: the invalid test-schema identifier regex rejected s3_key before the tests ran, cancelling six tests with process exit 1. The fixed schema setup and final run pass all six. An intermediate formatting check also failed and was corrected before the final check.

Evidence: C:/dev/cap-meri-foundation-evidence/document-owner-readback-final-postgres.log and exit receipt; document-owner-identity-content.log and exit receipt; review-document-owner-readback JSONL/exit/usage. The first setup failure remains in document-owner-readback-postgres-first.log. Final output records actual canonical document IDs, row versions and stored-byte hashes. Owned PostgreSQL schemas are removed.

## Wiring and limits

Construct createClientDocumentOwnerReader from fixture-provisioning/client-document-owner-reader.mjs with the canonical Engagement service, PrismaService, actual configured storage bucket, uploader resolver and existing clientMemoryAllowed policy. Pass that function as reader to createClientDocumentOwnerPort. The qualification test exercises this composition; no general document CLI/runtime bootstrap is declared ready yet.

The tests use an isolated minimal schema derived from generated Prisma scalar columns, not the production migration/RLS stack. Object storage is an in-process sandbox that accepts only PutObject/GetObject commands. Scan results are controlled, and asynchronous KB indexing is stubbed. The actual uploader, current document lookup, parent checks, readiness gate, byte-read method and hashing execute; no AWS object, shared database, parser provider, deployment or flag changes occur. No production TypeScript file changed.

This reader qualifies pristine ready fixtures only. Pending/quarantined sources remain unreadable and cannot produce a successful byte-readback receipt. Approved/shared/superseded document fixture states need separate owner semantics. Guarded canonical erasure, reconciliation/indexing proof, complete document runtime, parser receipts, other fixture owners, trusted capture, original 75/CD7/CW8 and applicable memory served acceptance and release gates remain open. No owner availability or LIVE/reset gate is widened by this change.
