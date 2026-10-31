import { ClientActivityService } from './client-activity.service.js';
import { EngagementService } from '../engagement/engagement.service.js';
import {
  bearer,
  ctx,
  fixture,
  followInput,
  IDs,
} from '../../test/support/activity-command.fixture.js';

// Keep the actual attachment owner/guards; isolate unrelated AI generation constructors.
jest.mock('../engagement/generation/generation-gateway.service.js', () => ({
  GenerationGatewayService: class {},
}));
jest.mock('../engagement/engagement-ai.service.js', () => ({ EngagementAiService: class {} }));

describe('canonical client activity ethical-wall boundary', () => {
  function setup() {
    const f = fixture();
    const tx = {
      ...f.tx,
      clientActivity: {
        ...f.tx.clientActivity,
        findMany: jest.fn(async () => []),
        update: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
      meeting: { findMany: jest.fn(async () => []) },
      engagementAttachment: { findMany: jest.fn(async () => []) },
      outreachRecord: { findMany: jest.fn(async () => []) },
    };
    const engagement = {
      listMailThreads: jest.fn(async () => []),
      listAttachments: jest.fn(async () => []),
    };
    const prisma = { withTenant: jest.fn(async (_tenant: string, fn: (tx: any) => any) => fn(tx)) };
    return {
      ...f,
      tx,
      engagement,
      activitiesService: new ClientActivityService(prisma as any, engagement as any),
    };
  }
  it.each(['list', 'create', 'update', 'remove'] as const)(
    'denies %s before reading derived content or mutating a walled client',
    async (action) => {
      const f = setup();
      f.state.actorWall = false;
      const result =
        action === 'list'
          ? f.activitiesService.list(ctx, IDs.client)
          : action === 'create'
            ? f.activitiesService.create(ctx, IDs.client, { kind: 'note', title: 'Test' })
            : action === 'update'
              ? f.activitiesService.update(ctx, IDs.client, IDs.activity, { title: 'Changed' })
              : f.activitiesService.remove(ctx, IDs.client, IDs.activity);
      await expect(result).rejects.toThrow('Client not found');
      expect(f.tx.clientActivity.findMany).not.toHaveBeenCalled();
      expect(f.engagement.listMailThreads).not.toHaveBeenCalled();
      expect(f.engagement.listAttachments).not.toHaveBeenCalled();
      expect(f.tx.clientActivity.create).not.toHaveBeenCalled();
      expect(f.tx.clientActivity.update).not.toHaveBeenCalled();
      expect(f.tx.clientActivity.deleteMany).not.toHaveBeenCalled();
      expect(f.tx.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.any(String),
        IDs.tenant,
        IDs.client,
        IDs.actor,
      );
    },
  );
  it('preserves authorized legacy editing and deletion without deleting the durable command', async () => {
    const f = setup();
    await f.service.create(ctx, IDs.client, followInput, bearer);
    await f.activitiesService.update(ctx, IDs.client, IDs.activity, { title: 'Edited' });
    await f.activitiesService.remove(ctx, IDs.client, IDs.activity);
    expect(f.tx.clientActivity.update).toHaveBeenCalled();
    expect(f.tx.clientActivity.deleteMany).toHaveBeenCalled();
    expect(f.rows).toHaveLength(1);
  });
});
describe('activity documents use the actual canonical attachment authorization', () => {
  const actor = { ...ctx, clerkUserId: 'synthetic-owner' };
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-activity-test';
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });
  function attachment(id: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      tenantId: ctx.tenantId,
      clientId: IDs.client,
      prospectId: null,
      meetingId: null,
      mailMessageId: null,
      fileName: id,
      source: 'upload',
      sourceEntityType: null,
      sourceEntityId: null,
      supersededByAttachmentId: null,
      viewerMode: 'all',
      viewerUserIds: [],
      uploadedByUserId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      s3Key: 'private-storage',
      contentType: 'application/pdf',
      ...extra,
    };
  }
  function setup(rows: ReturnType<typeof attachment>[]) {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
      client: { findFirst: jest.fn().mockResolvedValue({ id: IDs.client }) },
      tenantMembership: { findFirst: jest.fn().mockResolvedValue({ id: 'membership' }) },
      clientActivity: { findMany: jest.fn().mockResolvedValue([]) },
      meeting: { findMany: jest.fn().mockResolvedValue([]) },
      outreachRecord: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      mailMessage: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === 'private-mail' ? null : { id: where.id, thread: { clientId: IDs.client } },
        ),
      },
      engagementAttachment: {
        findMany: jest.fn(async ({ where, take }: any) => {
          // Synthetic storage evaluates the actual owner's predicates, including its viewer OR.
          const selected = rows.filter(
            (r: any) =>
              ['tenantId', 'clientId', 'prospectId', 'supersededByAttachmentId'].every(
                (key) => !Object.hasOwn(where, key) || r[key] === where[key],
              ) &&
              (!where.OR ||
                where.OR.some((clause: any) =>
                  Object.entries(clause).every(([key, value]: [string, any]) =>
                    value && typeof value === 'object' && 'has' in value
                      ? r[key].includes(value.has)
                      : r[key] === value,
                  ),
                )),
          );
          return selected
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .slice(0, take ?? selected.length);
        }),
      },
    };
    const prisma = { withTenant: async (_: string, run: (tx: unknown) => unknown) => run(tx) };
    const engagement = Object.create(EngagementService.prototype) as EngagementService;
    Object.assign(engagement, {
      prisma,
      scanner: { scanRequired: true },
      attachmentContent: { readiness: () => ({ usable: false }) },
      listMailThreads: jest.fn(async () => []),
    });
    const listAttachments = jest.spyOn(engagement, 'listAttachments');
    return { tx, listAttachments, service: new ClientActivityService(prisma as never, engagement) };
  }
  test.each([
    [
      'restricted viewer',
      { viewerMode: 'restricted', viewerUserIds: ['other'], uploadedByUserId: 'other' },
    ],
    ['superseded version', { supersededByAttachmentId: 'replacement' }],
    ['private incoming-mail parent', { source: 'incoming_mail', mailMessageId: 'private-mail' }],
    ['prospect-only attachment', { prospectId: 'other-prospect' }],
    [
      'inaccessible hearing provenance',
      { sourceEntityType: 'hearing_record_brief', sourceEntityId: 'brief' },
    ],
  ])('withholds %s metadata while retaining authorized documents', async (_label, extra) => {
    const f = setup([
      attachment('hidden-title', extra as Record<string, unknown>),
      attachment('visible'),
    ]);
    const result = await f.service.list(actor, IDs.client, { kinds: ['document'] });
    expect(result.map((r) => r.sourceId)).toEqual(['visible']);
    expect(JSON.stringify(result)).not.toContain('hidden-title');
    expect(f.listAttachments).toHaveBeenCalledWith(actor, { clientId: IDs.client });
  });
  test('applies bounds after authorization, including when denied rows outnumber the timeline window', async () => {
    const hidden = Array.from({ length: 510 }, (_, n) =>
      attachment(`hidden-${n}`, {
        viewerMode: 'restricted',
        viewerUserIds: ['other'],
        createdAt: new Date('2026-02-01T00:00:00Z'),
      }),
    );
    const f = setup([
      ...hidden,
      attachment('newer', { createdAt: new Date('2026-01-02T00:00:00Z') }),
      attachment('older'),
    ]);
    expect((await f.service.list(actor, IDs.client, { limit: 2 })).map((r) => r.sourceId)).toEqual([
      'newer',
      'older',
    ]);
    expect(f.tx.engagementAttachment.findMany.mock.calls[0]?.[0]).not.toHaveProperty('take');
  });
  test('retains uploader, selected viewer, owned mail and currently authorized hearing metadata', async () => {
    const f = setup([
      attachment('uploader', { viewerMode: 'restricted', uploadedByUserId: actor.userId }),
      attachment('viewer', { viewerMode: 'restricted', viewerUserIds: [actor.userId] }),
      attachment('mail', { source: 'incoming_mail', mailMessageId: 'owned-mail' }),
      attachment('hearing', { sourceEntityType: 'hearing_record_brief', sourceEntityId: 'brief' }),
    ]);
    const provenance = {
      eventId: 'event',
      briefId: 'brief',
      clientId: IDs.client,
      contentHash: 'content',
      sourceHash: 'source',
    };
    f.tx.$queryRaw.mockResolvedValue([provenance]);
    jest.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: 'capiro_record_document_access',
          tenantId: actor.tenantId,
          id: 'brief',
          ...provenance,
        }),
        { status: 200 },
      ),
    );
    expect((await f.service.list(actor, IDs.client)).map((r) => r.sourceId)).toEqual([
      'uploader',
      'viewer',
      'mail',
      'hearing',
    ]);
    expect(f.tx.mailMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          connection: { createdByUserId: actor.userId },
        }),
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('propagates operational incoming-parent failures rather than returning partial success', async () => {
    const f = setup([attachment('mail', { source: 'incoming_mail', mailMessageId: 'owned-mail' })]);
    const failure = new Error('synthetic database unavailable');
    f.tx.mailMessage.findFirst.mockRejectedValue(failure);
    await expect(f.service.list(actor, IDs.client)).rejects.toBe(failure);
  });
});
