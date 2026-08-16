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
  protected abstract readonly recognizedIdentifierTypes: ReadonlySet<string>;
  protected abstract readonly supportedIdentifierTypes: ReadonlySet<string>;

  constructor(
    protected readonly repository: CanonicalStructuredPublicLookupRepository,
  ) {}

  async lookup(
    input: EntityResolutionFallbackLookupInput,
  ): Promise<EntityResolutionFallbackResult> {
    const recognized = input.identifiers.filter((identifier) =>
      this.recognizedIdentifierTypes.has(identifier.type),
    );
    const supported = recognized.filter((identifier) =>
      this.supportedIdentifierTypes.has(identifier.type),
    );

    if (recognized.length === 0) {
      return {
        stage: this.stage,
        sourceStatus: 'complete',
        candidates: [],
      };
    }

    if (supported.length === 0) {
      return {
        stage: this.stage,
        sourceStatus: 'unavailable',
        candidates: [],
        stopReason: 'identifier_source_not_available',
      };
    }

    const records = await this.lookupRecords(supported);
    return {
      stage: this.stage,
      sourceStatus:
        supported.length === recognized.length ? 'complete' : 'partial',
      candidates: records.map(toCandidate),
      conflictingIdentifiers: distinctIdentityCount(records) > 1,
      stopReason:
        supported.length === recognized.length
          ? null
          : 'some_identifier_sources_not_available',
    };
  }

  protected abstract lookupRecords(
    identifiers: readonly StructuredIdentifierLookup[],
  ): Promise<StructuredPublicIdentityRecord[]>;
}

@Injectable()
export class DirectoryGovernmentEntityResolutionProvider extends StructuredPublicFallbackProvider {
  readonly stage = 'directory_government_id' as const;
  protected readonly recognizedIdentifierTypes = new Set([
    'directory_person_id',
    'acquisition_personnel_id',
    'congress_id',
    'bioguide_id',
    'lis_id',
    'committee_id',
    'legiscan_people_id',
    'openstates_person_id',
    'program_element_code',
  ]);
  protected readonly supportedIdentifierTypes = new Set([
    'directory_person_id',
    'acquisition_personnel_id',
    'congress_id',
    'bioguide_id',
    'lis_id',
    'committee_id',
    'program_element_code',
  ]);

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
  protected readonly recognizedIdentifierTypes = new Set([
    'uei',
    'cage',
    'sam_entity_id',
    'federal_contractor_id',
  ]);
  protected readonly supportedIdentifierTypes = new Set([
    'uei',
    'federal_contractor_id',
  ]);

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
  protected readonly recognizedIdentifierTypes = new Set([
    'usaspending_recipient_id',
  ]);
  protected readonly supportedIdentifierTypes = new Set([
    'usaspending_recipient_id',
  ]);

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
  protected readonly recognizedIdentifierTypes = new Set([
    'lda_client_id',
    'lda_registrant_id',
    'lda_lobbyist_id',
  ]);
  protected readonly supportedIdentifierTypes = new Set(['lda_client_id']);

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
  protected readonly recognizedIdentifierTypes = new Set(['cik']);
  protected readonly supportedIdentifierTypes = new Set(['cik']);

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
