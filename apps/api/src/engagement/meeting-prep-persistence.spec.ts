import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const grounding = {
  version: 1,
  sources: [],
  references: [],
  attendees: [],
  limitations: [],
  contentEdited: false,
};

function harness(status = 'confirmed', initialClient: string | null = 'c1') {
  const current: any = {
    id: 'm1',
    status,
    clientId: initialClient,
    isInternal: false,
    attendees: [],
    tasks: [],
  };
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: 'm1' }]),
    meeting: {
      findFirst: jest.fn(async () => ({ ...current })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ data }) => Object.assign(current, data)),
    },
    client: { findUnique: jest.fn(async ({ where }) => ({ id: where.id, name: 'Client' })) },
    mailThread: { findMany: jest.fn(async () => []) },
    meetingPrep: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }) => ({ id: 'prep-1', ...data })),
    },
  };
  const ai = {
    generateMeetingPrep: jest.fn(async () => ({
      summary: 'Prep',
      agenda: [],
      talkingPoints: [],
      risks: [],
      followUps: [],
      emailEvidence: [],
      grounding,
      provider: 'openai',
      model: 'test',
    })),
  };
  const service = Object.create(EngagementService.prototype) as any;
  Object.assign(service, {
    prisma: {
      withTenant: async (_tenant: string, callback: (tx: unknown) => unknown) => callback(tx),
    },
    ai,
    association: {
      associate: jest.fn(async () => ({
        clientId: 'c1',
        score: 1,
        reason: 'matched',
        signals: {},
      })),
    },
    directoryProfilesForMeeting: async () => [],
    loadUserVoiceBlock: async () => null,
    clientMeetingAssociationWhere: async () => ({ clientId: 'c1' }),
    clientMailThreadAssociationWhere: async () => ({ clientId: 'c1' }),
    recordAiUsage: async () => {},
  });
  return { service: service as EngagementService, tx, ai, current };
}

describe('meeting prep persistence', () => {
  test.each(['cancelled', 'canceled', 'CANCELLED'])(
    'refuses %s before stale writes or provider requests',
    async (status) => {
      const h = harness(status);
      await expect(h.service.generateMeetingPrep(ctx, 'm1')).rejects.toThrow('cancelled meeting');
      expect(h.ai.generateMeetingPrep).not.toHaveBeenCalled();
      expect(h.tx.meetingPrep.updateMany).not.toHaveBeenCalled();
    },
  );

  test('saves canonical source metadata and the original client in generatedFrom', async () => {
    const h = harness();
    const saved = await h.service.generateMeetingPrep(ctx, 'm1');
    expect(saved.generatedFrom).toEqual(expect.objectContaining({ clientId: 'c1', grounding }));
  });

  test('inferred association is persisted before the final client guard', async () => {
    const h = harness('confirmed', null);
    const saved = await h.service.generateMeetingPrep(ctx, 'm1');
    expect(h.current.clientId).toBe('c1');
    expect(saved.clientId).toBe('c1');
  });

  test.each(['client', 'cancellation'])(
    'does not save when %s changes during provider generation',
    async (change) => {
      const h = harness();
      h.ai.generateMeetingPrep.mockImplementationOnce(async () => {
        if (change === 'client') h.current.clientId = 'c2';
        else h.current.status = 'cancelled';
        return {
          summary: 'Old client prep',
          agenda: [],
          talkingPoints: [],
          risks: [],
          followUps: [],
          emailEvidence: [],
          grounding,
          provider: 'openai',
          model: 'test',
        };
      });
      await expect(h.service.generateMeetingPrep(ctx, 'm1')).rejects.toThrow(
        change === 'client' ? 'client changed' : 'cancelled',
      );
      expect(h.tx.meetingPrep.create).not.toHaveBeenCalled();
    },
  );

  test('manual edits invalidate claim links even if subsequently approved', async () => {
    const tx = {
      meetingPrep: {
        findFirst: async () => ({
          id: 'p1',
          meetingId: 'm1',
          generatedFrom: { clientId: 'c1', grounding },
        }),
        update: jest.fn(async ({ data }) => ({ id: 'p1', ...data })),
      },
    };
    const service = Object.create(EngagementService.prototype) as any;
    service.prisma = {
      withTenant: async (_tenant: string, callback: (tx: unknown) => unknown) => callback(tx),
    };
    service.ensureOwnMeeting = async () => {};
    await service.updateMeetingPrep(ctx, 'p1', { summary: 'Edited' });
    expect(tx.meetingPrep.update.mock.calls[0]![0].data.generatedFrom.grounding.contentEdited).toBe(
      true,
    );
  });
});
