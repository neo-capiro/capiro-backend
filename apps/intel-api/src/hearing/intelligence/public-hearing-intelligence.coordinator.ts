import type {
  PublicHearingContext,
  PublicHearingInsight,
  PublicHearingInsightProcessingResult,
  PublicHearingInsightSink,
  PublicTranscriptSegmentInput,
  TenantHearingRelevanceContextProvider,
  TenantHearingRelevanceSink,
} from './public-hearing-intelligence.types.js';
import { PublicHearingIntelligenceProcessor } from './public-hearing-intelligence.processor.js';
import { TenantHearingRelevanceProcessor } from './tenant-hearing-relevance.processor.js';

export interface PublicHearingIntelligenceCoordinatorOptions {
  publicProcessor: PublicHearingIntelligenceProcessor;
  publicSink: PublicHearingInsightSink;
  tenantContextProvider?: TenantHearingRelevanceContextProvider;
  tenantProcessor?: TenantHearingRelevanceProcessor;
  tenantSink?: TenantHearingRelevanceSink;
  onTenantFailure?: (failure: { hearingId: string; message: string }) => void;
}

export interface PublicHearingIntelligenceCoordinatorResult
  extends PublicHearingInsightProcessingResult {
  publicPersisted: number;
  tenantMatchesPersisted: number;
  tenantFailures: Array<{ hearingId: string; message: string }>;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Coordinates the two deliberately separate intelligence rails:
 *
 * 1. Derive and persist public insights from canonical public transcript data.
 * 2. Only after that succeeds, load tenant contexts and persist tenant-owned
 *    relevance rows.
 *
 * A tenant relevance outage cannot roll back or suppress the global public
 * intelligence record.
 */
export class PublicHearingIntelligenceCoordinator {
  private readonly publicProcessor: PublicHearingIntelligenceProcessor;
  private readonly publicSink: PublicHearingInsightSink;
  private readonly tenantContextProvider?: TenantHearingRelevanceContextProvider;
  private readonly tenantProcessor?: TenantHearingRelevanceProcessor;
  private readonly tenantSink?: TenantHearingRelevanceSink;
  private readonly onTenantFailure?: PublicHearingIntelligenceCoordinatorOptions['onTenantFailure'];

  constructor(options: PublicHearingIntelligenceCoordinatorOptions) {
    this.publicProcessor = options.publicProcessor;
    this.publicSink = options.publicSink;
    this.tenantContextProvider = options.tenantContextProvider;
    this.tenantProcessor = options.tenantProcessor;
    this.tenantSink = options.tenantSink;
    this.onTenantFailure = options.onTenantFailure;

    const tenantPieces = [
      Boolean(this.tenantContextProvider),
      Boolean(this.tenantProcessor),
      Boolean(this.tenantSink),
    ];
    if (tenantPieces.some(Boolean) && !tenantPieces.every(Boolean)) {
      throw new Error(
        'Tenant relevance requires a context provider, processor, and sink together',
      );
    }
  }

  async processFinalSegment(input: {
    segment: PublicTranscriptSegmentInput;
    context: PublicHearingContext;
  }): Promise<PublicHearingIntelligenceCoordinatorResult> {
    if (!input.segment.isFinal) {
      throw new Error('Only final canonical transcript segments may be persisted as live intelligence');
    }

    const publicResult = await this.publicProcessor.processSegment(input);
    await this.publicSink.upsertMany(publicResult.insights);

    const tenantFailures: PublicHearingIntelligenceCoordinatorResult['tenantFailures'] = [];
    let tenantMatchesPersisted = 0;
    if (this.tenantContextProvider && this.tenantProcessor && this.tenantSink) {
      try {
        const contexts = await this.tenantContextProvider.contextsForHearing(input.context.hearingId);
        for (const tenantContext of contexts) {
          try {
            const matches = this.tenantProcessor.score({
              insights: publicResult.insights,
              context: input.context,
              tenantContext,
            });
            if (matches.length) {
              await this.tenantSink.upsertMany(matches);
              tenantMatchesPersisted += matches.length;
            }
          } catch (error) {
            const failure = {
              hearingId: input.context.hearingId,
              message: boundedError(error),
            };
            tenantFailures.push(failure);
            this.onTenantFailure?.(failure);
          }
        }
      } catch (error) {
        const failure = {
          hearingId: input.context.hearingId,
          message: boundedError(error),
        };
        tenantFailures.push(failure);
        this.onTenantFailure?.(failure);
      }
    }

    return {
      ...publicResult,
      publicPersisted: publicResult.insights.length,
      tenantMatchesPersisted,
      tenantFailures,
    };
  }

  async backfill(input: {
    segments: readonly PublicTranscriptSegmentInput[];
    context: PublicHearingContext;
  }): Promise<{
    insights: PublicHearingInsight[];
    publicPersisted: number;
    extractorFailures: PublicHearingInsightProcessingResult['extractorFailures'];
  }> {
    const result = await this.publicProcessor.processBatch({
      segments: input.segments.filter((segment) => segment.isFinal),
      context: input.context,
    });
    await this.publicSink.upsertMany(result.insights);
    return {
      insights: result.insights,
      publicPersisted: result.insights.length,
      extractorFailures: result.extractorFailures,
    };
  }
}
