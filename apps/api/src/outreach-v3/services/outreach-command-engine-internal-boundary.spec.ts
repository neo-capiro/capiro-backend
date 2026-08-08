import type { TenantContext } from '@capiro/shared';
import type { CapabilityAuthorizationService } from '../../capabilities/capability-authorization.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { OutreachStateRepository, OutreachSessionRow } from '../persistence/outreach-state.repository.js';
import { OutreachCommandEngineService } from './outreach-command-engine.service.js';

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantSlug: 'test',
  userId: '00000000-0000-4000-8000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
} as TenantContext;

function session(overrides: Partial<OutreachSessionRow> = {}): OutreachSessionRow {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    tenantId: ctx.tenantId,
    createdByUserId: ctx.userId,
    status: 'active',
    currentStateVersion: 1,
    title: null,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
    archivedAt: null,
    ...overrides,
  };
}

describe('OutreachCommandEngineService internal transaction boundary', () => {
  it.each([
    ['different session', session({ id: '00000000-0000-4000-8000-000000000099' })],
    ['different tenant', session({ tenantId: '00000000-0000-4000-8000-000000000098' })],
    ['different owner', session({ createdByUserId: '00000000-0000-4000-8000-000000000097' })],
  ])('rejects a prelocked %s object before idempotency/state access', async (_label, prelockedSession) => {
    const repository = {
      findBatchResult: jest.fn(),
      loadStateVersion: jest.fn(),
    } as unknown as OutreachStateRepository;
    const engine = new OutreachCommandEngineService(
      {} as PrismaService,
      repository,
      {} as CapabilityAuthorizationService,
    );
    const batch = engine.parseNormalizeAndValidateBatch({
      batchId: '00000000-0000-4000-8000-000000000100',
      expectedStateVersion: 1,
      commands: [{ type: 'SET_GOAL', schemaVersion: 1, payload: { value: 'Goal' } }],
    });

    await expect(
      engine.applyBatchWithinTx({} as never, ctx, session().id, batch, { prelockedSession }),
    ).rejects.toMatchObject({
      code: 'OUTREACH_STATE_CORRUPT',
      httpStatus: 500,
    });
    expect((repository as unknown as { findBatchResult: jest.Mock }).findBatchResult).not.toHaveBeenCalled();
    expect((repository as unknown as { loadStateVersion: jest.Mock }).loadStateVersion).not.toHaveBeenCalled();
  });
});
