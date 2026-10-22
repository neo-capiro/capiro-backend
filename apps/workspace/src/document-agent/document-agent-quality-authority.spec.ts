import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import type { ResolvedRole } from '../collaborators/role-policy.js';
import { DocumentAgentController } from './document-agent.controller.js';
import { DocumentAgentQualityService } from './document-agent-quality.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const draftId = '22222222-2222-4222-8222-222222222222';
const request = {
  tenantId,
  draftId,
  issueId: 'agent:required_sections',
  createdById: 'trusted-actor',
  baseRevision: 7,
  baseHash: 'saved-outline-hash',
  instruction: 'Add the required section',
};

function fixture(role: ResolvedRole) {
  const events: string[] = [];
  const prisma = {
    wsDraft: {
      findFirst: jest.fn(async () => {
        events.push('origin');
        return { prospectId: null as string | null } as { prospectId: string | null } | null;
      }),
    },
    wsAgentProposal: {
      create: jest.fn(async () => {
        events.push('proposal');
        return { id: 'proposal-id' };
      }),
    },
  };
  const collaborators = new CollaboratorsService(prisma as never, {} as never);
  // The joined HTTP fixture separately exercises real resolveRole, including
  // membership, client/source and held-draft checks. This isolates the existing
  // admission and canEdit predicates, and pins reads/writes after those gates.
  const resolveRole = jest.spyOn(collaborators, 'resolveRole').mockImplementation(async () => {
    events.push('admit');
    return role;
  });
  const service = new DocumentAgentQualityService(prisma as never, {} as never, collaborators);
  const controller = new DocumentAgentController({} as never, service);
  return { prisma, collaborators, resolveRole, service, controller, events };
}

describe('quality fix proposal draft authority', () => {
  it('conceals an unrelated same-tenant draft before an origin read or proposal write', async () => {
    const h = fixture(null);
    await expect(h.service.createFixProposal(request)).rejects.toMatchObject({
      status: 404,
      response: { message: 'Draft not found' },
    });
    expect(h.resolveRole).toHaveBeenCalledWith(tenantId, draftId, 'trusted-actor', undefined);
    expect(h.events).toEqual(['admit']);
    expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.wsAgentProposal.create).not.toHaveBeenCalled();
  });

  it('requires a trusted actor rather than entering an internal write path', async () => {
    const h = fixture('owner');
    await expect(h.service.createFixProposal({ ...request, createdById: '' }))
      .rejects.toMatchObject({ status: 404 });
    expect(h.resolveRole).not.toHaveBeenCalled();
    expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.wsAgentProposal.create).not.toHaveBeenCalled();
  });

  it.each(['reviewer', 'commenter', 'viewer'] as const)(
    'refuses %s creation before a descendant read or write', async role => {
      const h = fixture(role);
      await expect(h.service.createFixProposal(request)).rejects.toMatchObject({ status: 403 });
      expect(h.events).toEqual(['admit']);
      expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
      expect(h.prisma.wsAgentProposal.create).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'editor'] as const)('preserves %s creation after admission', async role => {
    const h = fixture(role);
    await expect(h.service.createFixProposal(request)).resolves.toEqual({ proposalId: 'proposal-id' });
    expect(h.events).toEqual(['admit', 'origin', 'proposal']);
    expect(h.prisma.wsDraft.findFirst).toHaveBeenCalledWith({
      where: { tenantId, id: draftId },
      select: { prospectId: true },
    });
    expect(h.prisma.wsAgentProposal.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.wsAgentProposal.create).toHaveBeenCalledWith({
      data: {
        tenantId,
        draftId,
        createdById: 'trusted-actor',
        type: 'quality_fix:agent:required_sections',
        status: 'pending',
        baseRevision: 7,
        baseHash: 'saved-outline-hash',
        payload: { issueId: request.issueId, instruction: request.instruction },
      },
    });
  });

  it.each(['owner', 'editor'] as const)('keeps prospect transfer refused for %s', async role => {
    const h = fixture(role);
    h.prisma.wsDraft.findFirst.mockResolvedValue({ prospectId: 'prospect-id' });
    await expect(h.service.createFixProposal(request)).rejects.toMatchObject({
      status: 403,
      response: { code: 'PROSPECT_RESOURCE_TRANSFER_UNSUPPORTED' },
    });
    expect(h.prisma.wsAgentProposal.create).not.toHaveBeenCalled();
  });

  it('does not write if the admitted parent has disappeared', async () => {
    const h = fixture('owner');
    h.prisma.wsDraft.findFirst.mockResolvedValue(null);
    await expect(h.service.createFixProposal(request)).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.wsAgentProposal.create).not.toHaveBeenCalled();
  });

  it('rechecks authority on a subsequent attempt instead of retaining the earlier role', async () => {
    const h = fixture('editor');
    await h.service.createFixProposal(request);
    h.resolveRole.mockResolvedValue(null);
    h.prisma.wsDraft.findFirst.mockClear();
    h.prisma.wsAgentProposal.create.mockClear();
    await expect(h.service.createFixProposal(request)).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.wsDraft.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.wsAgentProposal.create).not.toHaveBeenCalled();
  });

  it('uses the controller identity rather than a forged body actor', async () => {
    const h = fixture('reviewer');
    const body = { expectedRevision: 7, instruction: 'Fix it', createdById: 'draft-owner' };
    await expect(h.controller.fixIssue(
      { tenantId, clerkUserId: 'trusted-reviewer' } as never,
      draftId,
      request.issueId,
      body,
    )).rejects.toMatchObject({ status: 403 });
    expect(h.resolveRole).toHaveBeenCalledWith(tenantId, draftId, 'trusted-reviewer', undefined);
    expect(h.prisma.wsAgentProposal.create).not.toHaveBeenCalled();
  });
});
