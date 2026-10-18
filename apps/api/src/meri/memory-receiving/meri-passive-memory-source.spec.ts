import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { canonicalSha256, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';

jest.mock('../../memory/memory-wall.helpers.js', () => ({
  clientMemoryAllowed: jest.fn(async () => true),
}));
jest.mock('../../retrieval/adapters/governed-memory-eligibility.helpers.js', () => ({
  canonicalMemoryEligibilitySql: jest.fn(() => ({ strings: ['TRUE'], values: [] })),
  includeCanonicalGovernedMemoryRow: jest.fn(() => true),
}));

import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { canonicalMemoryEligibilitySql, includeCanonicalGovernedMemoryRow } from '../../retrieval/adapters/governed-memory-eligibility.helpers.js';
import {
  checkPassiveMemoryEligibility,
  parsePassiveMemoryEligibilityRequest,
  parsePassiveMemoryWire,
  readPassiveMemorySource,
} from './meri-passive-memory-source.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const itemId = '44444444-4444-4444-8444-444444444444';
const ctx = { tenantId, userId: actorId, role: 'standard_user' } as TenantContext;
const nowMs = 1_791_800_000_000;
const hash = 'a'.repeat(64);

const wire = (selected: string | null = clientId) => ({
  input: { query: 'authorized memory', clientId: selected, k: 3, cursor: null, memoryItemId: null, contentCursor: null },
  metadata: { sourceConnected: false, authoritative: false, currentPolicyQualified: false,
    cursorAuthenticated: false, absenceEvidence: false },
});

function callback(selected: string | null = clientId, records: Array<{ memoryItemId: string; recordSha256: string }> = []) {
  const body = wire(selected);
  return {
    operation: { id: 'search_memory', version: '0.2.0' }, ...body,
    normalizationContext: { tenantId, userId: actorId },
    argumentsSha256: canonicalSha256(body.input), requestSha256: canonicalSha256(body),
    binding: { tenantId, actorId, conversationId: '55555555-5555-4555-8555-555555555555',
      runId: '66666666-6666-4666-8666-666666666666', attemptId: '77777777-7777-4777-8777-777777777777',
      workerId: '88888888-8888-4888-8888-888888888888', writerFence: 2 },
    subject: { kind: selected === null ? 'personal' : 'client', entityType: selected === null ? 'user' : 'client',
      entityIds: [selected ?? actorId], tenantId, actorId,
      authorizationDecisionId: '99999999-9999-4999-8999-999999999999', policyRevision: 'rev-1',
      scopes: [{ tenantId, kind: selected === null ? 'private-user' : 'client',
        resourceId: selected ?? actorId, policyRevision: 'rev-1' }], rosterVersionId: null },
    policyRevision: 'rev-1', sourceIds: ['client_knowledge_memory'],
    resultSha256: hash, records, deadlineMs: nowMs + 10_000,
  };
}

function db(rows: unknown[] = []) {
  const tx = { $queryRaw: jest.fn(async () => rows) };
  const prisma = { withTenantUser: jest.fn(async (_tenant: string, _actor: string,
    run: (arg: typeof tx) => Promise<unknown>) => run(tx)) };
  return { tx, prisma };
}

describe('passive memory source contract', () => {
  it('keeps the emitted body hash separate from the canonical request hash', () => {
    const body = wire();
    const emitted = Buffer.from(JSON.stringify({ metadata: body.metadata, input: body.input }), 'utf8');
    const targetBodySha256 = sha256Hex(emitted);
    const requestSha256 = canonicalSha256(body);
    expect(targetBodySha256).not.toBe(requestSha256);
    expect(parsePassiveMemoryWire(JSON.parse(emitted.toString('utf8')))).toEqual(parsePassiveMemoryWire(body));
    expect(parsePassiveMemoryEligibilityRequest(callback(), ctx, nowMs).requestSha256).toBe(requestSha256);
  });

  it('passes only the exact normalized input to the existing canonical reader', async () => {
    const read = jest.fn(async () => ({ tool: 'search_memory', records: [] }));
    await readPassiveMemorySource(ctx, wire(), { executeFromAuthenticatedUser: read } as never);
    expect(read).toHaveBeenCalledWith(ctx, 'search_memory', wire().input);
    expect(() => parsePassiveMemoryWire({ ...wire(), metadata: { ...wire().metadata, sourceConnected: true } }))
      .toThrow(BadRequestException);
    expect(() => parsePassiveMemoryWire({ ...wire(), input: { ...wire().input, clientId: clientId, other: 1 } }))
      .toThrow(BadRequestException);
  });

  it('binds page, actor, selection and hashes before any eligibility read', () => {
    expect(parsePassiveMemoryEligibilityRequest(callback(), ctx, nowMs).sourceIds)
      .toEqual(['client_knowledge_memory']);
    expect(() => parsePassiveMemoryEligibilityRequest({ ...callback(), requestSha256: hash }, ctx, nowMs))
      .toThrow(ForbiddenException);
    expect(() => parsePassiveMemoryEligibilityRequest({ ...callback(), sourceIds: ['other'] }, ctx, nowMs))
      .toThrow(ForbiddenException);
    expect(() => parsePassiveMemoryEligibilityRequest({ ...callback(), subject: {
      ...callback().subject, entityIds: [actorId],
    } }, ctx, nowMs)).toThrow(ForbiddenException);
    expect(() => parsePassiveMemoryEligibilityRequest(callback(clientId, [
      { memoryItemId: itemId, recordSha256: hash }, { memoryItemId: itemId, recordSha256: hash },
    ]), ctx, nowMs)).toThrow(ForbiddenException);
  });

  it('rechecks the current client wall for an empty page and refuses revocation', async () => {
    const { prisma, tx } = db();
    jest.mocked(clientMemoryAllowed).mockResolvedValueOnce(false);
    await expect(checkPassiveMemoryEligibility(prisma as never, ctx, callback(), () => nowMs))
      .rejects.toThrow(ForbiddenException);
    expect(prisma.withTenantUser).toHaveBeenCalledWith(tenantId, actorId, expect.any(Function));
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('uses the canonical SQL and post-filter for every item before issuing a short receipt', async () => {
    const { prisma } = db([{ id: itemId, clientId }]);
    const request = callback(clientId, [{ memoryItemId: itemId, recordSha256: hash }]);
    const receipt = await checkPassiveMemoryEligibility(prisma as never, ctx, request, () => nowMs);
    expect(canonicalMemoryEligibilitySql).toHaveBeenCalledWith({
      tenantId, userId: actorId, allowedClientIds: [clientId], memoryItemId: itemId,
    });
    expect(includeCanonicalGovernedMemoryRow).toHaveBeenCalled();
    expect(receipt).toMatchObject({ resultSha256: hash, records: [{ memoryItemId: itemId,
      recordSha256: hash, eligibleForRecall: true }], checkedAtMs: nowMs,
      expiresAtMs: nowMs + 5_000 });
    expect(receipt).not.toHaveProperty('input');
  });

  it('refuses a row changed after the page read and keeps personal scope client-free', async () => {
    const absent = db();
    await expect(checkPassiveMemoryEligibility(absent.prisma as never, ctx,
      callback(clientId, [{ memoryItemId: itemId, recordSha256: hash }]), () => nowMs))
      .rejects.toThrow(ForbiddenException);
    const foreign = db([{ id: itemId, clientId }]);
    await expect(checkPassiveMemoryEligibility(foreign.prisma as never, ctx,
      callback(null, [{ memoryItemId: itemId, recordSha256: hash }]), () => nowMs))
      .rejects.toThrow(ForbiddenException);
  });
});
