import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { canonicalSha256, sha256Hex } from '../../auth/read-delegation/read-delegation.contract.js';
import type { MeriReadDelegationGrant } from '../../auth/read-delegation/read-delegation-request.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { GovernedMemoryCandidateService } from '../../memory/governed-memory-candidate.service.js';

jest.mock('../../memory/memory-wall.helpers.js', () => ({
  clientMemoryAllowed: jest.fn(async () => true),
}));
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { admitSignedMemoryProposalPage, receiveSignedMemoryProposalPage,
  SIGNED_MEMORY_PROPOSAL_PATH } from './meri-memory-proposal-receiver.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';
const runId = '55555555-5555-4555-8555-555555555555';
const attemptId = '66666666-6666-4666-8666-666666666666';
const workerId = '77777777-7777-4777-8777-777777777777';
const policyRevision = 'a'.repeat(64);
const nowMs = 1_792_000_000_000;
const ctx = { tenantId, userId: actorId, role: 'standard_user' } as TenantContext;
const input = { clientId, cursor: null, limit: 5 };
const wire = { input, metadata: null };
const correlation = () => ({
  binding: { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 2 },
  subject: { kind: 'client', entityType: 'client', entityIds: [clientId], tenantId, actorId,
    authorizationDecisionId: '88888888-8888-4888-8888-888888888888', policyRevision,
    scopes: [{ tenantId, kind: 'client', resourceId: clientId, policyRevision }], rosterVersionId: null },
  policyRevision, normalizationContext: null,
});
function grant(): MeriReadDelegationGrant {
  return { delegationId: '99999999-9999-4999-8999-999999999999', mode: 'attended', tenantId, actorId,
    clientId, conversationId, runId,
    binding: { tenantId, actorId, conversationId, runId, attemptId, writerFence: 2 },
    admittedBinding: { tenantId, actorId, conversationId, runId, attemptId, workerId, writerFence: 2 },
    policyRevision, correlationSha256: canonicalSha256(correlation()),
    argumentsSha256: canonicalSha256(input), bodySha256: sha256Hex(JSON.stringify(wire)),
    callKey: 'invocation_1', kind: 'tool', operation: { id: 'memory.list_own_proposals', version: '0.2.0' },
    toolRequestSha256: null, referenceSha256: null, jti: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    hardExpiryMs: nowMs + 5_000 };
}
const row = (id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt = '2026-10-18T12:00:00.000Z') => ({
  id, scope: 'client', clientId, sourceKind: 'user_chat', status: 'pending', createdAt,
  decidedAt: null, restricted: false,
  proposal: { key: 'Preference', value: 'Use SMS', canonicalItem: null }, capabilities: { withdraw: true },
});
function deps(rows: unknown[] = [row()], enabled = true, nextCursor: string | null = null) {
  const prisma = { withTenantUser: jest.fn(async (_tenant: string, _actor: string,
    action: (tx: object) => Promise<unknown>) => action({})) };
  const owner = { listOwnProposals: jest.fn(async () => ({ enabled, candidates: rows, nextCursor })) };
  const releaseDelegatedRead = jest.fn(async () => undefined);
  return { prisma: prisma as unknown as Pick<PrismaService, 'withTenantUser'>,
    owner: owner as unknown as Pick<GovernedMemoryCandidateService, 'listOwnProposals'>,
    releaseDelegatedRead };
}

describe('unmounted signed proposal receiver for Meri PR172', () => {
  it('pins its exact dotted path, original reservation and frozen body/correlation', () => {
    expect(SIGNED_MEMORY_PROPOSAL_PATH).toBe('/api/clio/tools/memory.list_own_proposals');
    expect(admitSignedMemoryProposalPage(ctx, wire, grant(), correlation(), true, nowMs)).toEqual({
      selection: input, requestSha256: canonicalSha256(wire), hardExpiryMs: nowMs + 5_000,
    });
    const changed = grant(); changed.operation = { id: 'list_memory_proposals', version: '0.2.0' };
    expect(() => admitSignedMemoryProposalPage(ctx, wire, changed, correlation(), true, nowMs)).toThrow(ForbiddenException);
    changed.operation = { id: 'memory.list_own_proposals', version: '0.2.0' };
    changed.callKey = 'wrong key';
    expect(() => admitSignedMemoryProposalPage(ctx, wire, changed, correlation(), true, nowMs)).toThrow(ForbiddenException);
  });

  it('refuses wrong service, selected client, metadata, hashes, binding and subject', () => {
    const admit = (body: unknown = wire, held: MeriReadDelegationGrant = grant(),
      signed: unknown = correlation(), service = true) =>
      admitSignedMemoryProposalPage(ctx, body, held, signed, service, nowMs);
    expect(() => admit(wire, grant(), correlation(), false)).toThrow(ForbiddenException);
    expect(() => admit({ input, metadata: {} })).toThrow(ForbiddenException);
    expect(() => admit({ input: { ...input, clientId: actorId }, metadata: null })).toThrow(ForbiddenException);
    expect(() => admit({ input: { ...input, limit: 6 }, metadata: null })).toThrow(ForbiddenException);
    const wrongBody = grant(); wrongBody.bodySha256 = 'f'.repeat(64);
    expect(() => admit(wire, wrongBody)).toThrow(ForbiddenException);
    const wrongArg = grant(); wrongArg.argumentsSha256 = 'f'.repeat(64);
    expect(() => admit(wire, wrongArg)).toThrow(ForbiddenException);
    const wrongCorrelation = correlation(); wrongCorrelation.binding.workerId = actorId;
    const matchedCorrelation = grant(); matchedCorrelation.correlationSha256 = canonicalSha256(wrongCorrelation);
    expect(() => admit(wire, matchedCorrelation, wrongCorrelation)).toThrow(ForbiddenException);
    const wrongSubject = correlation(); wrongSubject.subject.scopes[0]!.resourceId = actorId;
    const matchedSubject = grant(); matchedSubject.correlationSha256 = canonicalSha256(wrongSubject);
    expect(() => admit(wire, matchedSubject, wrongSubject)).toThrow(ForbiddenException);
    expect(() => admit(wire, grant(), { ...correlation(), normalizationContext: { tenantId, userId: actorId } }))
      .toThrow(ForbiddenException);
    expect(() => admit(wire, grant(), correlation(), true)).not.toThrow();
  });

  it('reads the canonical owner behind two current walls and releases only after validating the page', async () => {
    jest.mocked(clientMemoryAllowed).mockResolvedValue(true);
    const d = deps();
    const result = await receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...d, now: () => nowMs });
    expect(result).toMatchObject({ tool: 'list_memory_proposals', enabled: true,
      scope: { tenantId, userId: actorId, clientId }, candidates: [{ id: row().id }] });
    expect(d.prisma.withTenantUser).toHaveBeenCalledTimes(2);
    expect(clientMemoryAllowed).toHaveBeenCalledTimes(2);
    expect(d.releaseDelegatedRead).toHaveBeenCalledTimes(1);
    expect(d.owner.listOwnProposals).toHaveBeenCalledTimes(1);
  });

  it('withholds content if the second wall or pre-byte release fails', async () => {
    jest.mocked(clientMemoryAllowed).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const d = deps();
    await expect(receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...d, now: () => nowMs })).rejects.toThrow(ForbiddenException);
    expect(d.releaseDelegatedRead).not.toHaveBeenCalled();
    jest.mocked(clientMemoryAllowed).mockResolvedValue(true);
    const after = deps(); after.releaseDelegatedRead.mockRejectedValueOnce(new Error('changed'));
    await expect(receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...after, now: () => nowMs })).rejects.toThrow('changed');
  });

  it('rejects invalid owner output and does not perform a pre-byte release', async () => {
    jest.mocked(clientMemoryAllowed).mockResolvedValue(true);
    const unordered = deps([row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-10-18T12:00:00.000Z'),
      row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-10-18T13:00:00.000Z')]);
    await expect(receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...unordered, now: () => nowMs })).rejects.toThrow(ForbiddenException);
    expect(unordered.releaseDelegatedRead).not.toHaveBeenCalled();
    const disabledWithRows = deps([row()], false);
    await expect(receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...disabledWithRows, now: () => nowMs })).rejects.toThrow(ForbiddenException);
    expect(disabledWithRows.releaseDelegatedRead).not.toHaveBeenCalled();
    const invalidDate = deps([row(undefined, '2026-02-30T12:00:00.000Z')]);
    await expect(receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...invalidDate, now: () => nowMs })).rejects.toThrow(ForbiddenException);
    expect(invalidDate.releaseDelegatedRead).not.toHaveBeenCalled();
    const restricted = deps([{ ...row(), restricted: true, proposal: null }]);
    const result = await receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...restricted, now: () => nowMs });
    expect(result.candidates[0]).toMatchObject({ restricted: true, proposedText: null });
  });

  it('withholds output on expiry during the owner read or after the release check', async () => {
    jest.mocked(clientMemoryAllowed).mockResolvedValue(true);
    const before = deps();
    let reads = 0;
    await expect(receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...before, now: () => (++reads <= 2 ? nowMs : nowMs + 5_000) })).rejects.toThrow(ForbiddenException);
    expect(before.releaseDelegatedRead).not.toHaveBeenCalled();
    const after = deps(); let stamp = nowMs;
    after.releaseDelegatedRead.mockImplementationOnce(async () => { stamp += 5_000; });
    await expect(receiveSignedMemoryProposalPage({ ctx, raw: wire, grant: grant(),
      authenticatedCorrelation: correlation(), verifiedServiceIdentity: true,
      ...after, now: () => stamp })).rejects.toThrow(ForbiddenException);
    expect(after.releaseDelegatedRead).toHaveBeenCalledTimes(1);
  });
});
