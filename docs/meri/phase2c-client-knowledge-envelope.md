# Phase 2C: client knowledge result envelope

`search_client_knowledge` keeps its existing `tool`, `generatedAt`, client,
query, `results`, and `note` fields. It adds `outcome`, `coverage`, and typed
`sources` metadata so a caller can tell missing client context, a successful
empty ranked search, and backend unavailability apart. A supplied client ID
that is absent or not authorized keeps a non-identifying `Client not found`
error; it is not turned into a structured blocked result. Malformed client IDs
and unsupported source kinds are rejected as generic bad input before any
tenant/client lookup; both the model schema and KB service enforce the source
kind allowlist.

Coverage deliberately reports `complete: false` and `completeness: ranked_top_k`
for successful searches. The underlying KB applies an embedding score threshold
after a bounded top-k query, so zero returned hits does not prove the source
corpus has no matching record. `sources` identify only returned rows by their
existing kind and source id. The KB does not supply a source-version or
freshness timestamp; this adapter does not invent one.

## Local acceptance gate

Run the focused adversarial handler contract:

```powershell
pnpm --filter @capiro/api exec jest --runInBand --forceExit src/meri/meri-tools.client-knowledge-envelope.spec.ts
pnpm --filter @capiro/api exec jest --runInBand --forceExit src/embeddings/client-kb.search-access.spec.ts
pnpm --filter @capiro/api exec jest --runInBand --forceExit src/embeddings/client-kb-access.spec.ts
pnpm --filter @capiro/api exec jest --runInBand --forceExit src/prisma/prisma.service.spec.ts
```

The cases cover absent client context, equivalent non-identifying responses
for nonexistent and walled clients (including a simulated grant revocation at
retrieval time), successful empty results, backend failure, tenant scoping,
malformed IDs and source kinds, schema allowlist parity, and stable typed
source identity. Numeric, boolean, and object-valued client IDs/kinds fail
before KB work; absent/null/empty-string optional kinds remain unfiltered for
legacy callers. `searchWithAccess` returns the authorization decision with
rows from the same tenant transaction; the legacy `search()` remains a rows-
only wrapper. Denied IDs use the same `Client not found`
exception, and the client name is queried only after an authorized read. The
KB requests PostgreSQL `RepeatableRead`, so the wall predicate and evidence
query share one invocation-time database snapshot. A revocation committed
after that snapshot is established may still race the response; this does not
cancel an in-flight read.
The always-on client-knowledge snapshot now uses the same one-transaction
`RepeatableRead` rule for its wall decision, client profile, people, facilities,
and authorized document filenames. It returns nothing if the wall denies the
client in that snapshot; it does not claim to cancel a read already in flight
when a grant is revoked later.
This focused suite uses service doubles: it does not replace a database-backed
cross-tenant or client-wall integration test. Run the API typecheck and
existing client-KB persistence tests when host memory permits; neither has
been run as part of this bounded package.
