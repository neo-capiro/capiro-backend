const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { GovernedMemoryCandidateService } = require('C:/dev/main/meri-c1-20261002/apps/api/dist/memory/governed-memory-candidate.service.js');
const { runWithMemoryGovernanceTenant } = require('C:/dev/main/meri-c1-20261002/apps/api/dist/memory/memory-governance-tenant-scope.js');
(async () => {
  for (const name of ['MEMORY_GOVERNANCE_LIFECYCLE', 'MEMORY_GOVERNANCE_ENFORCE', 'MEMORY_CLIENT_REVIEW']) process.env[name] = 'enforce';
  const tenantId = randomUUID(), userId = randomUUID(), clientId = randomUUID();
  // Configure only the isolated probe process. Production flags/source are unchanged.
  process.env.MEMORY_GOVERNANCE_TENANTS = tenantId;
  const ctx = { tenantId, userId, role: 'standard_user' };
  const ids = Array.from({ length: 6 }, () => randomUUID());
  let allowed = true, payloadReads = 0, badSource = false, tenantTransactions = 0;
  const tx = {
    memoryCandidate: {
      findMany: async args => {
        assert.equal(args.where.tenantId, tenantId); assert.equal(args.where.proposedBy, userId);
        return ids.map(id => ({ id, clientId, proposedBy: userId, sourceKind: 'model_extraction',
          scope: 'client', status: 'pending', createdAt: new Date('2026-09-26T16:00:00Z'), decidedAt: null }));
      },
      findFirst: async args => {
        payloadReads++;
        assert.equal(args.where.tenantId, tenantId); assert.equal(args.where.proposedBy, userId);
        assert.ok(ids.includes(args.where.id));
        assert.deepEqual(args.select, { payload: true, sourceType: true, sourceId: true });
        return { payload: { key: 'Synthetic', value: 'Synthetic proposal', sourceRef: 'https://private.invalid', sourceExcerpt: 'private excerpt' },
          sourceType: badSource ? 'unknown' : 'meri_synthetic_fixture', sourceId: String(ids.indexOf(args.where.id) + 1).repeat(64) };
      },
    },
    $queryRawUnsafe: async () => allowed ? [{ allowed: true }] : [],
    client: { findMany: async () => [{ id: clientId, name: 'Synthetic client' }] },
  };
  const service = Object.create(GovernedMemoryCandidateService.prototype);
  service.governedPrisma = { withTenantUser: async (tenant, actor, fn) => {
    tenantTransactions++;
    assert.equal(tenant, tenantId); assert.equal(actor, userId); return fn(tx);
  } };

  // Native gates stay fail-closed with no canonical request tenant scope.
  assert.deepEqual(await service.listOwnProposals(ctx, { limit: 50 }), { enabled: false, candidates: [], nextCursor: null });
  assert.equal(tenantTransactions, 0);
  assert.equal(payloadReads, 0);

  // An explicitly configured cohort does not authorize a different scoped tenant.
  const offCohortTenantId = randomUUID();
  assert.deepEqual(await runWithMemoryGovernanceTenant(offCohortTenantId,
    () => service.listOwnProposals(ctx, { limit: 50 })), { enabled: false, candidates: [], nextCursor: null });
  assert.equal(tenantTransactions, 0);
  assert.equal(payloadReads, 0);

  // Eligible success uses the API's canonical AsyncLocalStorage tenant scope.
  const page = await runWithMemoryGovernanceTenant(tenantId,
    () => service.listOwnProposals(ctx, { limit: 50 }));
  assert.equal(page.enabled, true); assert.equal(page.candidates.length, 6);
  assert.equal(new Set(page.candidates.map(c => c.recordedSource.sourceId)).size, 6);
  assert.ok(page.candidates.every(c => c.recordedSource.sourceType === 'meri_synthetic_fixture'));
  assert.equal(JSON.stringify(page).includes('private.invalid'), false);
  assert.equal(JSON.stringify(page).includes('private excerpt'), false);

  // The ethical wall denies payload/source access while preserving redacted status.
  allowed = false; const before = payloadReads;
  const restricted = await runWithMemoryGovernanceTenant(tenantId,
    () => service.listOwnProposals(ctx, { limit: 50 }));
  assert.equal(payloadReads, before);
  assert.ok(restricted.candidates.every(c => c.restricted && !c.recordedSource && c.proposal === null && c.clientName === null));

  // Unknown source kinds never produce recorded-source metadata.
  allowed = true; badSource = true;
  const unknownSource = await runWithMemoryGovernanceTenant(tenantId,
    () => service.listOwnProposals(ctx, { limit: 50 }));
  assert.ok(unknownSource.candidates.every(c => !c.recordedSource));
  console.log('OFFLINE_PACKAGED_C2_RECORDED_SOURCE_PRIVACY_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });