import { BadRequestException } from '@nestjs/common';
import { OutcomeService } from './outcome.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TenantContext } from '@capiro/shared';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro-internal',
  userId: 'u1',
  clerkUserId: 'clerk_1',
  role: 'standard_user',
};

function makeService() {
  const creates: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    outcomeEvent: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        creates.push(args);
        return { id: 'oe-1', ...args.data };
      }),
      findMany: jest.fn(async () => []),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_t: string, fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new OutcomeService(prisma), creates, tx };
}

describe('OutcomeService (G3)', () => {
  it('record: user-attributed row with validated vocab', async () => {
    const { service, creates } = makeService();
    await service.record(ctx, {
      kind: 'response_received',
      sourceType: 'outreach',
      sourceId: 'or-1',
      clientId: 'c-1',
      evidence: { threadId: 'th-9' },
      notes: 'Staffer replied same day.',
    });
    expect(creates[0]!.data).toMatchObject({
      tenantId: 't1',
      clientId: 'c-1',
      kind: 'response_received',
      sourceType: 'outreach',
      sourceId: 'or-1',
      recordedBy: 'u1',
    });
  });

  it('record: rejects unknown kind/sourceType (CHECK-constraint mirror)', async () => {
    const { service } = makeService();
    await expect(
      service.record(ctx, { kind: 'vibes' as never, sourceType: 'manual' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.record(ctx, { kind: 'no_action', sourceType: 'tweet' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('recordSystem: recordedBy NULL and NEVER throws (fail-open mirror)', async () => {
    const { service, creates } = makeService();
    await service.recordSystem('t1', {
      kind: 'funding_changed',
      sourceType: 'submission',
      sourceId: 'sub-1',
      clientId: 'c-1',
      evidence: { outcomeType: 'success' },
    });
    expect(creates[0]!.data).toMatchObject({ recordedBy: null, kind: 'funding_changed' });

    const failing = new OutcomeService({
      withTenant: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as PrismaService);
    await expect(
      failing.recordSystem('t1', { kind: 'no_action', sourceType: 'submission' }),
    ).resolves.toBeUndefined();
    // even an invalid payload must not throw from the system path
    await expect(
      failing.recordSystem('t1', { kind: 'vibes' as never, sourceType: 'submission' }),
    ).resolves.toBeUndefined();
  });
});
