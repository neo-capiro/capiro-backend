import { LegiwatchRelevanceActionService } from './legiwatch-relevance-action.service.js';
import type { LegiwatchActionService } from './legiwatch-action.service.js';
import type { MeriActionProposalService } from './meri-action-proposal.service.js';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
// Adapter ports are doubled here; their actual authority/claim owners have the
// retained mounted/current and governed-proposal checks.
jest.mock('./legiwatch-action.service.js', () => ({ LegiwatchActionService: class {} }));
jest.mock('./meri-action-proposal.service.js', () => ({ MeriActionProposalService: class {} }));
const id = '20000000-0000-4000-8000-000000000001';
const context = { conversationId: id, selectedClientId: null };
const scope = {
  ...context,
  identityRevision: 'a'.repeat(64),
  membershipRevision: 'b'.repeat(64),
  contextRevision: 'c'.repeat(64),
};
const request = {
  clientId: null,
  folderId: id,
  jurisdiction: 'US',
  sessionKey: '119',
  fields: ['title'],
  billId: 'hr1-119',
  explanation: 'Client relevance',
  documentId: 'hr1-119:title',
  start: 0,
  end: 4,
  quote: 'bill',
  previewHash: 'a'.repeat(64),
  requestKey: 'synthetic-request',
};
function fixture() {
  const access = { scope, assertCurrent: jest.fn().mockResolvedValue(undefined) };
  const current = { access: jest.fn().mockResolvedValue(access) };
  const proposals = {
    create: jest
      .fn()
      .mockResolvedValue({ disposition: 'pending_approval', proposal: { proposalId: id } }),
    readLegiwatch: jest.fn().mockResolvedValue({ request, status: 'proposed' }),
    approveAndExecute: jest.fn(),
    dismiss: jest.fn(),
  };
  const owner = new LegiwatchRelevanceActionService(
    current as unknown as LegiwatchActionService,
    proposals as unknown as MeriActionProposalService,
  );
  return { owner, current, proposals, access, ctx: {} as TenantContext, req: {} as Request };
}
describe('relevance fixed action adapter', () => {
  it('passes exact immutable evidence through existing current access and explicit approval owner', async () => {
    const f = fixture();
    await f.owner.prepare(f.ctx, f.req, { version: 1, context, request });
    expect(f.current.access).toHaveBeenCalledWith(f.ctx, f.req, context, null);
    const { clientId: _client, ...input } = request;
    expect(f.proposals.create).toHaveBeenCalledWith(
      f.ctx,
      {
        tool: 'save_legiwatch_relevance',
        input,
        conversationId: id,
        surface: 'chat',
        requireApproval: true,
      },
      undefined,
      f.access,
    );
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
    expect(f.access.assertCurrent).toHaveBeenCalled();
  });
  it('rejects partial quotes before authority and withholds after current access changes', async () => {
    const f = fixture();
    await expect(
      f.owner.prepare(f.ctx, f.req, { version: 1, context, request: { ...request, end: 3 } }),
    ).rejects.toThrow();
    expect(f.current.access).not.toHaveBeenCalled();
    f.access.assertCurrent.mockRejectedValue(new Error('revoked'));
    await expect(f.owner.prepare(f.ctx, f.req, { version: 1, context, request })).rejects.toThrow(
      'revoked',
    );
    expect(f.proposals.readLegiwatch).not.toHaveBeenCalled();
  });
  it('observes UNKNOWN without a decision and refuses cross-operation observations before approval', async () => {
    const f = fixture(),
      observation = { version: 1, context: scope, proposalId: id };
    f.proposals.readLegiwatch.mockResolvedValue({ request, status: 'outcome_unknown' });
    expect((await f.owner.read(f.ctx, f.req, observation)).status).toBe('outcome_unknown');
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
    f.proposals.readLegiwatch.mockResolvedValue({
      request: { suggestionId: id } as unknown as typeof request,
      status: 'proposed',
    });
    await expect(
      f.owner.decide(f.ctx, f.req, { ...observation, decision: 'approved' }),
    ).rejects.toThrow();
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
  });
});
