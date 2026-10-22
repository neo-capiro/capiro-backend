import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { ResolvedRole } from '../collaborators/role-policy.js';
import { DraftsService } from '../drafts/drafts.service.js';
import { DocumentAgentController } from '../document-agent/document-agent.controller.js';
import { DocumentAgentQualityService } from '../document-agent/document-agent-quality.service.js';
import { ChecksService } from './checks.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const surfaces = ['checks', 'anonymize', 'agent-quality'] as const;
type Surface = typeof surfaces[number];

function fixture(role: ResolvedRole) {
  const draft = {
    id: draftId, tenantId, ownerId: 'actor', prospectId: null,
    docTitle: 'Private Acme Labs plan', client: 'Acme Labs', product: null,
    config: {
      client: 'Acme Labs', sections: ['Overview'],
      sectionContent: { Overview: 'Acme Labs develops sensors.' },
    },
    ask: 'n/a', documents: [], updatedAt: new Date('2026-10-21T12:00:00Z'),
  };
  const prisma = { wsDraft: { findFirst: jest.fn(async () => draft) } };
  const collaborators = new CollaboratorsService(prisma as never, {} as never);
  // Exercise the real admission method and role predicates. The HTTP suite
  // separately pins resolveRole's current membership, wall and source queries.
  jest.spyOn(collaborators, 'resolveRole').mockResolvedValue(role);
  const checks = new ChecksService(prisma as never, collaborators);
  const drafts = new DraftsService(prisma as never, collaborators);
  const quality = new DocumentAgentQualityService(prisma as never, checks, collaborators);
  const controller = new DocumentAgentController({} as never, quality);
  const run = (surface: Surface, actorId: string = 'actor') => {
    if (surface === 'checks') return checks.evaluate(tenantId, draftId, actorId);
    if (surface === 'anonymize') return drafts.detectAnonymizeNames(tenantId, draftId, actorId);
    return controller.getQuality({ tenantId, clerkUserId: actorId } as never, draftId);
  };
  return { prisma, run };
}

describe.each(surfaces)('%s draft read admission', surface => {
  it('conceals a same-tenant draft from an unrelated actor before reading content', async () => {
    const h = fixture(null);
    await expect(h.run(surface)).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a missing actor before reading content', async () => {
    const h = fixture('owner');
    // Missing identity must never select an internal tenant-only read path.
    await expect(h.run(surface, '' as string)).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
  });

  it.each(['owner', 'editor', 'reviewer', 'commenter', 'viewer'] as const)(
    'preserves the %s read role and returns the authorized draft content', async role => {
      const h = fixture(role);
      const result = await h.run(surface);
      expect(JSON.stringify(result)).toContain('Acme Labs');
    },
  );
});
