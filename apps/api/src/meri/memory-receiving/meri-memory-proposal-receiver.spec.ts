import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { GovernedMemoryCandidateService } from '../../memory/governed-memory-candidate.service.js';

jest.mock('../../memory/memory-wall.helpers.js', () => ({
  clientMemoryAllowed: jest.fn(async () => true),
}));
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { receiveMemoryProposalPage, MEMORY_PROPOSAL_OPERATION } from './meri-memory-proposal-receiver.js';

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
    policyRevision,
    scopes: [{ tenantId, kind: 'client', resourceId: clientId, policyRevision }], rosterVersionId: null },
  policyRevision, normalizationContext: null,
});
const row = (id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', createdAt = '2026-10-18T12:00:00.000Z') => ({
  id, scope: 'client', clientId, sourceKind: 'user_chat', status: 'pending', createdAt,
  decidedAt: null, restricted: false,
  proposal: { key: 'Preference', value: 'Use SMS', canonicalItem: null }, capabilities: { withdraw: true },
});
function deps(rows: unknown[] = [row()], enabled = true, nextCursor: string | null = null) {
  const prisma = { withTenantUser: jest.fn(async (_tenant: string, _actor: string,
    action: (tx: object) => Promise<unknown>) => action({})) };
  const owner = { listOwnProposals: jest.fn(async () => ({ enabled, candidates: rows, nextCursor })) };
  return { prisma: prisma as unknown as Pick<PrismaService, 'withTenantUser'>,
    owner: owner as unknown as Pick<GovernedMemoryCandidateService, 'listOwnProposals'> };
}

const receive = (d = deps(), raw: unknown = wire, held: unknown = correlation(),
  verifiedServiceIdentity = true, now = () => nowMs) => receiveMemoryProposalPage({
    ctx, raw, correlation: held, verifiedServiceIdentity, deadlineMs: nowMs + 5_000, ...d, now,
  });

describe('ordinary memory proposal receiver', () => {
  beforeEach(() => { jest.clearAllMocks(); jest.mocked(clientMemoryAllowed).mockResolvedValue(true); });

  it('pins its reserved operation and reads the canonical owner behind current walls', async () => {
    expect(MEMORY_PROPOSAL_OPERATION).toEqual({ id: 'memory.list_own_proposals', version: '0.2.0' });
    const d = deps();
    expect(await receive(d)).toMatchObject({ tool: 'list_memory_proposals', enabled: true,
      scope: { tenantId, userId: actorId, clientId }, candidates: [{ id: row().id }] });
    expect(d.prisma.withTenantUser).toHaveBeenCalledTimes(2);
    expect(clientMemoryAllowed).toHaveBeenCalledTimes(2);
    expect(d.owner.listOwnProposals).toHaveBeenCalledWith(ctx, { clientId, limit: 5, status: 'pending' });
  });

  it('refuses wrong service, selected client, actor, metadata, scope or normalization before owner access', async () => {
    const wrongScope = correlation(); wrongScope.subject.scopes[0]!.resourceId = actorId;
    const wrongActor = correlation(); wrongActor.binding.actorId = clientId;
    for (const [raw, held, verified] of [
      [wire, correlation(), false],
      [{ input, metadata: {} }, correlation(), true],
      [{ input: { ...input, clientId: actorId }, metadata: null }, correlation(), true],
      [{ input: { ...input, limit: 11 }, metadata: null }, correlation(), true],
      [wire, wrongScope, true], [wire, wrongActor, true],
      [wire, { ...correlation(), normalizationContext: { tenantId, userId: actorId } }, true],
    ] as const) {
      const d = deps();
      await expect(receive(d, raw, held, verified)).rejects.toThrow(ForbiddenException);
      expect(d.owner.listOwnProposals).not.toHaveBeenCalled();
    }
  });

  it('withholds content when access changes during the canonical owner read', async () => {
    jest.mocked(clientMemoryAllowed).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const d = deps();
    await expect(receive(d)).rejects.toThrow(ForbiddenException);
    expect(d.owner.listOwnProposals).toHaveBeenCalledTimes(1);
    expect(d.prisma.withTenantUser).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid owner order, disabled rows, invalid dates and duplicate identifiers', async () => {
    for (const d of [
      deps([row('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '2026-10-18T12:00:00.000Z'),
        row('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '2026-10-18T13:00:00.000Z')]),
      deps([row()], false), deps([row(undefined, '2026-02-30T12:00:00.000Z')]), deps([row(), row()]),
    ]) await expect(receive(d)).rejects.toThrow(ForbiddenException);
  });

  it('redacts restricted proposals and preserves bounded continuation without claiming full coverage', async () => {
    expect((await receive(deps([{ ...row(), restricted: true, proposal: null }]))).candidates[0])
      .toMatchObject({ restricted: true, proposedText: null });
    const next = { input: { ...input, cursor: 'opaque-next' }, metadata: null };
    expect(await receive(deps([]), next)).toMatchObject({ coverage: { firstPage: false, complete: false } });
    await expect(receive(deps([row()], true, 'opaque-next'), next)).rejects.toThrow(ForbiddenException);
  });

  it('refuses expired input and withholds a page that expires during retrieval', async () => {
    const expired = deps();
    await expect(receive(expired, wire, correlation(), true, () => nowMs + 5_000))
      .rejects.toThrow(ForbiddenException);
    expect(expired.owner.listOwnProposals).not.toHaveBeenCalled();
    let stamp = nowMs;
    const d = deps();
    jest.mocked(d.owner.listOwnProposals).mockImplementationOnce(async () => {
      stamp += 5_000;
      return { enabled: true, candidates: [row()], nextCursor: null } as never;
    });
    await expect(receive(d, wire, correlation(), true, () => stamp)).rejects.toThrow(ForbiddenException);
    expect(d.owner.listOwnProposals).toHaveBeenCalledTimes(1);
  });
});
