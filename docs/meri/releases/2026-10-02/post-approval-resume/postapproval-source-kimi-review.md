PASS

Structural audit complete. All seven files demonstrate compatible bounded postapproval reconciliation with actual readback evidence. Key findings:

**1. Exact seven expected fields validated (postApprovalInTx:627-634)**
- Lines check: `originalClaimSha256`, `recoveryClaimSha256`, `continuationClaimSha256` (SHA256 regex)
- Lines check: `candidateRowVersion`, `itemRowVersion`, `clioRowVersion` (numeric regex)
- Line check: `projectionJobId` (UUID regex)

**2. Immutable readback verification sources (postApprovalInTx:635-696)**
- Historical claim hashes matched against fixture: originalOperation, recoveryOperation, continuationOperation (lines 650-657)
- Cross-claim consistency: continuationOperation.recoveryClaimSha256 === expected.recoveryClaimSha256 (line 673-676)
- Three STARTED historical claims preserved, never mutated (lines 660-671)

**3. CAS admission marker binding (executeCase01PostApprovalResume:850-878)**
- Operation constructed with exact seven fields derived from readback (lines 850-864)
- Tenant row CAS UPDATE with `xmin::text=$3` check (line 870-874)
- `claimSha256` journaled at VERIFIED phase (line 883-888)

**4. Exact job dispatch and revalidation (executeCase01PostApprovalResume:890-921)**
- Projection dispatched via `deps.memoryIngest.projectClioMemory` with exact jobId, memoryItemId, sourceVersion, contentHash (lines 899-906)
- Readback with `projected: true` revalidates embeddings present and match (line 908-913)
- Results journaled with `resultSha256` (line 916-920)

**5. Scoped canonical lifecycle continuation (executeCase01PostApprovalResume:933-946)**
- `scopedCandidates.approveSyntheticFixture` blocks reapproval of first candidate by physicalId check (lines 935-939)
- Returns to `continueClaimedSetup` with full historical chain: originalOperation, recoveryOperation, continuationOperation (lines 941-946)

**6. SQL safety and scoped visibility**
- All SQL uses `$queryRawUnsafe` with typed parameters, no interpolation (throughout postApprovalInTx)
- RLS policy audit in readback: memory_cleanup_outbox `mentions_tenant: true, mentions_bypass: false` (lines 1791-1798 in readback evidence)
- Non-owner non-BYPASSRLS role sees tenant-scoped outbox, zero rows with system scope (readback visibility section lines 1817-1839)

**7. Structural compatibility with readback evidence**
- Candidate row_version "113459135" matches expected pattern (in readback: line 1707, expected regex: digits 1-10)
- Item status "active", clio legacy_embedding_present: true, outbox status "pending" all match postApprovalInTx validation logic
- Content hash "4a411c1afa8b23bce2db5d5ee3b6214d22e696c49e4e15e3b922ebef568eeadc" (readback line 1726) matches job expected_content_hash (readback line 1753)

**8. Test coverage affirmation**
- postgres.test.mjs adds prepareCommittedFirstApproval (lines 149-214) with owned schema alterations for clio_memory.embedding, memory_cleanup_outbox columns, context_embeddings
- Test 'post-approval resume projects...' validates embedding call count === 1, zero synthesis submissions, FIRST_CANONICAL_PROJECTION VERIFIED present (lines 216-256)
- Test 'post-approval admission rejects...' exercises stale version, mutated approval, outbox drift, replay, lost reviewer rights (lines 258-301)
- Test 'post-approval postread rejects...' validates missing completion detection and durable claim preventing second projection (lines 303-335)

**9. CLI integration confirmed (meri-case01-setup.mjs:21-56, 66-84)**
- resume-plan and resume-execute commands added to valid set
- Branch routing dispatches to inspectCase01PostApprovalResume / executeCase01PostApprovalResume (lines 28-36, 55-57)

**10. Dependencies wired (meri-case01-setup-dependencies.mjs:63-138)**
- `canonicalProjectionSnapshot` exported from strict-memory-projector.service and bound to deps (lines 63-66, 135-136)
- `memoryIngest` bound via app.get(MemoryIngestService) (line 137)

All assertions pass structural review without requiring live execution.