# `read_client_documents` envelope boundary

`envelopeClientDocumentsResult` and `observeClientDocumentsCall` are opt-in only; the canonical tool response and dispatch are unchanged. The observer runs only after a successful legacy call. Rejections propagate as the exact thrown value and produce no envelope or error classification.

Listing mode is identified by the absence of a requested `documentId`. Its completeness means only that the requested filename-filtered listing was enumerated without pagination: a cursor request cannot be called whole-list complete, even if the returned page is terminal. Listing rows have no content provenance, and an empty complete listing means only `not_found_within_scope` for that listing scope, not that document content was searched.

Exact read and section-search modes are represented from explicit `document`, `coverage`, `records`, and `provenance` fields. A content read is complete only with matching client/document/request scope, explicit one-section whole-document coverage, and exactly one non-whitespace text record whose helper-derived record ID, section, character range, content hash, and SHA-256 section hash agree across payload, provenance, and coverage. A query is section-scoped and cannot be called complete for the full document. Empty/missing evidence remains unknown or partial; terminal cursor state alone never proves whole-document completeness. `generatedAt`, upload `createdAt`, and `indexedAt` are not promoted to source freshness.

Residual: this adapter is observational and not wired into tool dispatch or model exposure. The legacy API does not provide a universal source-freshness timestamp, and listing entries do not carry per-entry content provenance; both remain intentionally absent.
