import { Inject, Injectable, Optional } from '@nestjs/common';
import { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import type { EntityResolutionProvenance } from './entity-resolution.types.js';
import {
  ENTITY_RESOLUTION_FALLBACK_PROVIDERS,
  type EntityResolutionFallbackProvider,
  type EntityResolutionOrchestrationCandidate,
  type EntityResolutionStageTrace,
  type ResolveEntityAcrossSourcesInput,
  type UniversalEntityResolutionOrchestrationResult,
} from './universal-entity-resolution-orchestrator.types.js';
import { UniversalEntityResolutionOrchestratorService } from './universal-entity-resolution-orchestrator.service.js';
import { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

/**
 * Keeps supplied identifiers authoritative over an exact name/alias hit without
 * introducing a second resolver. The same ordered orchestrator is run first on
 * identifiers only; name fallback occurs only when identifier lookup produced
 * no candidate and no hard-stop condition.
 */
@Injectable()
export class AuthoritativeFirstUniversalEntityResolutionOrchestratorService extends UniversalEntityResolutionOrchestratorService {
  constructor(
    resolver: UniversalEntityResolutionService,
    registration: CanonicalEntityRegistrationService,
    @Optional()
    @Inject(ENTITY_RESOLUTION_FALLBACK_PROVIDERS)
    providers: readonly EntityResolutionFallbackProvider[] = [],
  ) {
    super(resolver, registration, providers);
  }

  override async resolveAcrossSources(
    tenantId: string,
    input: ResolveEntityAcrossSourcesInput,
  ): Promise<UniversalEntityResolutionOrchestrationResult> {
    const hasQuery = input.query.trim().length > 0;
    const hasIdentifiers = (input.identifiers?.length ?? 0) > 0;
    if (!hasQuery || !hasIdentifiers) {
      return super.resolveAcrossSources(tenantId, input);
    }

    const identifierResult = await super.resolveAcrossSources(tenantId, {
      ...input,
      query: '',
    });

    if (
      identifierResult.status !== 'unresolved' ||
      identifierResult.candidates.length > 0
    ) {
      return identifierResult;
    }

    const nameResult = await super.resolveAcrossSources(tenantId, {
      ...input,
      identifiers: [],
    });

    return {
      ...nameResult,
      candidates: mergeCandidates(
        identifierResult.candidates,
        nameResult.candidates,
      ),
      provenance: mergeProvenance(
        identifierResult.provenance,
        nameResult.provenance,
      ),
      attemptedStages: mergeStageTraces(
        identifierResult.attemptedStages,
        nameResult.attemptedStages,
      ),
      publicLookupRan:
        identifierResult.publicLookupRan || nameResult.publicLookupRan,
    };
  }
}

function mergeCandidates(
  first: readonly EntityResolutionOrchestrationCandidate[],
  second: readonly EntityResolutionOrchestrationCandidate[],
): EntityResolutionOrchestrationCandidate[] {
  const values = new Map<string, EntityResolutionOrchestrationCandidate>();
  for (const candidate of [...first, ...second]) {
    const key = candidate.entityId
      ? `entity:${candidate.entityId}`
      : `${candidate.sourceType}:${candidate.candidateKey}`;
    const existing = values.get(key);
    if (!existing || candidate.confidence > existing.confidence) {
      values.set(key, candidate);
    }
  }
  return [...values.values()];
}

function mergeProvenance(
  first: readonly EntityResolutionProvenance[],
  second: readonly EntityResolutionProvenance[],
): EntityResolutionProvenance[] {
  const seen = new Set<string>();
  const output: EntityResolutionProvenance[] = [];
  for (const value of [...first, ...second]) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function mergeStageTraces(
  first: readonly EntityResolutionStageTrace[],
  second: readonly EntityResolutionStageTrace[],
): EntityResolutionStageTrace[] {
  return [...first, ...second];
}
