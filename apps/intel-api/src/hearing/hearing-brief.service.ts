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
  keyMoments: Array<{
    segmentId: string;
    timestampMs: number;
    speakerName?: string;
    text: string;
    issueTags: string[];
  }>;
  relevantQuotes: Array<{
    segmentId: string;
    timestampMs: number;
    speakerName?: string;
    text: string;
  }>;
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

  async generate(
    tenantId: string,
    sessionId: string,
    /** Delegated to MeriV2 for service-to-service auth; no raw user token is
     *  relayed any more. */
    clerkUserId: string,
  ): Promise<HearingBrief | null> {
    const session = await this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findFirst({ where: { id: sessionId, tenantId } }),
    );
    if (!session) return null;

    const [quotes, actionItems, mentions, cards] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.keyQuote.findMany({ where: { tenantId, sessionId }, orderBy: { startMs: 'asc' } }),
        tx.liveActionItem.findMany({ where: { tenantId, sessionId } }),
        tx.entityMention.findMany({ where: { tenantId, sessionId } }),
        tx.liveSummaryCard.findMany({
          where: { tenantId, sessionId },
          orderBy: { startMs: 'asc' },
        }),
      ]),
    );

    const revealedQuotes = quotes.map((q) => ({
      segmentId: q.segmentId,
      timestampMs: q.startMs,
      speakerName: q.speakerName ?? undefined,
      text: this.reveal(q),
      issueTags: q.issueTags,
    }));

    // Derived prose is ENCRYPTED for a sensitive session, so it must be revealed
    // BEFORE anything matches on it or hands it to synthesis. Matching a regex
    // against a base64 ciphertext does not error — it just quietly never matches,
    // which would turn the stance split into a permanently empty list.
    const revealedCards = cards.map((c) => ({
      cardType: c.cardType,
      title: this.reveal({
        textCiphertext: c.titleCiphertext,
        iv: c.titleIv,
        authTag: c.titleAuthTag,
        textPlain: c.title,
      }),
      body:
        c.body != null || c.bodyCiphertext
          ? this.reveal({
              textCiphertext: c.bodyCiphertext,
              iv: c.bodyIv,
              authTag: c.bodyAuthTag,
              textPlain: c.body,
            })
          : null,
    }));

    const revealedMentions = mentions.map((m) => ({
      type: m.entityType,
      label: this.reveal({
        textCiphertext: m.textCiphertext,
        iv: m.iv,
        authTag: m.authTag,
        textPlain: m.entityLabel,
      }),
      ref: m.entityRef,
    }));

    const revealedActionItems = actionItems.map((a) =>
      this.reveal({
        textCiphertext: a.textCiphertext,
        iv: a.iv,
        authTag: a.authTag,
        textPlain: a.description,
      }),
    );

    // Supporters / opponents from position-signal cards (stance lives on cards
    // until the H3 classifier persists structured stance). Unrevealable rows are
    // dropped rather than listed — "[encrypted]" is not the name of a supporter.
    const supporters = uniq(
      revealedCards
        .filter((c) => isRevealed(c.title))
        .filter((c) => /support|favorable|champion/i.test(c.cardType + ' ' + c.title))
        .map((c) => c.title),
    );
    const opponents = uniq(
      revealedCards
        .filter((c) => isRevealed(c.title))
        .filter((c) => /oppos|unfavorable|concern|block/i.test(c.cardType + ' ' + c.title))
        .map((c) => c.title),
    );

    // Try orchestrator synthesis; fall back to deterministic assembly.
    const synth = await this.synthesize(tenantId, sessionId, clerkUserId, {
      title: session.title,
      quotes: revealedQuotes,
      mentions: revealedMentions.filter((m) => isRevealed(m.label)),
      actionItems: revealedActionItems.filter(isRevealed),
    });

    const claimMap = quotes.map((q) => ({
      claimId: q.id,
      segmentId: q.segmentId,
      timestampMs: q.startMs,
    }));

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
      recommendedNextSteps: synth.recommendedNextSteps.length
        ? synth.recommendedNextSteps
        : // Revealed, and placeholders dropped: `description` is nullable now that
          // a sensitive session stores the text encrypted instead.
          revealedActionItems.filter(isRevealed),
      draftClientEmail: synth.draftClientEmail,
      claimMap,
      synthesisSource: synth.source,
    };
  }

  private async synthesize(
    tenantId: string,
    sessionId: string,
    clerkUserId: string,
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
    // Log the INPUT VOLUME unconditionally. A recap can be poor for two entirely
    // different reasons — synthesis unavailable, or synthesis starved of source
    // material — and they are indistinguishable in the output. On 2026-07-29 both
    // happened at once: the orchestrator aborted AND mentions was empty (every
    // entity mention had been computed and then discarded by the sensitive-session
    // storage rule, since EntityMention has no encrypted text column yet).
    this.logger.log(
      `brief inputs session=${sessionId} quotes=${data.quotes.length} ` +
        `mentions=${data.mentions.length} actionItems=${data.actionItems.length}`,
    );
    if (this.orchestrator.configured) {
      try {
        const out = await this.orchestrator.summarizeHearing({
          tenantId,
          sessionId,
          clerkUserId,
          title: data.title,
          quotes: data.quotes,
          mentions: data.mentions,
          actionItems: data.actionItems,
        });
        if (out) return { ...out, source: 'orchestrator' };
        // summarizeHearing returns null on failure and logs its own reason. Record
        // the DECISION here too, so the degradation is visible from this service's
        // logs alone rather than only from the client's.
        this.logger.warn(
          `brief synthesis unavailable session=${sessionId}; using deterministic assembly`,
        );
      } catch (err) {
        this.logger.warn(
          `brief synthesis via orchestrator failed: ${(err as Error).message}; using deterministic`,
        );
      }
    } else {
      this.logger.warn(
        `brief synthesis skipped session=${sessionId}: orchestrator not configured; ` +
          `using deterministic assembly`,
      );
    }
    // Deterministic fallback — fully sourced, no fabricated narrative.
    const topMentions = uniq(data.mentions.map((m) => m.label)).slice(0, 8);
    return {
      executiveSummary:
        `Hearing "${data.title}" produced ${data.quotes.length} flagged moment(s)` +
        (topMentions.length ? ` touching: ${topMentions.join(', ')}.` : '.') +
        ' This recap is a source-verified assembly, not a narrative synthesis:' +
        ' the summariser was unavailable when it ran, so every line below is' +
        ' verbatim from the transcript rather than analysed. Regenerating the' +
        ' recap retries the synthesis.',
      // Phrasing matters: the previous strings ("pending orchestrator
      // availability", "awaiting stance classifier") read as features that had not
      // shipped yet, so a transient failure looked like a permanent product gap.
      // Both are retryable failures and should say so.
      tone: 'not assessed — no synthesis was available for this recap',
      risks: [],
      opportunities: [],
      recommendedNextSteps: data.actionItems,
      draftClientEmail: {
        subject: `Hearing recap: ${data.title}`,
        body:
          `Hi,\n\nHere is a quick recap of "${data.title}".\n\n` +
          data.quotes
            .slice(0, 5)
            .map((q) => `• ${q.speakerName ? q.speakerName + ': ' : ''}"${q.text}"`)
            .join('\n') +
          `\n\nWe will follow up with a fuller analysis.\n\nBest,\nCapiro`,
      },
      source: 'deterministic',
    };
  }

  private reveal(q: {
    textCiphertext: string | null;
    iv: string | null;
    authTag: string | null;
    textPlain: string | null;
  }): string {
    if (q.textPlain != null) return q.textPlain;
    if (q.textCiphertext && q.iv && q.authTag && this.crypto.configured) {
      try {
        return this.crypto.decrypt({
          textCiphertext: q.textCiphertext,
          iv: q.iv,
          authTag: q.authTag,
        });
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

/**
 * Placeholders `reveal()` returns when text cannot be recovered (no key, or a
 * failed decrypt). They are honest to show inline next to a quote, but must never
 * be treated as content — matched on, listed as a supporter, or fed to the model as
 * if it were an entity label.
 */
const UNREVEALED = new Set(['[encrypted]', '[decryption unavailable]']);

function isRevealed(text: string): boolean {
  return Boolean(text) && !UNREVEALED.has(text);
}
