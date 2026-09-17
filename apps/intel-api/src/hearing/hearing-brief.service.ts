import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { HearingCryptoService } from './hearing-crypto.service.js';
import { OrchestratorClient } from './orchestrator.client.js';
import {
  ClientBriefContextClient,
  type BriefRelevanceBand,
  type ClientBriefContext,
  type PostHearingClientInput,
} from './client-brief-context.client.js';

/**
 * H4 — Post-Hearing Brief generator (the MVP deliverable).
 *
 * Generates an authored summary and thematic developments from the available
 * FINAL transcript. Development references are validated against the supplied
 * source and mapped to transcript timestamps. Conditional client advice remains
 * distinct from recorded statements. Unavailable synthesis returns a retryable
 * error; it never substitutes a deterministic report.
 *
 * CLIENT-AWARE (2026-09): when the caller names a client, the brief is written
 * FOR that client. apps/api supplies the client's name and its stored relevance
 * for this hearing (why it matters, matched priorities, implications — the same
 * result the hearing detail page shows); the orchestrator compiles that client's
 * steering. Until this the docstring above promised "client-specific
 * risks/opportunities" that nothing downstream could deliver: generation never
 * knew which client, and the invoke path never compiled client steering.
 */
export type HearingBriefClientContextStatus = 'applied' | 'unavailable' | 'none';

export interface HearingBriefClientContext {
  clientId: string | null;
  clientName: string | null;
  /** See PostHearingClientContextStatus in @capiro/meriv2-core for the semantics. */
  status: HearingBriefClientContextStatus;
  relevanceBand: BriefRelevanceBand | null;
}

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
  claimMap: Array<{ claimId: string; segmentId: string; timestampMs: number; endMs?: number }>;
  synthesisSource: 'orchestrator' | 'deterministic';
  clientContext: HearingBriefClientContext;
  /** Model-authored concise report title; absent when synthesis unavailable. */
  summaryTitle?: string;
  /** Thematic authored developments; machine IDs in evidenceIds are trace-only. */
  keyDevelopments?: Array<{ title: string; text: string; evidenceIds: string[] }>;
  /**
   * Honest coverage disclosure. availableSegments counts ALL stored FINAL
   * transcript rows (including ones that could not be decrypted/read), so a
   * fully-readable capture is not falsely reported as complete when encrypted
   * rows were excluded; includedSegments is what was actually fed to the model.
   */
  sourceCoverage?: {
    availableSegments: number;
    includedSegments: number;
    startMs: number;
    endMs: number;
    /** True when coverage is partial: omitted rows OR any truncated segment. */
    limited: boolean;
    /** Segments omitted by the coverage bound (disclosed, never silent). */
    omittedSegments?: number;
    /** Included segments truncated to the per-segment wire cap (disclosed). */
    truncatedSegments?: number;
  };
}

/** Bands that carry a real matched signal; NONE/INSUFFICIENT are honest absences. */
const MATCHED_BANDS: ReadonlySet<BriefRelevanceBand> = new Set(['HIGH', 'MEDIUM', 'LOW']);

@Injectable()
export class HearingBriefService {
  private readonly logger = new Logger(HearingBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: HearingCryptoService,
    private readonly orchestrator: OrchestratorClient,
    private readonly clientContext: ClientBriefContextClient,
  ) {}

  async generate(
    tenantId: string,
    sessionId: string,
    /** Delegated to MeriV2 for service-to-service auth; no raw user token is
     *  relayed any more. */
    clerkUserId: string,
    /** The client the recap is written FOR; null keeps the client-agnostic brief. */
    clientId: string | null = null,
  ): Promise<HearingBrief | null> {
    const session = await this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findFirst({ where: { id: sessionId, tenantId } }),
    );
    if (!session) return null;

    // The client-context hop runs alongside the derived-table reads, not after
    // them, so it cannot lengthen the critical path beyond its own bound.
    const clientContextPromise: Promise<ClientBriefContext | null> = clientId
      ? this.clientContext.fetch({
          tenantId,
          clientId,
          hearingId: session.hearingId ?? null,
        })
      : Promise.resolve(null);

    const [[quotes, actionItems, mentions, cards, transcriptSegments], clientCtx] =
      await Promise.all([
        this.prisma.withTenant(tenantId, (tx) =>
          Promise.all([
            tx.keyQuote.findMany({ where: { tenantId, sessionId }, orderBy: { startMs: 'asc' } }),
            tx.liveActionItem.findMany({ where: { tenantId, sessionId } }),
            tx.entityMention.findMany({ where: { tenantId, sessionId } }),
            tx.liveSummaryCard.findMany({
              where: { tenantId, sessionId },
              orderBy: { startMs: 'asc' },
            }),
            // FINAL transcript segments only, chronological across the WHOLE
            // recording — the raw material for an authored recap (late material
            // and adjacent context included, never only the earliest quotes).
            tx.transcriptSegment.findMany({
              where: { tenantId, sessionId, isFinal: true },
              orderBy: { startMs: 'asc' },
            }),
          ]),
        ),
        clientContextPromise,
      ]);

    const revealedQuotes = quotes.map((q) => ({
      segmentId: q.segmentId,
      timestampMs: q.startMs,
      speakerName: q.speakerName ?? undefined,
      text: this.reveal(q),
      issueTags: q.issueTags,
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

    // Supporters/opponents are NOT derived from summary-card titles (card titles
    // are not a verified stance/identity — the old regex promoted card titles like
    // "Manatee Population Concern" to opponents). Left empty until a real stance
    // classifier persists structured stance.
    const supporters: string[] = [];
    const opponents: string[] = [];

    const client: PostHearingClientInput | null = clientId
      ? {
          clientId,
          name: clientCtx?.clientName ?? null,
          relevance: clientCtx?.relevance
            ? {
                band: clientCtx.relevance.band,
                whyItMatters: clientCtx.relevance.whyItMatters,
                matchedPriorities: clientCtx.relevance.matchedPriorities,
                implications: clientCtx.relevance.implications,
              }
            : null,
        }
      : null;

    // Decrypt FINAL transcript segments into a usable narrative source.
    // availableSegments counts EVERY stored FINAL row (including ones we could
    // not reveal) so a capture with unreadable rows is never reported as fully
    // covered; includedSegments counts only what actually went to the model.
    const availableSegments = transcriptSegments.length;
    const usable = transcriptSegments
      .map((s) => ({
        segmentId: s.id,
        startMs: s.startMs,
        endMs: s.endMs,
        speakerLabel: s.speakerLabel ?? null,
        text: this.reveal({
          textCiphertext: s.textCiphertext,
          iv: s.iv,
          authTag: s.authTag,
          textPlain: s.textPlain,
        }),
      }))
      .filter((s) => isRevealed(s.text) && s.text.trim().length > 0);
    // Bounded chronological coverage across the WHOLE recording, preserving
    // adjacent context and LATE material: take a head/middle/tail spread when
    // the source exceeds the bound rather than only the earliest X. Bounded by
    // BOTH segment count and total characters so long hearings fit the model.
    const narrativeSource = boundNarrativeSource(
      usable,
      MAX_NARRATIVE_SEGMENTS,
      MAX_NARRATIVE_CHARS,
    );

    // No usable transcript => no recap. Decided BEFORE any model call, even if
    // legacy quote/action tables still hold rows (a recap cannot be authored
    // from flagged quotes alone).
    if (narrativeSource.length === 0) return null;

    const sourceCoverage = {
      availableSegments,
      includedSegments: narrativeSource.included.length,
      startMs: narrativeSource.included[0]!.startMs,
      endMs: narrativeSource.included[narrativeSource.included.length - 1]!.endMs,
      // Partial coverage = omitted rows OR any truncated segment (a fully-listed
      // but truncated capture is still not the complete verbatim source).
      limited: narrativeSource.included.length < availableSegments || narrativeSource.truncated > 0,
      // Truthful disclosure: every stored FINAL row not fed to the model,
      // INCLUDING unreadable/encrypted rows (available - included).
      omittedSegments: availableSegments - narrativeSource.included.length,
      truncatedSegments: narrativeSource.truncated,
    };

    // Require an authored recap from the orchestrator.
    const synth = await this.synthesize(tenantId, sessionId, clerkUserId, {
      title: session.title,
      quotes: revealedQuotes,
      mentions: revealedMentions.filter((m) => isRevealed(m.label)),
      actionItems: revealedActionItems.filter(isRevealed),
      client,
      narrativeSource: narrativeSource.included,
    });

    // No usable LLM synthesis for a transcript-backed recap is a hard
    // unavailable — never sell a stitched deterministic assembly as a
    // generated recap. (Zero usable transcript already returned null above, so
    // reaching here always means a transcript existed but synthesis failed.)
    if (synth.source !== 'orchestrator') {
      throw new ServiceUnavailableException({
        code: 'HEARING_RECAP_SYNTHESIS_UNAVAILABLE',
        message:
          'A transcript is available but the recap synthesis service was unreachable or returned ' +
          'unusable output. Retry to regenerate the recap.',
      });
    }

    // claimMap is the machine-readable source map the UI uses to translate a
    // keyDevelopments evidenceId to a timestamp/range. It must cover EVERY
    // segment the model could cite (the whole narrative source), not just the
    // legacy flagged quotes — otherwise new claims have unresolvable refs.
    // `endMs` lets the UI compact contiguous cited microsegments into exact
    // readable time ranges (no invented end times). claimId is stable.
    const claimMap = narrativeSource.included.map((s, i) => ({
      claimId: `narr-${i}`,
      segmentId: s.segmentId,
      timestampMs: s.startMs,
      endMs: s.endMs,
    }));

    // Authoritative here, not in the tool: an older orchestrator that predates
    // `clientContext` must still yield an honest
    // status, and matched relevance is client context whether or not the model ran.
    const relevanceMatched = Boolean(client?.relevance && MATCHED_BANDS.has(client.relevance.band));
    const status: HearingBriefClientContextStatus = !clientId
      ? 'none'
      : synth.clientContext === 'applied' || relevanceMatched
        ? 'applied'
        : 'unavailable';

    return {
      sessionId,
      title: session.title,
      generatedAt: new Date().toISOString(),
      executiveSummary: synth.executiveSummary,
      // Legacy field retained for type compatibility, but the authored recap no
      // longer surfaces clipped quote fragments as "key moments" — that was the
      // poor-recap failure mode. The synthesized body lives in keyDevelopments.
      keyMoments: [],
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
      // Validated model output stays as-is; an empty list stays empty (no
      // fallback to raw action items — recommendations must be model-authored).
      recommendedNextSteps: synth.recommendedNextSteps,
      draftClientEmail: synth.draftClientEmail,
      claimMap,
      synthesisSource: synth.source,
      summaryTitle: synth.summaryTitle,
      keyDevelopments: synth.keyDevelopments,
      sourceCoverage,
      clientContext: {
        clientId,
        clientName: clientCtx?.clientName ?? null,
        status,
        relevanceBand: client?.relevance?.band ?? null,
      },
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
      client: PostHearingClientInput | null;
      narrativeSource: Array<{
        segmentId: string;
        text: string;
        startMs: number;
        endMs: number;
        speakerLabel: string | null;
      }>;
    },
  ): Promise<
    | {
        executiveSummary: string;
        tone: string;
        risks: string[];
        opportunities: string[];
        recommendedNextSteps: string[];
        draftClientEmail: { subject: string; body: string };
        source: 'orchestrator';
        clientContext: HearingBriefClientContextStatus | null;
        summaryTitle?: string;
        keyDevelopments?: Array<{ title: string; text: string; evidenceIds: string[] }>;
      }
    | { source: 'unavailable' }
  > {
    // Log the INPUT VOLUME unconditionally. A recap can be poor for two entirely
    // different reasons — synthesis unavailable, or synthesis starved of source
    // material — and they are indistinguishable in the output. On 2026-07-29 both
    // happened at once: the orchestrator aborted AND mentions was empty (every
    // entity mention had been computed and then discarded by the sensitive-session
    // storage rule, since EntityMention has no encrypted text column yet).
    this.logger.log(
      `brief inputs session=${sessionId} quotes=${data.quotes.length} ` +
        `mentions=${data.mentions.length} actionItems=${data.actionItems.length} ` +
        `narrative=${data.narrativeSource.length} ` +
        `client=${data.client?.clientId ?? '-'} relevance=${data.client?.relevance?.band ?? '-'}`,
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
          client: data.client,
          narrativeSource: data.narrativeSource.length ? data.narrativeSource : undefined,
        });
        // Validate the authored recap before treating it as a success: a partial
        // or rolling-deploy response (missing/empty summary, no developments, or
        // references outside the supplied narrative source) is NOT a valid recap
        // and must fall through to unavailable rather than surface as fake success.
        if (out && this.isValidNarrativeRecap(out, data.narrativeSource)) {
          return {
            ...out,
            source: 'orchestrator',
            clientContext: out.clientContext ?? null,
            summaryTitle: out.summaryTitle,
            keyDevelopments: out.keyDevelopments,
          };
        }
        if (out) {
          this.logger.warn(
            `brief synthesis returned an invalid narrative recap session=${sessionId} ` +
              `(summary=${out.executiveSummary ? 'ok' : 'empty'} developments=${out.keyDevelopments?.length ?? 0}); ` +
              `treating as unavailable`,
          );
        } else {
          this.logger.warn(
            `brief synthesis unavailable session=${sessionId}; orchestrator returned no result`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `brief synthesis via orchestrator failed: ${(err as Error).message}; treating as unavailable`,
        );
      }
    } else {
      this.logger.warn(`brief synthesis skipped session=${sessionId}: orchestrator not configured`);
    }
    // No usable LLM synthesis — signal unavailable to the caller (503). The
    // service NEVER stitches a deterministic recap from flagged quotes and sells
    // it as a generated brief; that is exactly the poor-recap failure mode.
    return { source: 'unavailable' };
  }

  /**
   * A narrative recap is valid only when the model actually authored it and every
   * development reference resolves into the supplied narrative source. Rejects
   * empty/missing prose, empty developments, and foreign references.
   */
  private isValidNarrativeRecap(
    out: {
      executiveSummary?: string;
      keyDevelopments?: Array<{ title: string; text: string; evidenceIds: string[] }>;
    },
    narrativeSource: Array<{ segmentId: string }>,
  ): boolean {
    if (!out.executiveSummary || !out.executiveSummary.trim()) return false;
    const devs = out.keyDevelopments;
    if (!Array.isArray(devs) || devs.length === 0) return false;
    const validIds = new Set(narrativeSource.map((s) => s.segmentId));
    for (const d of devs) {
      if (!d || typeof d.title !== 'string' || !d.title.trim()) return false;
      if (typeof d.text !== 'string' || !d.text.trim()) return false;
      if (!Array.isArray(d.evidenceIds) || d.evidenceIds.length === 0) return false;
      for (const id of d.evidenceIds) {
        if (!validIds.has(id)) return false;
      }
    }
    return true;
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

/**
 * Bounded chronological narrative coverage across the WHOLE recording.
 *
 * The old recap silently fed only the earliest flagged quotes; this instead
 * selects a head / middle / tail spread of the available FINAL segments so
 * LATE material and adjacent context survive the bound. Bounded by BOTH a
 * segment ceiling and a total-character ceiling so a long hearing fits the
 * model. Selection is evenly spaced (never clustered at the start) and stays
 * in original chronological order. Returns `{ included }` so the caller can
 * report honest coverage (`included.length < availableSegments` ⇒ limited).
 */
const MAX_NARRATIVE_SEGMENTS = 500;
const MAX_NARRATIVE_CHARS = 120000; // ~30k tokens of transcript, leaves room for output

interface NarrativeSegment {
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
}

/** Per-segment wire cap (mirrors the tool's narrativeSource.text max 20000). */
const MAX_SEGMENT_TEXT = 20000;

/**
 * Bounded chronological narrative coverage across the WHOLE recording.
 *
 * Selection is a set of CONTIGUOUS windows spread head/middle/tail across the
 * recording (not isolated every-Nth fragments), so adjacent speaker context
 * and LATE material survive the bound. The FIRST and LAST segments of the
 * recording are always retained. Bounded by a segment ceiling, a total-char
 * ceiling and a per-segment char cap. Returns `{ included, omitted, truncated }`
 * so the caller can disclose coverage truthfully.
 */
function boundNarrativeSource(
  usable: NarrativeSegment[],
  maxSegments: number,
  maxChars: number,
): { included: NarrativeSegment[]; omitted: number; truncated: number; length: number } {
  const total = usable.length;
  if (total === 0) return { included: [], omitted: 0, truncated: 0, length: 0 };

  const totalChars = usable.reduce((n, s) => n + s.text.length, 0);
  let selected = usable;
  if (total > maxSegments || totalChars > maxChars) {
    // Contiguous windows: split the recording into `windows` equal contiguous
    // blocks and keep a slice from each, preserving order and adjacency. First
    // and last segments are force-retained afterwards.
    const target = Math.min(maxSegments, total);
    const windows = Math.max(2, Math.min(6, Math.floor(target / 20) || 2));
    const perWindow = Math.max(1, Math.floor(target / windows));
    const picked = new Set<number>();
    for (let w = 0; w < windows; w++) {
      const blockStart = Math.floor((w * total) / windows);
      for (let i = 0; i < perWindow && blockStart + i < total; i++) picked.add(blockStart + i);
    }
    // Always keep the first and last segments of the recording.
    picked.add(0);
    picked.add(total - 1);
    selected = usable.filter((_, i) => picked.has(i));

    // Char bound: drop from the MIDDLE outward (never the first or last
    // segment) until the total fits.
    const overBy = () => selected.reduce((n, s) => n + s.text.length, 0) - maxChars;
    while (selected.length > 2 && overBy() > 0) {
      const mid = Math.floor(selected.length / 2);
      selected = selected.filter((_, i) => i !== mid);
    }
  }

  // Per-segment cap applied ONLY to included segments (truncated counts what
  // actually went to the model, not capped-then-omitted rows).
  let truncated = 0;
  const included = selected.map((s) => {
    if (s.text.length <= MAX_SEGMENT_TEXT) return s;
    truncated++;
    return { ...s, text: s.text.slice(0, MAX_SEGMENT_TEXT) };
  });

  return {
    included,
    omitted: total - included.length,
    truncated,
    length: included.length,
  };
}
