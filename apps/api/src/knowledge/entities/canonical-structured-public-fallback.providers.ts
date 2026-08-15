import { Injectable } from '@nestjs/common';
import {
  CanonicalStructuredPublicLookupRepository,
  type StructuredIdentifierLookup,
  type StructuredPublicIdentityRecord,
} from './canonical-structured-public-lookup.repository.js';
import type {
  EntityResolutionFallbackLookupInput,
  EntityResolutionFallbackProvider,
  EntityResolutionFallbackResult,
} from './universal-entity-resolution-orchestrator.types.js';
import type { EntityResolutionStage } from './entity-resolution-stage-policy.js';

abstract class StructuredPublicFallbackProvider
  implements EntityResolutionFallbackProvider
{
  abstract readonly stage: EntityResolutionStage;

  constructor(
    protected readonly repository: CanonicalStructuredPublicLookupRepository,
  ) {}

  async lookup(
    input: EntityResolutionFallbackLookupInput,
  ): Promise<EntityResolutionFallbackResult> {
    const records = await this.lookupRecords(input.identifiers);
    return {
      stage: this.stage,
      sourceStatus: 'complete',
      candidates: records.map(toCandidate),
      conflictingIdentifiers: distinctIdentityCount(records) > 1,
    };
  }

  protected abstract lookupRecords(
    identifiers: readonly StructuredIdentifierLookup[],
  ): Promise<StructuredPublicIdentityRecord[]>;
}

@Injectable()
export class DirectoryGovernmentEntityResolutionProvider extends StructuredPublicFallbackProvider {
  readonly stage = 'directory_government_id' as const;

  constructor(repository: CanonicalStructuredPublicLookupRepository) {
    super(repository);
  }

  protected lookupRecords(identifiers: readonly StructuredIdentifierLookup[]) {
    return this.repository.findDirectoryGovernment(identifiers);
  }
}

@Injectable()
export class SamUeiEntityResolutionProvider extends StructuredPublicFallbackProvider {
  readonly stage = 'sam_uei_cage' as const;

  constructor(repository: CanonicalStructuredPublicLookupRepository) {
    super(repository);
  }

  protected lookupRecords(identifiers: readonly StructuredIdentifierLookup[]) {
    return this.repository.findSamUei(identifiers);
  }
}

@Injectable()
export class UsaSpendingEntityResolutionProvider extends StructuredPublicFallbackProvider {
  readonly stage = 'usaspending' as const;

  constructor(repository: CanonicalStructuredPublicLookupRepository) {
    super(repository);
  }

  protected lookupRecords(identifiers: readonly StructuredIdentifierLookup[]) {
    return this.repository.findUsaSpending(identifiers);
  }
}

@Injectable()
export class LdaEntityResolutionProvider extends StructuredPublicFallbackProvider {
  readonly stage = 'lda' as const;

  constructor(repository: CanonicalStructuredPublicLookupRepository) {
    super(repository);
  }

  protected lookupRecords(identifiers: readonly StructuredIdentifierLookup[]) {
    return this.repository.findLda(identifiers);
  }
}

@Injectable()
export class SecCikEntityResolutionProvider extends StructuredPublicFallbackProvider {
  readonly stage = 'sec_cik' as const;

  constructor(repository: CanonicalStructuredPublicLookupRepository) {
    super(repository);
  }

  protected lookupRecords(identifiers: readonly StructuredIdentifierLookup[]) {
    return this.repository.findSec(identifiers);
  }
}

export const STRUCTURED_PUBLIC_ENTITY_RESOLUTION_PROVIDER_CLASSES = [
  DirectoryGovernmentEntityResolutionProvider,
  SamUeiEntityResolutionProvider,
  UsaSpendingEntityResolutionProvider,
  LdaEntityResolutionProvider,
  SecCikEntityResolutionProvider,
] as const;

function toCandidate(record: StructuredPublicIdentityRecord) {
  return {
    candidateKey: `${record.sourceType}:${record.sourceId}`,
    canonicalName: record.canonicalName,
    entityType: record.entityType,
    aliases: record.aliases.map((value) => ({
      value,
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      confidence: 1,
      verifiedAt: record.observedAt,
    })),
    identifiers: [
      {
        type: record.identifierType,
        value: record.identifierValue,
        sourceType: record.sourceType,
        sourceId: record.sourceId,
        confidence: 1,
        verifiedAt: record.observedAt,
      },
    ],
    evidenceKinds: ['exact_authoritative_identifier'] as const,
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    sourceUrl: null,
    observedAt: record.observedAt,
    confidence: 1,
  };
}

function distinctIdentityCount(
  records: readonly StructuredPublicIdentityRecord[],
): number {
  return new Set(records.map((record) => `${record.sourceType}:${record.sourceId}`)).size;
}
