import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';

export interface HearingTranscriptPage {
  items: Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    speakerLabel?: string;
    resolvedSpeakerName?: string;
    confidence?: number;
  }>;
  nextOffset: number | null;
  hasMore: boolean;
}

/**
 * Post-hearing artifacts: assembles a client-ready summary, action-item list,
 * and the claim map (every claim points to a transcript segment id + timestamp,
 * SC5.6). Also exposes a tenant-scoped quote query so the chat surface can ask
 * "pull every quote on <topic>" against a finished session (SC5.7) using the
 * same persisted data, plus the paginated transcript history the Live Hearing
 * Room hydrates when an analyst reopens a session.
 *
 * Every read is tenant/session scoped and encrypted text is revealed only
 * through HearingCryptoService.
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
    const session = await this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findFirst({
        where: { id: sessionId, tenantId },
      }),
    );
    if (!session) return null;

    const [quotes, actionItems, mentions, cards, segmentCount] = await this.prisma.withTenant(
      tenantId,
      (tx) =>
        Promise.all([
          tx.keyQuote.findMany({ where: { tenantId, sessionId }, orderBy: { startMs: 'asc' } }),
          tx.liveActionItem.findMany({ where: { tenantId, sessionId } }),
          tx.entityMention.findMany({ where: { tenantId, sessionId } }),
          tx.liveSummaryCard.findMany({
            where: { tenantId, sessionId },
            orderBy: { startMs: 'asc' },
          }),
          tx.transcriptSegment.count({ where: { tenantId, sessionId } }),
        ]),
    );

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
      actionItems: actionItems.map((a) => ({
        id: a.id,
        description: a.description,
        status: a.status,
        segmentId: a.segmentId,
      })),
      entityMentions: mentions.map((m) => ({
        entityType: m.entityType,
        entityRef: m.entityRef,
        entityLabel: m.entityLabel,
      })),
      cards: cards.map((c) => ({
        cardType: c.cardType,
        title: c.title,
        body: c.body,
        startMs: c.startMs,
      })),
      // Claim map: each claim anchored to a segment id + timestamp.
      claimMap: quotes.map((q) => ({
        claimId: q.id,
        segmentId: q.segmentId,
        timestampMs: q.startMs,
      })),
    };
  }

  /** Paginated, tenant-scoped transcript history for reopening My Sessions. */
  async transcript(
    tenantId: string,
    sessionId: string,
    opts: { offset?: number; limit?: number } = {},
  ): Promise<HearingTranscriptPage | null> {
    const session = await this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findFirst({
        where: { id: sessionId, tenantId },
        select: { id: true },
      }),
    );
    if (!session) return null;

    const offset = Math.max(0, Math.min(opts.offset ?? 0, 100_000));
    const limit = Math.max(1, Math.min(opts.limit ?? 250, 500));
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.transcriptSegment.findMany({
        where: { tenantId, sessionId, isFinal: true },
        orderBy: [{ startMs: 'asc' }, { id: 'asc' }],
        skip: offset,
        take: limit + 1,
      }),
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((s) => ({
        id: s.id,
        startMs: s.startMs,
        endMs: s.endMs,
        text: this.revealText(s),
        ...(s.speakerLabel ? { speakerLabel: s.speakerLabel } : {}),
        ...(s.resolvedSpeakerName ? { resolvedSpeakerName: s.resolvedSpeakerName } : {}),
        ...(s.confidence != null ? { confidence: s.confidence } : {}),
      })),
      hasMore,
      nextOffset: hasMore ? offset + page.length : null,
    };
  }

  /** Quote search within a finished session (tenant-scoped). Powers SC5.7. */
  async findQuotes(tenantId: string, sessionId: string, topic?: string) {
    const quotes = await this.prisma.withTenant(tenantId, (tx) =>
      tx.keyQuote.findMany({
        where: { tenantId, sessionId },
        orderBy: { startMs: 'asc' },
      }),
    );
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
      (q) =>
        q.text.toLowerCase().includes(needle) ||
        q.issueTags.some((t) => t.toLowerCase().includes(needle)),
    );
  }

  private revealText(row: {
    textCiphertext: string | null;
    iv: string | null;
    authTag: string | null;
    textPlain: string | null;
  }): string {
    if (row.textPlain != null) return row.textPlain;
    if (row.textCiphertext && row.iv && row.authTag && this.crypto.configured) {
      try {
        return this.crypto.decrypt({
          textCiphertext: row.textCiphertext,
          iv: row.iv,
          authTag: row.authTag,
        });
      } catch (err) {
        this.logger.warn(`hearing text decrypt failed: ${(err as Error).message}`);
        return '[decryption unavailable]';
      }
    }
    return '[encrypted]';
  }
}
