import { BadRequestException, Injectable } from '@nestjs/common';
import type { KnowledgeJsonObject } from '../knowledge.types.js';
import { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import { CanonicalPublicReferenceBackfillRepository } from './canonical-public-reference-backfill.repository.js';
import {
  CANONICAL_PUBLIC_REFERENCE_SOURCES,
  type CanonicalPublicReferenceBackfillInput,
  type CanonicalPublicReferenceBackfillResult,
  type CanonicalPublicReferenceRecord,
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
      failures: [],
      entityIds: [],
    };

    for (const row of rows) {
      if (!isEligible(row)) {
        result.skipped += 1;
        result.nextCursor = row.cursorKey;
        continue;
      }
      result.eligible += 1;

      if (!execute) {
        result.nextCursor = row.cursorKey;
        continue;
      }

      try {
        const registrationResult = await invokeRegistration(this.registration, row);
        const entityId = readEntityId(registrationResult);
        if (entityId) result.entityIds.push(entityId);
        result.processed += 1;
        result.nextCursor = row.cursorKey;
      } catch (error) {
        result.failures.push({
          sourceId: row.sourceId,
          message: sanitizeError(error),
        });
        // Stop on the first failure. The returned cursor remains at the last
        // successful row, making the retry deterministic and lossless.
        result.exhausted = false;
        break;
      }
    }

    return result;
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

/**
 * Compatibility shim around the shared registration boundary. Phase 5 evolved
 * the DTO name from `identifiers` to `authoritativeIdentifiers`; sending both
 * keeps this backfill compatible across the rolling branch while the
 * registration service ignores the unused extra field. There is still one
 * writer and one policy decision point.
 */
async function invokeRegistration(
  service: CanonicalEntityRegistrationService,
  row: CanonicalPublicReferenceRecord,
): Promise<unknown> {
  const identifiers = row.identifiers.map((identifier) => ({
    identifierType: identifier.type,
    identifierValue: identifier.value,
    type: identifier.type,
    value: identifier.value,
    sourceType: row.source,
    sourceId: row.sourceId,
    confidence: 1,
    verifiedAt: row.observedAt,
  }));
  const aliases = row.aliases.map((alias) => ({
    alias,
    sourceType: row.source,
    sourceId: row.sourceId,
    confidence: 1,
    verifiedAt: row.observedAt,
  }));

  const command: Record<string, unknown> = {
    entityType: row.entityType,
    canonicalName: row.canonicalName,
    identityScope: 'global_public',
    resolutionMethod: `authoritative_${row.source}`,
    resolutionConfidence: 1,
    sourceType: row.source,
    sourceId: row.sourceId,
    observedAt: row.observedAt,
    identifiers,
    authoritativeIdentifiers: identifiers,
    aliases,
    metadata: {
      ...(row.metadata as KnowledgeJsonObject),
      authoritativeSource: row.source,
      authoritativeSourceId: row.sourceId,
      observedAt: row.observedAt.toISOString(),
    },
  };

  const boundary = service as unknown as {
    registerGlobalPublicEntity: (input: Record<string, unknown>) => Promise<unknown>;
  };
  return boundary.registerGlobalPublicEntity(command);
}

function readEntityId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  if (record.entity && typeof record.entity === 'object') {
    const entity = record.entity as Record<string, unknown>;
    if (typeof entity.id === 'string') return entity.id;
  }
  return null;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}
