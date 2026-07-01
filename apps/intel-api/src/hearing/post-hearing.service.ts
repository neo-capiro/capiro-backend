import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';

/**
 * Post-hearing artifacts: assembles a client-ready summary, action-item list,
 * and the claim map (every claim points to a transcript segment id + timestamp,
 * SC5.6). Also exposes a tenant-scoped quote query so the chat surface can ask
 * "pull every quote on <topic>" against a finished session (SC5.7) using the
 * same persisted data.
 */
@Injectable()
export class PostHearingService {
  private readonly logger = new Logger(PostHearingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: HearingCryptoService,
  ) {}

  /** Tenant-scoped post-hearing summary payload. */
  async summarize(tenantId: string, sessionId: string) {
    const session = await this.prisma.liveHearingSession.findFirst({
      where: { id: sessionId, tenantId },
    });
    if (!session) return null;

    const [quotes, actionItems, mentions, cards, segmentCount] = await Promise.all([
      this.prisma.keyQuote.findMany({ where: { tenantId, sessionId }, orderBy: { startMs: 'asc' } }),
      this.prisma.liveActionItem.findMany({ where: { tenantId, sessionId } }),
      this.prisma.entityMention.findMany({ where: { tenantId, sessionId } }),
      this.prisma.liveSummaryCard.findMany({ where: { tenantId, sessionId }, orderBy: { startMs: 'asc' } }),
      this.prisma.transcriptSegment.count({ where: { tenantId, sessionId } }),
    ]);

    return {
      sessionId,
      title: session.title,
      status: session.status,
      segmentCount,
      keyQuotes: quotes.map((q) => ({
        id: q.id,
        segmentId: q.segmentId,
        startMs: q.startMs,
        speakerName: q.speakerName,
        issueTags: q.issueTags,
        text: this.revealText(q),
      })),
      actionItems: actionItems.map((a) => ({ id: a.id, description: a.description, status: a.status, segmentId: a.segmentId })),
      entityMentions: mentions.map((m) => ({ entityType: m.entityType, entityRef: m.entityRef, entityLabel: m.entityLabel })),
      cards: cards.map((c) => ({ cardType: c.cardType, title: c.title, body: c.body, startMs: c.startMs })),
      // Claim map: each claim anchored to a segment id + timestamp.
      claimMap: quotes.map((q) => ({ claimId: q.id, segmentId: q.segmentId, timestampMs: q.startMs })),
    };
  }

  /** Quote search within a finished session (tenant-scoped). Powers SC5.7. */
  async findQuotes(tenantId: string, sessionId: string, topic?: string) {
    const quotes = await this.prisma.keyQuote.findMany({
      where: { tenantId, sessionId },
      orderBy: { startMs: 'asc' },
    });
    const decorated = quotes.map((q) => ({
      id: q.id,
      segmentId: q.segmentId,
      startMs: q.startMs,
      speakerName: q.speakerName,
      issueTags: q.issueTags,
      text: this.revealText(q),
    }));
    if (!topic) return decorated;
    const needle = topic.toLowerCase();
    return decorated.filter(
      (q) => q.text.toLowerCase().includes(needle) || q.issueTags.some((t) => t.toLowerCase().includes(needle)),
    );
  }

  private revealText(q: { textCiphertext: string | null; iv: string | null; authTag: string | null; textPlain: string | null }): string {
    if (q.textPlain != null) return q.textPlain;
    if (q.textCiphertext && q.iv && q.authTag && this.crypto.configured) {
      try {
        return this.crypto.decrypt({ textCiphertext: q.textCiphertext, iv: q.iv, authTag: q.authTag });
      } catch (err) {
        this.logger.warn(`quote decrypt failed: ${(err as Error).message}`);
        return '[decryption unavailable]';
      }
    }
    return '[encrypted]';
  }
}
