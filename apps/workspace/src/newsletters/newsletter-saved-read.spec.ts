// These write/render validators are not used by the saved-read methods. A call
// is a test failure; permission and source-client admission remain real.
jest.mock('./newsletter-validation.js', () => ({
  sanitizeNewsletterHtml: () => {
    throw new Error('No render allowed');
  },
  validateNewsletterConfig: () => {
    throw new Error('No write allowed');
  },
  validateNewsletterDesign: () => {
    throw new Error('No write allowed');
  },
  validateNewsletterSurveyDefinition: () => {
    throw new Error('No write allowed');
  },
}));
jest.mock('./newsletter-link-preview.service.js', () => ({
  NewsletterLinkPreviewService: class {},
}));
jest.mock('./newsletter-video.service.js', () => ({ NewsletterVideoService: class {} }));
import { NewsletterService } from './newsletter.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
function fixture() {
  const state = { member: true, grant: true, wall: true };
  const row = {
    id,
    tenantId,
    name: 'Full saved newsletter',
    ownerId: 'user_owner',
    revision: 7,
    status: 'draft',
    updatedAt: new Date('2026-10-26T00:00:00Z'),
    design: { sourceClientIds: [clientId], sections: [] },
    config: { clientId, subject: 'Saved subject' },
  };
  const prisma = {
    wsNewsletterDocument: {
      findFirst: jest.fn(async () => row),
      findMany: jest.fn(async () => [row]),
    },
    wsNewsletterReviewer: {
      findFirst: jest.fn(async () => (state.grant ? { role: 'editor' } : null)),
    },
    wsNewsletterInvitation: {
      findMany: jest.fn(async () => {
        throw new Error('No invitation reads/activation allowed');
      }),
    },
  };
  const source = {
    newsletterMember: jest.fn(async () =>
      state.member ? { email: 'synthetic@example.test' } : null,
    ),
    resolveUserId: jest.fn(async () => 'internal-user'),
    getClient: jest.fn(async () => ({ wallAllowed: state.wall })),
  };
  const service = new NewsletterService(prisma as never, source as never, {} as never, {} as never);
  const activate = jest
    .spyOn(service as never, 'activateInvitations' as never)
    .mockImplementation((async () => undefined) as never);
  return { state, row, prisma, source, service, activate };
}
describe('newsletter saved state without invitation activation', () => {
  it('returns the full saved design/config/revision through current editor and client authority', async () => {
    const h = fixture();
    const result = await h.service.getSaved({ tenantId, clerkUserId: 'user_editor' }, id);
    expect(result).toEqual({
      id,
      name: h.row.name,
      ownerId: 'user_owner',
      revision: 7,
      status: 'draft',
      updatedAt: h.row.updatedAt.toISOString(),
      design: h.row.design,
      config: h.row.config,
    });
    expect(h.source.getClient).toHaveBeenCalledWith(tenantId, 'internal-user', clientId);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it('does not let an unaccepted invitation become saved-read authority', async () => {
    const h = fixture();
    h.state.grant = false;
    await expect(
      h.service.getSaved({ tenantId, clerkUserId: 'user_pending' }, id),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.prisma.wsNewsletterInvitation.findMany).not.toHaveBeenCalled();
    // Existing authoring GET still owns its prior invitation activation path.
    await expect(
      h.service.get({ tenantId, clerkUserId: 'user_pending' }, id),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.activate).toHaveBeenCalledTimes(1);
  });
  it.each(['member', 'wall'] as const)(
    'refuses saved content after current %s is revoked',
    async (key) => {
      const h = fixture();
      h.state[key] = false;
      await expect(
        h.service.getSaved({ tenantId, clerkUserId: 'user_owner' }, id),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.activate).not.toHaveBeenCalled();
    },
  );
  it('lists only the existing owner/editor candidate scope and never scans invitations', async () => {
    const h = fixture();
    await expect(
      h.service.listSaved({ tenantId, clerkUserId: 'user_owner' }),
    ).resolves.toMatchObject({ items: [{ id, design: h.row.design, config: h.row.config }] });
    expect(h.prisma.wsNewsletterDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
        where: {
          tenantId,
          OR: [
            { ownerId: 'user_owner' },
            { reviewers: { some: { tenantId, userId: 'user_owner', role: 'editor' } } },
          ],
        },
      }),
    );
    expect(h.prisma.wsNewsletterInvitation.findMany).not.toHaveBeenCalled();
    expect(h.activate).not.toHaveBeenCalled();
  });
});
