# Case12 retained fixture inventory search

**No exact MA510 fixture-instance manifest or canonical seed-binding inventory was found in the examined local files. Current live corpus existence remains UNKNOWN; no database or application read occurred.**

The bounded rg search matched 10 planning/readiness JSON files. Their exact paths, byte sizes and SHA-256 hashes are in result.json; none contains an actual MA510 physical binding, approved-memory dataset receipt or exact MA510 instance manifest.

The historical evidence path `C:/dev/cap-meri-foundation-evidence/file01-parallel-20260930` is absent at its recorded location. The retained source/doc evidence describes a random-instance 510-row probe that retired its rows, rolled back the transaction and verified schema/data absence. It is not a reusable live seed.

## Current-owner inspection prerequisites

- **exact_locator**: Original validated fixture manifest: fixtureInstanceId, fixtureVersion/contentSha256, T1 tenant, ASTER client, proposer/reviewer physical identities, and original synthetic ownership definitions. Candidate IDs depend on this exact fixture instance. Do not generate a new UUID and call it reuse.

- **retained_inventory**: Original kind=meri-approved-memory-local-bindings receipt with matching fixtureMapSha256 and bindingsSha256, MA510 plus at least 500 distinct newer eligible owned items. Retain actual allocated physicalId, candidateId, candidate/item row versions, ownership marker and payload hashes. Prospective item IDs are not allocations.

- **server_and_scope**: For any later lead-owned inspection, verify exact intended runtime/database and current source build, tenant/client and current memberships/reviewer role; use native Prisma/tenantContext and current canonical owner helpers. Preserve current ordinary Pat read authorization separately from reviewer membership.

- **nonmutating_seam**: Use runtime.inspect(logicalId) -> retirement.inspect(candidate) -> native memoryStore.inspectSyntheticFixture, or an equivalently bound source-owned inspection composition. Never call create/createDataset/retire/reapprove as a discovery fallback. Native inspection can take row locks; do not add a PostgreSQL READ ONLY transaction mode that breaks existing owner guard locking.

- **canonical_current_owner**: Revalidate approved candidate, exact proposer/payload/version/owner marker, committed item join under same tenant, canonical item and projection source/version/content/approval/lifecycle, and current actor/client governed read permission. Null, stale, retired, mixed-owner or unknown observations block reuse; a retained seed JSON alone is not current authority.

- **older_than_500**: Read source-owned current eligible Aster population with stable item IDs and real ordering evidence: MA510 predates at least 500 distinct currently eligible newer items. Setup ordinal 510 must join to actual timestamps/order, not a fabricated array ordinal. Canonical owner inspection alone does not establish this corpus-count/ordering condition.

- **no_free_search**: Do not use ordinary search_memory/direct retrieval as a provider-free census: queryEmbedding runs before the scoped DB read. This local search did not issue any application request. Source-owned inspection does not grant Case12 clock, capture, provider or journal admission.

## Next bounded step

Recover an original manifest/seed inventory from a retained non-retired owned instance if one is available elsewhere. Until then, prepare and locally qualify a Case12-specific canonical inspection adapter; any later live locator recovery/read or new setup must be separately source-qualified and lead-owned. Do not infer absence or automatically reseed.

This result does not prove that no suitable corpus exists anywhere. Search scope/exclusions are recorded, and compressed/binary archives were not inspected. No new capture, provider, budget or journal authority is created. Case12 and its human rubric remain NOT_RUN.
