import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementMailSender } from '../engagement/mail-sender.service.js';
import { MeriToolsService } from './meri-tools.service.js';

jest.mock('../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: class {},
}));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;

type ReplyEmail = (
  actor: TenantContext,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
type SendEmail = (
  actor: TenantContext,
  input: Record<string, unknown>,
  actionProposalId?: string,
) => Promise<Record<string, unknown>>;
type ScheduleTask = (
  actor: TenantContext,
  input: Record<string, unknown>,
  actionProposalId?: string,
) => Promise<Record<string, unknown>>;

const PROPOSAL_A = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_B = '44444444-4444-4444-8444-444444444444';

interface StoredTask {
  id: string;
  tenantId: string;
  ownerUserId: string;
  scope: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  toolAllowList: unknown[];
  nextRunAt: Date;
  enabled: boolean;
  lastStatus: string | null;
  createdBy: string;
  metadata: Record<string, unknown>;
}

function scheduleHarness(
  options: {
    ackLossId?: string;
    cancelOnAckLoss?: boolean;
    gateProposalId?: string;
    initialTaskCount?: number;
    quotaRace?: boolean;
    wallAllowed?: boolean;
  } = {},
) {
  const rows = new Map<string, StoredTask>();
  let wallAllowed = options.wallAllowed ?? true;
  let createAttempts = 0;
  let ackLost = false;
  let gatedReads = 0;
  let countCalls = 0;
  let releaseGate: () => void = () => undefined;
  let releaseCreate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const created = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  for (let i = 0; i < (options.initialTaskCount ?? 0); i += 1) {
    const id = `existing-${i}`;
    rows.set(id, {
      id,
      tenantId: ctx.tenantId,
      ownerUserId: ctx.userId,
      scope: 'user_private',
      name: `Existing ${i}`,
      prompt: 'Existing task',
      intervalMinutes: 60,
      toolAllowList: [],
      nextRunAt: new Date(),
      enabled: true,
      lastStatus: null,
      createdBy: 'meri',
      metadata: {},
    });
  }
  const scoped = (where: Record<string, any>, row: StoredTask | undefined) =>
    row &&
    (!where.tenantId || row.tenantId === where.tenantId) &&
    (!where.ownerUserId || row.ownerUserId === where.ownerUserId) &&
    (!where.scope || row.scope === where.scope);
  const findFirst = jest.fn(async ({ where }: { where: Record<string, any> }) => {
    const row = rows.get(String(where.id));
    if (options.gateProposalId === where.id && !row && gatedReads < 2) {
      gatedReads += 1;
      if (gatedReads === 2) releaseGate();
      await gate;
    }
    return scoped(where, rows.get(String(where.id))) ? rows.get(String(where.id)) : null;
  });
  const findMany = jest.fn(async ({ where }: { where: Record<string, any> }) =>
    [...rows.values()]
      .filter((row) => {
        if (!scoped(where, row) || row.id === where.id?.not) return false;
        const proposalId = row.metadata.actionProposalId ?? row.metadata.logicalOperationId;
        return where.OR?.some((term: Record<string, any>) => term.metadata?.equals === proposalId);
      })
      .slice(0, 3),
  );
  const create = jest.fn(async ({ data }: { data: Record<string, any> }) => {
    createAttempts += 1;
    const id = String(data.id ?? `random-${createAttempts}`);
    if (rows.has(id)) {
      const conflict = new Error('Unique constraint failed on ClioScheduledTask.id');
      (conflict as Error & { code: string }).code = 'P2002';
      throw conflict;
    }
    const row: StoredTask = {
      id,
      tenantId: data.tenantId,
      ownerUserId: data.ownerUserId,
      scope: data.scope,
      name: data.name,
      prompt: data.prompt,
      intervalMinutes: data.intervalMinutes,
      toolAllowList: data.toolAllowList,
      nextRunAt: data.nextRunAt,
      enabled: data.enabled ?? true,
      lastStatus: data.lastStatus ?? null,
      createdBy: data.createdBy,
      metadata: data.metadata,
    };
    rows.set(id, row);
    releaseCreate();
    if (options.ackLossId === id && !ackLost) {
      ackLost = true;
      if (options.cancelOnAckLoss) {
        row.enabled = false;
        row.lastStatus = 'canceled';
      }
      throw new Error('connection reset after committed insert');
    }
    return {
      id: row.id,
      name: row.name,
      intervalMinutes: row.intervalMinutes,
      nextRunAt: row.nextRunAt,
      enabled: row.enabled,
      lastStatus: row.lastStatus,
    };
  });
  const tx = {
    client: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => ({
        id: where.id,
      })),
    },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: wallAllowed }]),
    clioScheduledTask: {
      findFirst,
      findMany,
      count: jest.fn(async () => {
        countCalls += 1;
        if (options.quotaRace && countCalls === 2) await created;
        return rows.size;
      }),
      create,
    },
  };
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (service as unknown as { prisma: unknown }).prisma = {
    withTenant: async (_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx),
  };
  const scheduleTask = (service as unknown as { scheduleTask: ScheduleTask }).scheduleTask.bind(
    service,
  );
  return {
    service,
    scheduleTask,
    rows,
    create,
    findFirst,
    findMany,
    setWallAllowed: (allowed: boolean) => {
      wallAllowed = allowed;
    },
  };
}

describe('Meri write outcome reconciliation', () => {
  test('send_email retains the owned adapter acceptance when artifact persistence rejects', async () => {
    const acceptedSink = jest.fn(
      async (_actor: TenantContext, _connectionId: string, input: { correlationId?: string }) => ({
        ok: true as const,
        provider: 'gmail' as const,
        providerMessageId: 'gmail-message-1',
        providerThreadId: 'gmail-thread-1',
        correlationId: input.correlationId ?? '',
      }),
    );
    const mailSender = new EngagementMailSender(
      { sendMail: jest.fn() } as never,
      { sendMail: acceptedSink } as never,
      { assertExternalAction: jest.fn() } as never,
    );
    const persistArtifact = jest
      .fn()
      .mockRejectedValue(
        new BadRequestException('Tool clientId does not match the Meri conversation client'),
      );
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (service as unknown as { mailSender: unknown }).mailSender = mailSender;
    (service as unknown as { findUserEmailConnection: unknown }).findUserEmailConnection = jest
      .fn()
      .mockResolvedValue({
        id: 'connection-1',
        provider: 'google_workspace',
        accountEmail: 'owner@example.com',
      });
    (service as unknown as { persistArtifact: unknown }).persistArtifact = persistArtifact;
    const sendEmail = (service as unknown as { sendEmail: SendEmail }).sendEmail.bind(service);
    const result = await sendEmail(
      ctx,
      {
        to: 'recipient@example.com',
        subject: 'Hello',
        body: 'Body',
        clientId: 'client-1',
        conversationId: 'conversation-1',
      },
      PROPOSAL_A,
    );
    expect(acceptedSink).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      sendReceipt: {
        ok: true,
        provider: 'gmail',
        providerMessageId: 'gmail-message-1',
        correlationId: PROPOSAL_A,
      },
      artifactPersistence: {
        persisted: false,
        error: 'Tool clientId does not match the Meri conversation client',
      },
    });
  });

  test('send_email propagates adapter acknowledgement loss without fabricating a receipt', async () => {
    const acceptedSink = jest.fn(async () => {
      throw new Error('socket closed after provider request');
    });
    const mailSender = new EngagementMailSender(
      { sendMail: jest.fn() } as never,
      { sendMail: acceptedSink } as never,
      { assertExternalAction: jest.fn() } as never,
    );
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (service as unknown as { mailSender: unknown }).mailSender = mailSender;
    (service as unknown as { findUserEmailConnection: unknown }).findUserEmailConnection = jest
      .fn()
      .mockResolvedValue({
        id: 'connection-1',
        provider: 'google_workspace',
        accountEmail: 'owner@example.com',
      });
    const sendEmail = (service as unknown as { sendEmail: SendEmail }).sendEmail.bind(service);
    await expect(
      sendEmail(ctx, { to: 'recipient@example.com', subject: 'Hello', body: 'Body' }, PROPOSAL_A),
    ).rejects.toThrow('socket closed after provider request');
    expect(acceptedSink).toHaveBeenCalledTimes(1);
  });

  test('reply_email retains the provider receipt when post-send artifact persistence rejects', async () => {
    const sendReceipt = {
      ok: true as const,
      provider: 'gmail' as const,
      providerMessageId: 'gmail-message-1',
      providerThreadId: 'gmail-thread-1',
      correlationId: 'correlation-1',
    };
    const sendMail = jest.fn().mockResolvedValue(sendReceipt);
    const persistArtifact = jest
      .fn()
      .mockRejectedValue(
        new BadRequestException('Tool clientId does not match the Meri conversation client'),
      );
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (service as unknown as { prisma: unknown }).prisma = {
      withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
        fn({
          mailThread: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'mail-thread-1',
              subject: 'Hello',
              messages: [
                {
                  id: 'message-inbound-1',
                  fromEmail: 'sender@example.com',
                  fromName: 'Sender',
                  subject: 'Hello',
                },
              ],
            }),
          },
        }),
    };
    (service as unknown as { mailSender: unknown }).mailSender = { sendMail };
    (service as unknown as { findUserEmailConnection: unknown }).findUserEmailConnection = jest
      .fn()
      .mockResolvedValue({
        id: 'connection-1',
        provider: 'google_workspace',
        accountEmail: 'owner@example.com',
      });
    (service as unknown as { persistArtifact: unknown }).persistArtifact = persistArtifact;
    const replyEmail = (service as unknown as { replyEmail: ReplyEmail }).replyEmail.bind(service);

    const result = await replyEmail(ctx, {
      threadId: 'mail-thread-1',
      body: 'Thanks.',
      clientId: 'client-1',
      conversationId: 'conversation-1',
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(persistArtifact).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      sentFrom: 'owner@example.com',
      to: 'sender@example.com',
      subject: 'Re: Hello',
      sendReceipt,
      artifactPersistence: {
        persisted: false,
        error: 'Tool clientId does not match the Meri conversation client',
      },
    });
  });

  const input = {
    name: ' Federal watch ',
    prompt: ' Check the latest authorized sources. ',
    intervalMinutes: 60,
    toolAllowList: ['search_crs_reports', 'query_intelligence'],
    dailyAtUtc: '08:30',
    emailBriefing: true,
    deliverEmailTo: 'Briefing@Example.com',
  };

  test('actual schedule handler converges controlled concurrent creates through the proposal primary key', async () => {
    const h = scheduleHarness({ gateProposalId: PROPOSAL_A });

    const [first, second] = await Promise.all([
      h.scheduleTask(ctx, input, PROPOSAL_A),
      h.scheduleTask(ctx, input, PROPOSAL_A),
    ]);

    expect(first).toMatchObject({ scheduled: true, task: { id: PROPOSAL_A } });
    expect(second).toMatchObject({ scheduled: true, task: { id: PROPOSAL_A } });
    expect([first, second].some((result) => result.reconciled === true)).toBe(true);
    expect(h.rows.size).toBe(1);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.create.mock.calls[0]?.[0].data.id).toBe(PROPOSAL_A);
  });

  test('actual handler converges quota 24 -> A inserts 25 -> B fresh-reads A before rejection', async () => {
    const h = scheduleHarness({
      gateProposalId: PROPOSAL_A,
      initialTaskCount: 24,
      quotaRace: true,
    });

    const [a, b] = await Promise.all([
      h.scheduleTask(ctx, input, PROPOSAL_A),
      h.scheduleTask(ctx, input, PROPOSAL_A),
    ]);

    expect(a).toMatchObject({
      scheduled: true,
      active: true,
      creationConfirmed: true,
      task: { id: PROPOSAL_A },
    });
    expect(b).toMatchObject({
      scheduled: true,
      active: true,
      creationConfirmed: true,
      reconciled: true,
      task: { id: PROPOSAL_A },
    });
    expect(h.rows.size).toBe(25);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.findFirst).toHaveBeenCalledTimes(3);
  });

  test('returns the original durable receipt after commit then acknowledgement loss', async () => {
    const h = scheduleHarness({ ackLossId: PROPOSAL_A });

    const recovered = await h.scheduleTask(ctx, input, PROPOSAL_A);
    const reconnect = await h.scheduleTask(ctx, input, PROPOSAL_A);

    expect(recovered).toMatchObject({
      scheduled: true,
      reconciled: true,
      task: { id: PROPOSAL_A },
    });
    expect(reconnect).toMatchObject({
      scheduled: true,
      reconciled: true,
      task: { id: PROPOSAL_A },
    });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  test('reports cancellation committed after insert acknowledgement loss from the fresh receipt', async () => {
    const h = scheduleHarness({ ackLossId: PROPOSAL_A, cancelOnAckLoss: true });

    const recovered = await h.scheduleTask(ctx, input, PROPOSAL_A);

    expect(recovered).toMatchObject({
      scheduled: false,
      active: false,
      creationConfirmed: true,
      reconciled: true,
      task: {
        id: PROPOSAL_A,
        enabled: false,
        lastStatus: 'canceled',
        active: false,
        creationConfirmed: true,
      },
      note: expect.stringContaining('Historical creation was confirmed'),
    });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.rows.size).toBe(1);
    expect(h.rows.get(PROPOSAL_A)).toMatchObject({ enabled: false, lastStatus: 'canceled' });
  });

  test('refuses changed intent and ignores an untrusted logicalOperationId in tool input', async () => {
    const h = scheduleHarness();
    await h.scheduleTask(ctx, { ...input, logicalOperationId: PROPOSAL_B }, PROPOSAL_A);

    await expect(
      h.scheduleTask(ctx, { ...input, prompt: 'Changed effect' }, PROPOSAL_A),
    ).rejects.toThrow('Unique constraint failed');
    expect(h.rows.get(PROPOSAL_A)?.metadata).toMatchObject({ actionProposalId: PROPOSAL_A });
    expect(h.rows.get(PROPOSAL_A)?.metadata).not.toHaveProperty('logicalOperationId');
    expect(h.rows.has(PROPOSAL_B)).toBe(false);
  });

  test('refuses a foreign tenant or actor row occupying the same proposal id', async () => {
    const h = scheduleHarness();
    h.rows.set(PROPOSAL_A, {
      id: PROPOSAL_A,
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ownerUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      scope: 'user_private',
      name: 'Foreign',
      prompt: 'Foreign',
      intervalMinutes: 60,
      toolAllowList: [],
      nextRunAt: new Date(),
      enabled: true,
      lastStatus: null,
      createdBy: 'meri',
      metadata: {},
    });

    await expect(h.scheduleTask(ctx, input, PROPOSAL_A)).rejects.toThrow(
      'Unique constraint failed',
    );
    expect(h.rows.get(PROPOSAL_A)?.tenantId).not.toBe(ctx.tenantId);
  });

  test('a genuinely new later-turn proposal creates a distinct stable task', async () => {
    const h = scheduleHarness();

    const first = await h.scheduleTask(ctx, input, PROPOSAL_A);
    const later = await h.scheduleTask(ctx, input, PROPOSAL_B);

    expect(first).toMatchObject({ task: { id: PROPOSAL_A } });
    expect(later).toMatchObject({ task: { id: PROPOSAL_B } });
    expect(h.rows.size).toBe(2);
  });

  test('legacy random-id metadata is read only with exact scope and a known fingerprint', async () => {
    const h = scheduleHarness();
    await h.scheduleTask(ctx, input, PROPOSAL_A);
    const exact = h.rows.get(PROPOSAL_A)!;
    h.rows.delete(PROPOSAL_A);
    h.rows.set('55555555-5555-4555-8555-555555555555', {
      ...exact,
      id: '55555555-5555-4555-8555-555555555555',
      metadata: {
        ...exact.metadata,
        actionProposalId: undefined,
        logicalOperationId: PROPOSAL_A,
      },
    });

    await expect(h.service.readScheduleTaskReceipt(ctx, PROPOSAL_A, input)).resolves.toMatchObject({
      id: '55555555-5555-4555-8555-555555555555',
    });
    delete h.rows.get('55555555-5555-4555-8555-555555555555')!.metadata.scheduleEffectFingerprint;
    await expect(h.service.readScheduleTaskReceipt(ctx, PROPOSAL_A, input)).resolves.toBeNull();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  test('uses current memory-wall authority for creation and receipt normalization', async () => {
    const clientId = '66666666-6666-4666-8666-666666666666';
    const h = scheduleHarness({ wallAllowed: false });

    await expect(h.scheduleTask(ctx, { ...input, clientId }, PROPOSAL_A)).rejects.toThrow(
      'Client not found',
    );
    expect(h.create).not.toHaveBeenCalled();

    h.setWallAllowed(true);
    await expect(h.scheduleTask(ctx, { ...input, clientId }, PROPOSAL_A)).resolves.toMatchObject({
      scheduled: true,
      task: { id: PROPOSAL_A },
    });
    h.setWallAllowed(false);
    await expect(
      h.service.readScheduleTaskReceipt(ctx, PROPOSAL_A, { ...input, clientId }),
    ).resolves.toBeNull();
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  test('reports recovered cancellation as historical creation without re-enabling or creating', async () => {
    const h = scheduleHarness();
    await h.scheduleTask(ctx, input, PROPOSAL_A);
    const stored = h.rows.get(PROPOSAL_A)!;
    stored.enabled = false;
    stored.lastStatus = 'canceled';

    await expect(h.scheduleTask(ctx, input, PROPOSAL_A)).resolves.toMatchObject({
      scheduled: false,
      active: false,
      creationConfirmed: true,
      reconciled: true,
      task: {
        id: PROPOSAL_A,
        enabled: false,
        lastStatus: 'canceled',
        active: false,
      },
      note: expect.stringContaining('Historical creation was confirmed'),
    });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(stored.enabled).toBe(false);
    expect(stored.lastStatus).toBe('canceled');
  });

  test('never converges a canceled same-id row whose effect was mutated', async () => {
    const h = scheduleHarness();
    await h.scheduleTask(ctx, input, PROPOSAL_A);
    const stored = h.rows.get(PROPOSAL_A)!;
    stored.enabled = false;
    stored.lastStatus = 'canceled';
    stored.prompt = 'Mutated after cancellation';

    await expect(h.scheduleTask(ctx, input, PROPOSAL_A)).rejects.toThrow(
      'Unique constraint failed',
    );
    await expect(h.service.readScheduleTaskReceipt(ctx, PROPOSAL_A, input)).resolves.toBeNull();
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.rows.size).toBe(1);
  });
});
