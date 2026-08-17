# Knowledge Plane Phase 11 — Exact / Lexical Retrieval

## Decision

Exact retrieval is a deterministic rail **inside Retrieval V2**. It complements semantic retrieval; it does not replace it and does not create a parallel RAG/search architecture.

Phase 11 covers canonical names, aliases, domains, UEI, CAGE, CIK, contract IDs, federal bill IDs, Program Element codes, program names, and appropriation accounts.

## Typed intent

Callers provide an explicit `exactLexical` kind and value. Retrieval V2 never guesses that an arbitrary token is a UEI, CAGE code, CIK, contract ID, bill ID, or PE code. Federal display-form bills may include an explicit congress disambiguator.

## Authority

- Canonical names, aliases, and identifiers reuse the Phase 5 canonical entity registry and its existing exact alias/identifier indexes.
- Canonical identity lookup uses `UniversalEntityResolutionService.preview()` so retrieval is read-only and cannot create or merge identity.
- Client UEI/CAGE/appropriation/PE matching reads tenant CRM tables and retains the existing ethical-wall visibility rule.
- PE codes read `program_element` directly and exclude soft-retired rows.
- Program names reuse `program` + `program_alias` and the established `alias_normalized` convention.
- Federal bill IDs read `congress_bill`.
- Contract opportunity IDs read `sam_opportunity`.
- Federal award IDs/PIID/FAIN/recipient UEI read `federal_award`.
- Live structured government systems remain the source of truth. Exact retrieval results do not become evidence by themselves.

## No shadow index

The Phase 11 migration creates indexes only. It creates no search table, materialized search copy, duplicate entity dictionary, vector database, change ledger, or feature-specific index store.

Existing exact paths are reused instead of duplicated:

- `entity_aliases_*_lookup_idx`
- `entity_identifiers_*_unique`
- `program_alias_normalized_idx`
- `program_element.pe_code` primary key
- `congress_bill.id` primary key
- existing SAM solicitation and unique notice identifier paths

New indexes cover only query shapes that were missing efficient exact lookup, including canonical-name-first lookup, tenant UEI/CAGE, appropriation accounts, normalized award IDs, normalized SAM IDs, display-form federal bills, canonical program names, and normalized SEC CIK.

## Security and completeness

- Tenant client retrieval is executed through `PrismaService.withTenant`.
- Walled clients are visible only with an explicit `ClientMemoryAccess` grant.
- If a caller explicitly supplies client IDs and any requested client is unauthorized, the entire scoped retrieval fails closed.
- A completed exact authoritative scan may truthfully return zero records with `coverageComplete=true`.
- Unsupported domain/kind combinations are explicit `unsupported` coverage, never silently broadened to fuzzy/semantic matching.
- Exact scans are capped at 500 returned matches. Hitting the cap is `degraded`, `truncated`, and incomplete rather than pretending exhaustive coverage.

## Architectural boundary

Phase 11 changes no model prompts, reasoning logic, embeddings, reranking, GraphRAG, Meri-specific storage, or ContextResolver scope semantics. Exact lookup remains one capability of the shared Retrieval V2 plane.
