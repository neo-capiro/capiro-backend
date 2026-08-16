import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import { CanonicalPublicReferenceBackfillRepository } from './canonical-public-reference-backfill.repository.js';
import {
  CANONICAL_PUBLIC_REFERENCE_SOURCES,
  type CanonicalPublicReferenceBackfillInput,
  type CanonicalPublicReferenceBackfillResult,
  type CanonicalPublicReferenceRecord,
  type CanonicalPublicReferenceSource,
} from './canonical-public-reference-backfill.types.js';
import {
  CanonicalEntityBackfillCheckpointRepository,
  type CanonicalEntityBackfillCheckpointRecord,
} from './canonical-entity-backfill-checkpoint.repository.js';

const DEFAULT_BATCH_SIZE = 100;

/**
 * Resumable system backfill for trusted public reference identities. This
 * service deliberately delegates every write to the single canonical
 * registration boundary; it never writes canonical identity tables directly.
 */
export interface CanonicalPublicReferenceBackfillRunToCompletionInput
  extends Omit<CanonicalPublicReferenceBackfillInput, 'cursor'> {
  /** Bounds how many pages one invocation processes before returning; omit to run to completion or failure. */
  maxPages?: number;
}

export interface CanonicalPublicReferenceBackfillRunToCompletionResult {
  pages: CanonicalPublicReferenceBackfillResult[];
  checkpoint: CanonicalEntityBackfillCheckpointRecord;
}

@Injectable()
export class CanonicalPublicReferenceBackfillService {
  constructor(
    private readonly repository: CanonicalPublicReferenceBackfillRepository,
    private readonly registration: CanonicalEntityRegistrationService,
    @Optional() private readonly checkpoints?: CanonicalEntityBackfillCheckpointRepository,
  ) {}

  /**
   * Durable, resumable driver over {@link run}: this source is global (no
   * tenant), so the checkpoint is keyed by (NULL tenant, source). Resumes from
   * the last persisted cursor rather than restarting, loops bounded pages
   * persisting the checkpoint after each, and is a no-op once the checkpoint
   * is already 'completed'.
   */
  async runToCompletion(
    input: CanonicalPublicReferenceBackfillRunToCompletionInput,
  ): Promise<CanonicalPublicReferenceBackfillRunToCompletionResult> {
    if (!this.checkpoints) {
      throw new BadRequestException(
        'runToCompletion requires a CanonicalEntityBackfillCheckpointRepository.',
      );
    }

    const existing = await this.checkpoints.startOrResume(null, input.source);
    if (existing.status === 'completed') {
      return { pages: [], checkpoint: existing };
    }

    const pages: CanonicalPublicReferenceBackfillResult[] = [];
    let cursor = existing.cursor;
    const maxPages = input.maxPages ?? Number.POSITIVE_INFINITY;
    let checkpoint = existing;

    for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
      const page = await this.run({ ...input, cursor });
      pages.push(page);

      const firstFailure = page.failures[0];
      checkpoint = await this.checkpoints.recordPage(null, input.source, {
        nextCursor: page.nextCursor,
        scanned: page.scanned,
        created: page.processed,
        linked: 0,
        ambiguous: page.ambiguous,
        skipped: page.skipped,
        failed: page.failed,
        complete: page.complete,
        errorMessage: firstFailure ? firstFailure.message : null,
      });

      cursor = page.nextCursor;
      if (page.complete || firstFailure) break;
    }

    return { pages, checkpoint };
  }

  async run(
    input: CanonicalPublicReferenceBackfillInput,
  ): Promise<CanonicalPublicReferenceBackfillResult> {
    if (!CANONICAL_PUBLIC_REFERENCE_SOURCES.includes(input.source)) {
      throw new BadRequestException(
        `Unsupported canonical public reference source: ${input.source}`,
      );
    }

    const execute = input.execute === true;
    const limit = input.limit ?? DEFAULT_BATCH_SIZE;
    const requestedCursor = normalizeCursor(input.cursor);
    const rows = await this.repository.listBatch(input.source, requestedCursor, limit);

    const result: CanonicalPublicReferenceBackfillResult = {
      source: input.source,
      execute,
      requestedCursor,
      nextCursor: requestedCursor,
      exhausted: rows.length < limit,
      scanned: rows.length,
      eligible: 0,
      processed: 0,
      skipped: 0,
      wouldCreate: 0,
      wouldLink: 0,
      ambiguous: 0,
      failed: 0,
      failures: [],
      entityIds: [],
      complete: rows.length < limit,
    };

    for (const row of rows) {
      if (!isEligible(row)) {
        result.skipped += 1;
        result.nextCursor = row.cursorKey;
        continue;
      }
      result.eligible += 1;

      if (!execute) {
        result.wouldCreate += 1;
        result.nextCursor = row.cursorKey;
        continue;
      }

      try {
        const entity = await this.registration.registerGlobalPublicEntity(
          registrationInput(row),
        );
        result.entityIds.push(entity.id);
        result.processed += 1;
        result.nextCursor = row.cursorKey;
      } catch (error) {
        result.failed += 1;
        result.failures.push({
          sourceId: row.sourceId,
          message: sanitizeError(error),
        });
        // Stop on the first failure. The returned cursor remains at the last
        // successful row, making the retry deterministic and lossless.
        result.exhausted = false;
        result.complete = false;
        break;
      }
    }

    result.complete = result.exhausted && result.failures.length === 0;

    return result;
  }
}

function registrationInput(row: CanonicalPublicReferenceRecord) {
  const sourceType = authoritativeSourceType(row.source);
  return {
    entityType: row.entityType,
    canonicalName: row.canonicalName,
    resolutionMethod: sourceType,
    resolutionConfidence: 1,
    identifiers: row.identifiers.map((identifier) => ({
      type: identifier.type,
      value: identifier.value,
      sourceType,
      sourceId: row.sourceId,
      confidence: 1,
      verifiedAt: row.observedAt,
    })),
    aliases: row.aliases.map((value) => ({
      value,
      sourceType,
      sourceId: row.sourceId,
      confidence: 1,
      verifiedAt: row.observedAt,
    })),
    metadata: {
      ...row.metadata,
      authoritativeSource: row.source,
      authoritativeSourceId: row.sourceId,
      observedAt: row.observedAt.toISOString(),
    },
  };
}

export function authoritativeSourceType(
  source: CanonicalPublicReferenceSource,
): string {
  switch (source) {
    case 'federal_contractors':
      return 'federal_contractor';
    case 'congress_members':
      return 'congress_member';
    case 'congress_committees':
      return 'congress_committee';
    case 'acquisition_personnel':
      return 'capiro_directory';
    case 'program_elements':
      return 'program_element';
    case 'lda_clients':
      return 'lda_client';
    case 'sec_companies':
      return 'sec_filing';
  }
}

function normalizeCursor(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isEligible(row: CanonicalPublicReferenceRecord): boolean {
  return (
    row.canonicalName.trim().length > 0 &&
    row.identifiers.length > 0 &&
    row.identifiers.every(
      (identifier) =>
        identifier.type.trim().length > 0 && identifier.value.trim().length > 0,
    )
  );
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}
