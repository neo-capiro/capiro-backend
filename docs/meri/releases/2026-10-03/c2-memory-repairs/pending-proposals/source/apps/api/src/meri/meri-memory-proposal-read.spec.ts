import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import type { GovernedMemoryCandidateService, OwnedMemoryCandidate } from '../memory/governed-memory-candidate.service.js';
import { readOwnPendingMemoryProposals } from './meri-memory-proposal-read.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111', tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'synthetic', role: 'standard_user',
} satisfies TenantContext;
const clientId = '33333333-3333-4333-8333-333333333333';
const row: OwnedMemoryCandidate = {
  id: '44444444-4444-4444-8444-444444444444', scope: 'client', clientId,
  sourceKind: 'user_chat', status: 'pending', createdAt: '2026-09-26T12:00:00.000Z',
  decidedAt: null, restricted: false, proposal: { key: 'Aster preference', value: 'prefers SMS alerts', canonicalItem: null },
  capabilities: { withdraw: true },
};
function harness(overrides: Record<string, unknown> = {}) {
  const list = jest.fn(async () => ({ enabled: true, candidates: [row], nextCursor: null, ...overrides }));
  return { list, owner: { listOwnProposals: list } as unknown as Pick<GovernedMemoryCandidateService, 'listOwnProposals'> };
}
describe('governed own pending memory read', () => {
  it('reads MA2-like pending text as governance state, never an approved fact or decision', async () => {
    const h = harness(), input = Object.freeze({ clientId, limit: 1, tenantId: 'forged', userId: 'forged', status: 'approved' });
    const result = await readOwnPendingMemoryProposals(ctx, input, h.owner);
    expect(h.list).toHaveBeenCalledWith(ctx, { clientId, limit: 1, status: 'pending' });
    expect(result.scope).toEqual({ tenantId: ctx.tenantId, userId: ctx.userId, clientId });
    expect(result.candidates).toEqual([expect.objectContaining({ id: row.id, status: 'pending', approvedFact: false, proposedText: 'prefers SMS alerts' })]);
    expect(result.claimsAreApprovedFacts).toBe(false);
    expect(result).not.toHaveProperty('records');
    expect(classifyApiToolReadOutcome('list_memory_proposals', result)).toEqual({ kind: 'complete' });
  });
  it('does not equate disabled review with healthy zero', async () => {
    const disabled = await readOwnPendingMemoryProposals(ctx, {}, harness({ enabled: false, candidates: [] }).owner);
    const empty = await readOwnPendingMemoryProposals(ctx, {}, harness({ candidates: [] }).owner);
    expect(classifyApiToolReadOutcome('list_memory_proposals', disabled)).toMatchObject({ kind: 'unavailable' });
    expect(classifyApiToolReadOutcome('list_memory_proposals', empty)).toEqual({ kind: 'empty' });
  });
  it.each([{ nextCursor: 'opaque-next' }, { cursor: 'opaque-prior' }])('does not claim absence from a partial page: %j', async (page) => {
    const h = harness({ candidates: [], ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
    const result = await readOwnPendingMemoryProposals(ctx, page.cursor ? { cursor: page.cursor } : {}, h.owner);
    expect(result.coverage.complete).toBe(false);
    expect(classifyApiToolReadOutcome('list_memory_proposals', result)).toMatchObject({ kind: 'partial' });
  });
  it('preserves wall redaction even if the owner supplied a body on a restricted row', async () => {
    const h = harness({ candidates: [{ ...row, restricted: true }] });
    const result = await readOwnPendingMemoryProposals(ctx, { clientId }, h.owner);
    expect(result.candidates[0]).toMatchObject({ restricted: true, title: null, proposedText: null });
    expect(JSON.stringify(result)).not.toContain('SMS');
    expect(classifyApiToolReadOutcome('list_memory_proposals', result)).toMatchObject({ kind: 'partial' });
  });
  it('bounds canonical sections and marks unread text partial', async () => {
    const h = harness({ candidates: [{ ...row, proposal: { key: null, value: 'incorrect fallback', canonicalItem: {
      type: 'client', slug: 'aster', title: 'Proposed source', sections: [{ key: 'one', heading: 'Preference', owner: 'human', body: 'x'.repeat(2100) }],
    } } }] });
    const result = await readOwnPendingMemoryProposals(ctx, {}, h.owner);
    expect(result.candidates[0].proposedText).toHaveLength(2000);
    expect(result.candidates[0].contentTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('incorrect fallback');
    expect(classifyApiToolReadOutcome('list_memory_proposals', result)).toMatchObject({ kind: 'partial' });
  });
  it('propagates unavailable owner failures without converting them into zero', async () => {
    const h = harness(); h.list.mockRejectedValueOnce(new ServiceUnavailableException('read unavailable'));
    await expect(readOwnPendingMemoryProposals(ctx, {}, h.owner)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(readOwnPendingMemoryProposals(ctx, {})).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it.each(['unknown_role', 'viewer', undefined])('fails closed for non-ordinary role %s', async (role) => {
    const h = harness();
    await expect(readOwnPendingMemoryProposals({ ...ctx, role } as TenantContext, {}, h.owner)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.list).not.toHaveBeenCalled();
  });
  it.each([{ clientId: 'foreign name' }, { clientId: false }, { cursor: 3 }, { cursor: '' }, { limit: 0 }, { limit: 11 }, { limit: '5' }])('rejects malformed input %j before owner access', async (input) => {
    const h = harness();
    await expect(readOwnPendingMemoryProposals(ctx, input, h.owner)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.list).not.toHaveBeenCalled();
  });
  it('rejects terminal/approved rows instead of presenting them as pending', async () => {
    await expect(readOwnPendingMemoryProposals(ctx, {}, harness({ candidates: [{ ...row, status: 'approved' }] }).owner)).rejects.toThrow('owner_status_mismatch');
  });
  it('rejects an out-of-client owner result rather than leaking it into the selected chat', async () => {
    await expect(readOwnPendingMemoryProposals(ctx, { clientId }, harness({ candidates: [{ ...row, clientId: ctx.userId }] }).owner)).rejects.toThrow('owner_scope_mismatch');
  });
  it('rejects forged healthy coverage and mixed approved facts in the typed result', async () => {
    const result = await readOwnPendingMemoryProposals(ctx, {}, harness().owner);
    for (const changed of [
      { ...result, claimsAreApprovedFacts: true },
      { ...result, nextCursor: 'unread' },
      { ...result, candidates: [{ ...result.candidates[0], status: 'approved' }] },
      { ...result, candidates: [{ ...result.candidates[0], restricted: true }] },
    ]) expect(classifyApiToolReadOutcome('list_memory_proposals', changed)).toMatchObject({ kind: 'failed' });
  });
});
