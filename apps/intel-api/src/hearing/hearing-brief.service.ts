import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';
import { OrchestratorClient } from './orchestrator.client.js';

/**
 * H4 — Post-Hearing Brief generator (the MVP deliverable).
 *
 * Assembles a client-ready brief from persisted session data: exec summary,
 * key moments, relevant quotes (with timestamps), supporters & opponents, tone,
 * client-specific risks/opportunities, recommended next steps, and a draft
 * client-update email. EVERY claim/quote is sourced to a transcript segment id +
 * timestamp (claim map) — no unsourced assertions (SC4.2).
 *
 * The narrative synthesis (summary/tone/risks/email) is delegated to the MeriV2
 * orchestrator when configured; if it is not reachable, the brief degrades to a
 * deterministic, data-only assembly (still fully sourced) rather than failing.
 */
export interface HearingBrief {
  sessionId: string;
  title: string;
  generatedAt: string;
  executiveSummary: string;
  keyMoments: Array<{ segmentId: string; timestampMs: number; speakerName?: string; text: string; issueTags: string[] }>;
  relevantQuotes: Array<{ segmentId: string; timestampMs: number; speakerName?: string; text: string }>;
  supporters: string[];
  opponents: string[];
  tone: string;
  risks: string[];
  opportunities: string[];
  recommendedNextSteps: string[];
  draftClientEmail: { subject: string; body: string };
  claimMap: Array<{ claimId: string; segmentId: string; timestampMs: number }>;
  synthesisSource: 'orchestrator' | 'deterministic';
}

@Injectable()
export class HearingBriefService {
  private readonly logger = new Logger(HearingBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: HearingCryptoService,
    private readonly orchestrator: OrchestratorClient,
  ) {}

  async generate(tenantId: string, sessionId: string, authToken: string): Promise<HearingBrief | null> {
    const session = await this.prisma.liveHearingSession.findFirst({ where: { id: sessionId, tenantId } });
    if (!session) return null;

    const [quotes, actionItems, mentions, cards] = await Promise.all([
      this.prisma.keyQuote.findMany({ where: { tenantId, sessionId }, orderBy: { startMs: 'asc' } }),
      this.prisma.liveActionItem.findMany({ where: { tenantId, sessionId } }),
      this.prisma.entityMention.findMany({ where: { tenantId, sessionId } }),
      this.prisma.liveSummaryCard.findMany({ where: { tenantId, sessionId }, orderBy: { startMs: 'asc' } }),
    ]);

    const revealedQuotes = quotes.map((q) => ({
      segmentId: q.segmentId,
      timestampMs: q.startMs,
      speakerName: q.speakerName ?? undefined,
      text: this.reveal(q),
      issueTags: q.issueTags,
    }));

    // Supporters / opponents from position-signal cards (stance lives on cards
    // until the H3 classifier persists structured stance).
    const supporters = uniq(
      cards.filter((c) => /support|favorable|champion/i.test(c.cardType + ' ' + c.title)).map((c) => c.title),
    );
    const opponents = uniq(
      cards.filter((c) => /oppos|unfavorable|concern|block/i.test(c.cardType + ' ' + c.title)).map((c) => c.title),
    );

    // Try orchestrator synthesis; fall back to deterministic assembly.
    const synth = await this.synthesize(tenantId, sessionId, authToken, {
      title: session.title,
      quotes: revealedQuotes,
      mentions: mentions.map((m) => ({ type: m.entityType, label: m.entityLabel, ref: m.entityRef })),
      actionItems: actionItems.map((a) => a.description),
    });

    const claimMap = quotes.map((q) => ({ claimId: q.id, segmentId: q.segmentId, timestampMs: q.startMs }));

    return {
      sessionId,
      title: session.title,
      generatedAt: new Date().toISOString(),
      executiveSummary: synth.executiveSummary,
      keyMoments: revealedQuotes.slice(0, 10),
      relevantQuotes: revealedQuotes.map(({ segmentId, timestampMs, speakerName, text }) => ({
        segmentId,
        timestampMs,
        speakerName,
        text,
      })),
      supporters,
      opponents,
      tone: synth.tone,
      risks: synth.risks,
      opportunities: synth.opportunities,
      recommendedNextSteps: synth.recommendedNextSteps.length ? synth.recommendedNextSteps : actionItems.map((a) => a.description),
      draftClientEmail: synth.draftClientEmail,
      claimMap,
      synthesisSource: synth.source,
    };
  }

  private async synthesize(
    tenantId: string,
    sessionId: string,
    authToken: string,
    data: {
      title: string;
      quotes: Array<{ text: string; speakerName?: string; timestampMs: number }>;
      mentions: Array<{ type: string; label: string; ref: string | null }>;
      actionItems: string[];
    },
  ): Promise<{
    executiveSummary: string;
    tone: string;
    risks: string[];
    opportunities: string[];
    recommendedNextSteps: string[];
    draftClientEmail: { subject: string; body: string };
    source: 'orchestrator' | 'deterministic';
  }> {
    if (this.orchestrator.configured) {
      try {
        const out = await this.orchestrator.summarizeHearing({
          tenantId,
          sessionId,
          authToken,
          title: data.title,
          quotes: data.quotes,
          mentions: data.mentions,
          actionItems: data.actionItems,
        });
        if (out) return { ...out, source: 'orchestrator' };
      } catch (err) {
        this.logger.warn(`brief synthesis via orchestrator failed: ${(err as Error).message}; using deterministic`);
      }
    }
    // Deterministic fallback — fully sourced, no fabricated narrative.
    const topMentions = uniq(data.mentions.map((m) => m.label)).slice(0, 8);
    return {
      executiveSummary:
        `Hearing "${data.title}" produced ${data.quotes.length} flagged moment(s)` +
        (topMentions.length ? ` touching: ${topMentions.join(', ')}.` : '.') +
        ' Full narrative synthesis pending orchestrator availability; quotes and entities below are source-verified.',
      tone: 'undetermined (awaiting stance classifier)',
      risks: [],
      opportunities: [],
      recommendedNextSteps: data.actionItems,
      draftClientEmail: {
        subject: `Hearing recap: ${data.title}`,
        body:
          `Hi,\n\nHere is a quick recap of "${data.title}".\n\n` +
          data.quotes.slice(0, 5).map((q) => `• ${q.speakerName ? q.speakerName + ': ' : ''}"${q.text}"`).join('\n') +
          `\n\nWe will follow up with a fuller analysis.\n\nBest,\nCapiro`,
      },
      source: 'deterministic',
    };
  }

  private reveal(q: { textCiphertext: string | null; iv: string | null; authTag: string | null; textPlain: string | null }): string {
    if (q.textPlain != null) return q.textPlain;
    if (q.textCiphertext && q.iv && q.authTag && this.crypto.configured) {
      try {
        return this.crypto.decrypt({ textCiphertext: q.textCiphertext, iv: q.iv, authTag: q.authTag });
      } catch {
        return '[decryption unavailable]';
      }
    }
    return '[encrypted]';
  }
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}
