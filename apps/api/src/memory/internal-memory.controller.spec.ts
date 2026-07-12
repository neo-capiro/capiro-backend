import { BadRequestException } from '@nestjs/common';
import { InternalMemoryController } from './internal-memory.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryCandidateService } from './memory-candidate.service.js';

/**
 * Phase 3.4 — the internal memory write-back endpoint. The InternalServiceGuard
 * itself is covered by internal-service.guard.spec.ts; here we prove the
 * controller resolves the Clerk identity, fails closed on an unknown user, and
 * delegates to the REAL candidate lifecycle as a firm-scope, non-admin,
 * workspace-tagged proposal (never a raw insert, never auto-committed).
 */
function makeController(user: { id: string } | null) {
  const proposeSaveMemory = jest.fn(async () => ({
    candidateId: 'cand-1',
    status: 'pending' as const,
    memoryId: null,
    ruleId: 'firm-review',
    reason: 'firm scope needs review',
  }));
  const prisma = {
    user: { findUnique: jest.fn(async () => user) },
  } as unknown as PrismaService;
  const candidates = { proposeSaveMemory } as unknown as MemoryCandidateService;
  const controller = new InternalMemoryController(prisma, candidates);
  return { controller, proposeSaveMemory };
}

const BODY = {
  tenantId: 't1',
  clerkUserId: 'clerk_1',
  key: 'workspace-artifact:draft-9',
  value: 'The firm supports the FY27 plus-up for PE 0603851F.',
};

describe('InternalMemoryController.createCandidate', () => {
  it('fails closed (400) when the Clerk identity has no Capiro user', async () => {
    const { controller, proposeSaveMemory } = makeController(null);
    await expect(controller.createCandidate(BODY as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(proposeSaveMemory).not.toHaveBeenCalled();
  });

  it('delegates to proposeSaveMemory as a firm-scope, non-admin, workspace_artifact proposal', async () => {
    const { controller, proposeSaveMemory } = makeController({ id: 'user-9' });
    const res = await controller.createCandidate(BODY as never);

    expect(proposeSaveMemory).toHaveBeenCalledWith(
      't1',
      'user-9',
      { scope: 'firm', ownerUserId: null, key: BODY.key, value: BODY.value, source: 'workspace' },
      false, // never admin → firm-scope candidate is ALWAYS reviewable, never auto-committed
      'workspace_artifact',
    );
    expect(res).toEqual({ candidateId: 'cand-1', status: 'pending' });
  });
});
