import { createHash } from 'node:crypto';
import { assertPublicHearingBoundary } from './public-hearing-boundary.js';
import {
  PUBLIC_HEARING_INSIGHT_TYPES,
  type PublicHearingContext,
  type PublicHearingInsight,
  type PublicHearingInsightDraft,
  type PublicHearingInsightExtractor,
  type PublicHearingInsightProcessingResult,
  type PublicTranscriptSegmentInput,
} from './public-hearing-intelligence.types.js';
import { extractDeterministicPublicHearingInsights } from './deterministic-public-hearing-extractor.js';

const INSIGHT_TYPES = new Set<string>(PUBLIC_HEARING_INSIGHT_TYPES);

export interface PublicHearingIntelligenceProcessorOptions {
  extractors?: readonly PublicHearingInsightExtractor[];
  now?: () => Date;
  onExtractorFailure?: (failure: { extractor: string; message: string }) => void;
}

interface DraftEnvelope {
  draft: PublicHearingInsightDraft;
  extractor: string;
  extractorVersion: string;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
}

function stableId(input: {
  hearingId: string;
  segmentId: string;
  type: string;
  extractor: string;
  summary: string;
}): string {
  const digest = createHash('sha256')
    .update(
      [
        input.hearingId,
        input.segmentId,
        input.type,
        input.extractor,
        input.summary.toLowerCase(),
      ].join('\u001f'),
    )
    .digest('hex')
    .slice(0, 32);
  return `phi_${digest}`;
}

function normalizeDraft(envelope: DraftEnvelope): DraftEnvelope | null {
  if (!INSIGHT_TYPES.has(envelope.draft.insightType)) return null;
  const title = cleanText(envelope.draft.title, 240);
  const summary = cleanText(envelope.draft.summary, 4_000);
  if (!title || !summary) return null;
  const evidenceText = cleanText(envelope.draft.evidenceText, 4_000) || undefined;
  const speakerName = cleanText(envelope.draft.speakerName, 240) || undefined;
  const confidence =
    typeof envelope.draft.confidence === 'number' && Number.isFinite(envelope.draft.confidence)
      ? Math.max(0, Math.min(1, envelope.draft.confidence))
      : undefined;
  const entities = (envelope.draft.entities ?? [])
    .map((entity) => ({
      entityType: entity.entityType,
      label: cleanText(entity.label, 300),
      canonicalId: cleanText(entity.canonicalId, 300) || undefined,
    }))
    .filter((entity) => Boolean(entity.label));

  return {
    ...envelope,
    draft: {
      insightType: envelope.draft.insightType,
      title,
      summary,
      evidenceText,
      speakerName,
      confidence,
      preliminary: Boolean(envelope.draft.preliminary),
      entities,
    },
  };
}

function materialize(
  envelope: DraftEnvelope,
  input: {
    segment: PublicTranscriptSegmentInput;
    context: PublicHearingContext;
    createdAt: string;
  },
): PublicHearingInsight {
  const id = stableId({
    hearingId: input.context.hearingId,
    segmentId: input.segment.id,
    type: envelope.draft.insightType,
    extractor: envelope.extractor,
    summary: envelope.draft.summary,
  });
  return {
    id,
    hearingId: input.context.hearingId,
    captureId: input.segment.captureId,
    segmentId: input.segment.id,
    sequence: input.segment.sequence,
    startMs: input.segment.startMs,
    endMs: input.segment.endMs,
    insightType: envelope.draft.insightType,
    title: envelope.draft.title,
    summary: envelope.draft.summary,
    evidenceText: envelope.draft.evidenceText,
    speakerName: envelope.draft.speakerName,
    confidence: envelope.draft.confidence,
    preliminary: envelope.draft.preliminary,
    entities: envelope.draft.entities ?? [],
    extractor: envelope.extractor,
    extractorVersion: envelope.extractorVersion,
    createdAt: input.createdAt,
  };
}

function dedupe(insights: PublicHearingInsight[]): PublicHearingInsight[] {
  const seen = new Set<string>();
  return insights.filter((insight) => {
    const entityKey = (insight.entities ?? [])
      .map((entity) => `${entity.entityType}:${entity.canonicalId ?? entity.label}`)
      .sort()
      .join('|');
    const key = [
      insight.segmentId,
      insight.insightType,
      insight.summary.toLowerCase(),
      entityKey.toLowerCase(),
    ].join('\u001f');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Global public-hearing intelligence processor.
 *
 * Deterministic extraction always runs. Optional model/registry extractors are
 * additive and isolated with Promise.allSettled: one provider failure can never
 * suppress deterministic questions, commitments, bills, funding amounts, dates,
 * agencies, or Program Element references.
 */
export class PublicHearingIntelligenceProcessor {
  private readonly extractors: readonly PublicHearingInsightExtractor[];
  private readonly now: () => Date;
  private readonly onExtractorFailure?: PublicHearingIntelligenceProcessorOptions['onExtractorFailure'];

  constructor(options: PublicHearingIntelligenceProcessorOptions = {}) {
    this.extractors = options.extractors ?? [];
    this.now = options.now ?? (() => new Date());
    this.onExtractorFailure = options.onExtractorFailure;
  }

  async processSegment(input: {
    segment: PublicTranscriptSegmentInput;
    context: PublicHearingContext;
  }): Promise<PublicHearingInsightProcessingResult> {
    if (input.segment.hearingId !== input.context.hearingId) {
      throw new Error(
        `Public transcript segment hearing ${input.segment.hearingId} does not match context ${input.context.hearingId}`,
      );
    }
    assertPublicHearingBoundary(input);

    const deterministic: DraftEnvelope[] = extractDeterministicPublicHearingInsights(input).map(
      (draft) => ({
        draft,
        extractor: 'deterministic-public-facts',
        extractorVersion: '1',
      }),
    );

    const optionalResults = await Promise.allSettled(
      this.extractors.map(async (extractor) => ({
        extractor,
        drafts: await extractor.extract(input),
      })),
    );

    const failures: PublicHearingInsightProcessingResult['extractorFailures'] = [];
    const optional: DraftEnvelope[] = [];
    optionalResults.forEach((result, index) => {
      const extractor = this.extractors[index];
      if (!extractor) return;
      if (result.status === 'rejected') {
        const failure = {
          extractor: extractor.name,
          message: boundedError(result.reason),
        };
        failures.push(failure);
        this.onExtractorFailure?.(failure);
        return;
      }
      for (const draft of result.value.drafts ?? []) {
        optional.push({
          draft,
          extractor: extractor.name,
          extractorVersion: extractor.version,
        });
      }
    });

    const createdAt = this.now().toISOString();
    const materialized = [...deterministic, ...optional]
      .map(normalizeDraft)
      .filter((value): value is DraftEnvelope => Boolean(value))
      .map((envelope) =>
        materialize(envelope, {
          segment: input.segment,
          context: input.context,
          createdAt,
        }),
      );
    const insights = dedupe(materialized);
    assertPublicHearingBoundary(insights);
    return { insights, extractorFailures: failures };
  }

  async processBatch(input: {
    segments: readonly PublicTranscriptSegmentInput[];
    context: PublicHearingContext;
  }): Promise<PublicHearingInsightProcessingResult> {
    const insights: PublicHearingInsight[] = [];
    const extractorFailures: PublicHearingInsightProcessingResult['extractorFailures'] = [];
    for (const segment of [...input.segments].sort((left, right) => left.sequence - right.sequence)) {
      const result = await this.processSegment({ segment, context: input.context });
      insights.push(...result.insights);
      extractorFailures.push(...result.extractorFailures);
    }
    return {
      insights: dedupe(insights).sort(
        (left, right) =>
          left.sequence - right.sequence ||
          left.insightType.localeCompare(right.insightType) ||
          left.id.localeCompare(right.id),
      ),
      extractorFailures,
    };
  }
}
