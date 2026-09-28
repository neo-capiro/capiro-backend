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
  logicalOperationId?: string,
) => Promise<Record<string, unknown>>;
type ScheduleTask = (
  actor: TenantContext,
  input: Record<string, unknown>,
  logicalOperationId?: string,
) => Promise<Record<string, unknown>>;

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
      'proposal-operation-1',
    );
    expect(acceptedSink).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      sendReceipt: {
        ok: true,
        provider: 'gmail',
        providerMessageId: 'gmail-message-1',
        correlationId: 'proposal-operation-1',
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
      sendEmail(
        ctx,
        { to: 'recipient@example.com', subject: 'Hello', body: 'Body' },
        'proposal-operation-1',
      ),
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

  test('schedule_task reconciles a post-commit acknowledgement loss before any retry effect', async () => {
    const receipts = new Map<
      string,
      {
        id: string;
        name: string;
        intervalMinutes: number;
        nextRunAt: Date;
      }
    >();
    let createAttempts = 0;
    const findFirst = jest.fn(async ({ where }: { where: { metadata?: { equals?: string } } }) =>
      where.metadata?.equals ? (receipts.get(where.metadata.equals) ?? null) : null,
    );
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      createAttempts += 1;
      const metadata = data.metadata as { logicalOperationId: string };
      const receipt = {
        id: `task-${createAttempts}`,
        name: String(data.name),
        intervalMinutes: Number(data.intervalMinutes),
        nextRunAt: data.nextRunAt as Date,
      };
      receipts.set(metadata.logicalOperationId, receipt);
      if (createAttempts === 1) {
        throw new Error('connection reset after committed insert');
      }
      return receipt;
    });
    const tx = {
      clioScheduledTask: {
        findFirst,
        count: jest.fn().mockResolvedValue(0),
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
    const input = {
      name: 'Federal watch',
      prompt: 'Check the latest authorized sources.',
      intervalMinutes: 60,
    };

    const recovered = await scheduleTask(ctx, input, 'proposal-operation-1');
    const reconnect = await scheduleTask(ctx, input, 'proposal-operation-1');
    const intentionalLaterOperation = await scheduleTask(ctx, input, 'proposal-operation-2');

    expect(recovered).toMatchObject({
      scheduled: true,
      reconciled: true,
      logicalOperationId: 'proposal-operation-1',
      task: { id: 'task-1' },
    });
    expect(reconnect).toMatchObject({
      scheduled: true,
      reconciled: true,
      logicalOperationId: 'proposal-operation-1',
      task: { id: 'task-1' },
    });
    expect(intentionalLaterOperation).toMatchObject({
      scheduled: true,
      logicalOperationId: 'proposal-operation-2',
      task: { id: 'task-2' },
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: ctx.tenantId,
        ownerUserId: ctx.userId,
        metadata: { path: ['logicalOperationId'], equals: 'proposal-operation-1' },
      },
      select: { id: true, name: true, intervalMinutes: true, nextRunAt: true },
    });
  });
});
