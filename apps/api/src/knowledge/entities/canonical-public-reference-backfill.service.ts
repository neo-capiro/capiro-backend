import { BadRequestException, Injectable } from '@nestjs/common';
import { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import { CanonicalPublicReferenceBackfillRepository } from './canonical-public-reference-backfill.repository.js';
import {
  CANONICAL_PUBLIC_REFERENCE_SOURCES,
  type CanonicalPublicReferenceBackfillInput,
  type CanonicalPublicReferenceBackfillResult,
  type CanonicalPublicReferenceRecord,
  type CanonicalPublicReferenceSource,
} from './canonical-public-reference-backfill.types.js';

const DEFAULT_BATCH_SIZE = 100;

/**
 * Resumable system backfill for trusted public reference identities. This
 * service deliberately delegates every write to the single canonical
 * registration boundary; it never writes canonical identity tables directly.
 */
@Injectable()
export class CanonicalPublicReferenceBackfillService {
  constructor(
    private readonly repository: CanonicalPublicReferenceBackfillRepository,
    private readonly registration: CanonicalEntityRegistrationService,
  ) {}

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
