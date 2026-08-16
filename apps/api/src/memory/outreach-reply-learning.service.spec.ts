import { BadRequestException } from '@nestjs/common';
import {
  envelopeToEmails,
  OutreachReplyLearningService,
} from './outreach-reply-learning.service.js';

describe('OutreachReplyLearningService', () => {
  const ctx = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'standard_user',
  } as const;

  it('extracts only normalized To-recipient emails from an immutable delivery envelope', () => {
    expect(
      envelopeToEmails({
        to: [
          { email: ' Priya@House.gov ' },
          { email: 'CURTIS@HOUSE.GOV' },
          { name: 'Missing email' },
        ],
        cc: ['not-a-reply-anchor@example.test'],
      }),
    ).toEqual(['priya@house.gov', 'curtis@house.gov']);
  });

  it('creates a pending governed candidate only from a matching inbound reply', async () => {
    const intent = {
      id: '33333333-3333-4333-8333-333333333333',
      createdAt: new Date('2026-08-15T12:00:00.000Z'),
      outreachRecord: { clientId: '44444444-4444-4444-8444-444444444444' },
      deliveries: [
        {
          recipientEnvelope: { to: [{ email: 'priya@house.gov' }] },
          acceptedAt: new Date('2026-08-15T12:05:00.000Z'),
        },
      ],
    };
    const reply = {
      id: '55555555-5555-4555-8555-555555555555',
      threadId: '66666666-6666-4666-8666-666666666666',
      fromEmail: 'Priya@House.gov',
      fromName: 'Priya Anand',
      subject: 'Re: technical briefing',
      receivedAt: new Date('2026-08-15T13:00:00.000Z'),
      bodyText: 'Please lead with the implementation timeline next time.',
      thread: { clientId: null },
    };
    const tx = {
      outreachSendIntent: { findFirst: jest.fn().mockResolvedValue(intent) },
      mailMessage: { findFirst: jest.fn().mockResolvedValue(reply) },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (value: typeof tx) => unknown) => run(tx)),
    };
    const candidates = {
      proposeSaveMemory: jest.fn().mockResolvedValue({
        candidateId: '77777777-7777-4777-8777-777777777777',
        status: 'pending',
        memoryId: null,
        ruleId: 'shared_review',
        reason: 'Shared memory requires review.',
      }),
    };
    const service = new OutreachReplyLearningService(prisma as never, candidates as never);

    await expect(
      service.propose(ctx as never, {
        sendIntentId: intent.id,
        mailMessageId: reply.id,
        learning: 'Priya prefers the implementation timeline before the meeting offer.',
      }),
    ).resolves.toMatchObject({
      status: 'pending_review',
      scope: 'client',
      clientId: intent.outreachRecord.clientId,
    });
    expect(candidates.proposeSaveMemory).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.objectContaining({
        scope: 'client',
        clientId: intent.outreachRecord.clientId,
        source: 'outreach_reply',
        sourceMessageId: reply.id,
      }),
      false,
      'outreach_reply_learning',
    );
  });

  it('refuses a message from someone who was not a sent recipient', async () => {
    const tx = {
      outreachSendIntent: {
        findFirst: jest.fn().mockResolvedValue({
          id: '33333333-3333-4333-8333-333333333333',
          createdAt: new Date('2026-08-15T12:00:00.000Z'),
          outreachRecord: { clientId: null },
          deliveries: [
            {
              recipientEnvelope: { to: [{ email: 'priya@house.gov' }] },
              acceptedAt: new Date('2026-08-15T12:05:00.000Z'),
            },
          ],
        }),
      },
      mailMessage: {
        findFirst: jest.fn().mockResolvedValue({
          id: '55555555-5555-4555-8555-555555555555',
          threadId: '66666666-6666-4666-8666-666666666666',
          fromEmail: 'other@example.test',
          fromName: null,
          subject: null,
          receivedAt: new Date('2026-08-15T13:00:00.000Z'),
          bodyText: 'Unrelated reply',
          thread: { clientId: null },
        }),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (value: typeof tx) => unknown) => run(tx)),
    };
    const service = new OutreachReplyLearningService(prisma as never, {} as never);

    await expect(
      service.propose(ctx as never, {
        sendIntentId: '33333333-3333-4333-8333-333333333333',
        mailMessageId: '55555555-5555-4555-8555-555555555555',
        learning: 'This learning should never be accepted.',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
