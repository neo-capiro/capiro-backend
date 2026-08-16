import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';

const MAX_CANDIDATES = 25;
const MAX_LEARNING_CHARS = 2_000;
const MAX_EXCERPT_CHARS = 4_000;

export interface OutreachReplyCandidate {
  id: string;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;
  excerpt: string;
  clientId: string | null;
  clientName: string | null;
}

export interface ProposeOutreachReplyLearningInput {
  sendIntentId: string;
  mailMessageId: string;
  learning: string;
}

interface LoadedIntent {
  id: string;
  sentAt: Date;
  clientId: string | null;
  recipientEmails: string[];
}

/**
 * Creates a governed memory proposal only after the proposed learning is tied
 * to a real inbound reply from a recipient of the exact durable send intent.
 * The proposal stays pending; this surface never writes active memory directly.
 */
@Injectable()
export class OutreachReplyLearningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: GovernedMemoryCandidateService,
  ) {}

  async listCandidates(
    ctx: TenantContext,
    sendIntentId: string,
  ): Promise<OutreachReplyCandidate[]> {
    assertUuid(sendIntentId, 'sendIntentId');
    const intent = await this.loadIntent(ctx, sendIntentId);
    if (!intent.recipientEmails.length) return [];

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.mailMessage.findMany({
        where: {
          tenantId: ctx.tenantId,
          removedAt: null,
          receivedAt: { gte: intent.sentAt },
          fromEmail: { in: intent.recipientEmails },
        },
        orderBy: { receivedAt: 'desc' },
        take: MAX_CANDIDATES,
        select: {
          id: true,
          fromEmail: true,
          fromName: true,
          subject: true,
          receivedAt: true,
          bodyText: true,
          thread: {
            select: {
              clientId: true,
              client: { select: { name: true } },
            },
          },
        },
      });

      return rows.flatMap((row) => {
        if (!row.fromEmail || !row.receivedAt) return [];
        return [
          {
            id: row.id,
            fromEmail: row.fromEmail,
            fromName: row.fromName,
            subject: row.subject,
            receivedAt: row.receivedAt.toISOString(),
            excerpt: boundedExcerpt(row.bodyText),
            clientId: row.thread.clientId ?? intent.clientId,
            clientName: row.thread.client?.name ?? null,
          },
        ];
      });
    });
  }

  async propose(ctx: TenantContext, input: ProposeOutreachReplyLearningInput) {
    assertUuid(input.sendIntentId, 'sendIntentId');
    assertUuid(input.mailMessageId, 'mailMessageId');
    const learning = normalizeLearning(input.learning);
    const intent = await this.loadIntent(ctx, input.sendIntentId);

    const reply = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.mailMessage.findFirst({
        where: {
          id: input.mailMessageId,
          tenantId: ctx.tenantId,
          removedAt: null,
          receivedAt: { gte: intent.sentAt },
        },
        select: {
          id: true,
          threadId: true,
          fromEmail: true,
          fromName: true,
          subject: true,
          receivedAt: true,
          bodyText: true,
          thread: { select: { clientId: true } },
        },
      }),
    );
    if (!reply || !reply.fromEmail || !reply.receivedAt) {
      throw new NotFoundException('The selected inbound reply is no longer available.');
    }
    if (!intent.recipientEmails.includes(normalizeEmail(reply.fromEmail))) {
      throw new BadRequestException(
        'The selected message is not an inbound reply from a recipient of this send intent.',
      );
    }

    const clientId = reply.thread.clientId ?? intent.clientId;
    const scope = clientId ? 'client' : 'firm';
    const sourceExcerpt = (reply.bodyText ?? '').trim().slice(0, MAX_EXCERPT_CHARS) || null;
    const learningHash = createHash('sha256').update(learning).digest('hex').slice(0, 24);
    const result = await this.candidates.proposeSaveMemory(
      ctx.tenantId,
      ctx.userId,
      {
        scope,
        ownerUserId: null,
        clientId,
        key: `outreach-reply-learning:${input.sendIntentId}:${input.mailMessageId}:${learningHash}`,
        value: learning,
        source: 'outreach_reply',
        sourceConversationId: reply.threadId,
        sourceMessageId: reply.id,
        sourceExcerpt,
      },
      false,
      'outreach_reply_learning',
    );

    if (result.status !== 'pending') {
      throw new Error('Outreach reply learning unexpectedly bypassed governed review.');
    }
    return {
      candidateId: result.candidateId,
      status: 'pending_review' as const,
      scope,
      clientId,
      source: {
        mailMessageId: reply.id,
        fromEmail: reply.fromEmail,
        fromName: reply.fromName,
        subject: reply.subject,
        receivedAt: reply.receivedAt.toISOString(),
      },
    };
  }

  private async loadIntent(ctx: TenantContext, sendIntentId: string): Promise<LoadedIntent> {
    const intent = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachSendIntent.findFirst({
        where: {
          id: sendIntentId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          testMode: false,
        },
        select: {
          id: true,
          createdAt: true,
          outreachRecord: { select: { clientId: true } },
          deliveries: {
            where: { status: 'sent' },
            select: { recipientEnvelope: true, acceptedAt: true },
          },
        },
      }),
    );
    if (!intent) {
      throw new NotFoundException('A completed real send intent with that id was not found.');
    }
    const recipientEmails = uniqueEmails(
      intent.deliveries.flatMap((delivery) => envelopeToEmails(delivery.recipientEnvelope)),
    );
    const acceptedTimes = intent.deliveries
      .map((delivery) => delivery.acceptedAt?.getTime() ?? Number.NaN)
      .filter(Number.isFinite);
    return {
      id: intent.id,
      sentAt: acceptedTimes.length ? new Date(Math.min(...acceptedTimes)) : intent.createdAt,
      clientId: intent.outreachRecord.clientId,
      recipientEmails,
    };
  }
}

export function envelopeToEmails(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const to = (value as { to?: unknown }).to;
  if (!Array.isArray(to)) return [];
  return to.flatMap((recipient) => {
    if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) return [];
    const email = (recipient as { email?: unknown }).email;
    return typeof email === 'string' && normalizeEmail(email) ? [normalizeEmail(email)] : [];
  });
}

function uniqueEmails(values: string[]): string[] {
  return [...new Set(values.map(normalizeEmail).filter(Boolean))];
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLearning(value: string): string {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (normalized.length < 12) {
    throw new BadRequestException('Describe the reply-backed learning in at least 12 characters.');
  }
  if (normalized.length > MAX_LEARNING_CHARS) {
    throw new BadRequestException(
      `Learning proposals may be at most ${MAX_LEARNING_CHARS} characters.`,
    );
  }
  return normalized;
}

function boundedExcerpt(value: string | null): string {
  const text = (value ?? '').trim().replace(/\s+/g, ' ');
  return text.length > 280 ? `${text.slice(0, 277)}…` : text;
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
}
