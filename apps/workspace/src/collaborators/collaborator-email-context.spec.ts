import { NotFoundException } from '@nestjs/common';
import { CollaboratorsService } from './collaborators.service.js';
import { draftClientSourceAccess } from '../drafts/draft-client-access.js';
import { prospectDraftSourceAccess, withProspectDraft } from '../prospect-resources/prospect-draft-access.js';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../drafts/draft-client-access.js', () => ({ draftClientSourceAccess: jest.fn() }));
jest.mock('../prospect-resources/prospect-draft-access.js', () => ({
  prospectDraftSourceAccess: jest.fn(), withProspectDraft: jest.fn(),
}));

const tenant = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const invitationId = '33333333-3333-4333-8333-333333333333';
function fixture() {
  const draft = { id: draftId, tenantId: tenant, ownerId: 'owner', docTitle: 'Saved title', prospectId: null, clientId: null, client: null, config: {} };
  const invitation: any = { id: invitationId, tenantId: tenant, draftId, subjectId: 'recipient', invitedById: 'owner', role: 'reviewer', status: 'pending', updatedAt: new Date('2026-10-26T00:00:00Z') };
  const state = { invitation: invitation as any, sourceRows: [] as any[], members: [
    { subjectId: 'owner', email: 'owner@example.test', name: 'Saved author' },
    { subjectId: 'recipient', email: 'recipient@example.test', name: 'Saved recipient' },
  ] };
  const prisma: any = { wsDraft: { findFirst: jest.fn(async ({ where }) => where.tenantId === tenant ? draft : null) },
    wsCollaborator: { findFirst: jest.fn(async ({ where }) => where.subjectId ? null : state.invitation) },
    $queryRaw: jest.fn(async () => state.sourceRows), withSystem: jest.fn(async fn => fn({ $queryRaw: async () => state.members })) };
  (draftClientSourceAccess as jest.Mock).mockResolvedValue(true);
  (prospectDraftSourceAccess as jest.Mock).mockResolvedValue(true);
  (withProspectDraft as jest.Mock).mockImplementation(async (db, _draft, _actor, _policy, _mode, operation) => operation(db));
  const service = new CollaboratorsService(prisma, {} as never);
  return { service, state, draft, invitation, prisma };
}
afterEach(() => jest.clearAllMocks());

describe('canonical ordinary invitation mail context', () => {
  it('derives only saved invitation/member content through both current source checks', async () => {
    const f = fixture();
    expect(await f.service.emailContext(tenant, draftId, invitationId, 'owner')).toMatchObject({ tenantId: tenant, draftId, invitationId, actorId: 'owner',
      invitation: { recipientId: 'recipient', title: 'Saved title', authorName: 'Saved author', email: 'recipient@example.test' } });
    expect((draftClientSourceAccess as jest.Mock).mock.calls.map(c => c[2])).toEqual(['owner', 'recipient']);
    expect((prospectDraftSourceAccess as jest.Mock).mock.calls.map(c => c[2])).toEqual(['owner', 'recipient']);
    expect(withProspectDraft).toHaveBeenCalledWith(f.prisma, f.draft, 'owner', expect.any(Function), 'read', expect.any(Function));
    expect(f.prisma.wsCollaborator.findFirst).toHaveBeenCalledWith({ where: { id: invitationId, tenantId: tenant, draftId } });
  });
  it.each(['owner', 'recipient'])('retains current client/membership refusal for %s', async actor => {
    const f = fixture(); (draftClientSourceAccess as jest.Mock).mockImplementation(async (_db, _draft, who) => who !== actor);
    if (actor === 'owner') await expect(f.service.emailContext(tenant, draftId, invitationId, 'owner')).rejects.toBeInstanceOf(NotFoundException);
    else expect(await f.service.emailContext(tenant, draftId, invitationId, 'owner')).toMatchObject({ invitation: null, reason: 'RecipientAccessUnavailable' });
    expect(f.prisma.withSystem).not.toHaveBeenCalled();
  });
  it('retains prospect/current brief checks and private research source isolation', async () => {
    const f = fixture(); (withProspectDraft as jest.Mock).mockRejectedValueOnce(new NotFoundException());
    await expect(f.service.emailContext(tenant, draftId, invitationId, 'owner')).rejects.toThrow();
    const g = fixture(); g.state.sourceRows = [{ source_key: 'private-research', owner_id: 'different-owner', source_type: 'legiwatch_research' }];
    await expect(g.service.emailContext(tenant, draftId, invitationId, 'owner')).rejects.toThrow();
    expect(g.prisma.withSystem).not.toHaveBeenCalled();
  });
  it('refuses another tenant/non-owner and unresolved external recipients', async () => {
    const f = fixture();
    await expect(f.service.emailContext(draftId, draftId, invitationId, 'owner')).rejects.toThrow();
    await expect(f.service.emailContext(tenant, draftId, invitationId, 'other')).rejects.toThrow();
    f.invitation.subjectId = null;
    expect(await f.service.emailContext(tenant, draftId, invitationId, 'owner')).toMatchObject({ invitation: null, reason: 'ExternalRecipientUnsupported' });
    expect(f.prisma.withSystem).not.toHaveBeenCalled();
  });
  it('holds inactive recipients and accepted invitations; removal keeps only authorized identity', async () => {
    const f = fixture(); f.state.members = f.state.members.slice(0, 1);
    expect(await f.service.emailContext(tenant, draftId, invitationId, 'owner')).toMatchObject({ invitation: null, reason: 'RecipientAccessUnavailable' });
    f.invitation.status = 'active';
    expect(await f.service.emailContext(tenant, draftId, invitationId, 'owner')).toMatchObject({ invitation: null, reason: 'InvitationNotPending' });
    f.state.invitation = null;
    expect(await f.service.emailContext(tenant, draftId, invitationId, 'owner')).toMatchObject({ invitation: null, reason: 'InvitationUnavailable' });
  });
});
