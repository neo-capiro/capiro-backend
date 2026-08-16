import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import {
  clampResolutionConfidence,
  normalizeEntityIdentifier,
  normalizeEntityText,
  normalizeEntityType,
  normalizeIdentifierType,
} from './entity-normalization.js';
import {
  decideEntityResolutionStagePolicy,
  ENTITY_RESOLUTION_STAGE_ORDER,
  type EntityResolutionEvidenceKind,
  type EntityResolutionStage,
} from './entity-resolution-stage-policy.js';
import type {
  CanonicalEntityRecord,
  EntityIdentifierInput,
  EntityResolutionCandidate,
  EntityResolutionPreview,
  EntityResolutionProvenance,
  ResolveEntityInput,
} from './entity-resolution.types.js';
import {
  ENTITY_RESOLUTION_FALLBACK_PROVIDERS,
  type EntityResolutionFallbackCandidate,
  type EntityResolutionFallbackProvider,
  type EntityResolutionOrchestrationCandidate,
  type EntityResolutionStageTrace,
  type ResolveEntityAcrossSourcesInput,
  type UniversalEntityResolutionOrchestrationResult,
} from './universal-entity-resolution-orchestrator.types.js';
import { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

const HARD_STOP_METHODS = new Set([
  'conflicting_identifiers',
  'multiple_authoritative_identifiers',
  'cross_scope_conflict',
]);

const PUBLIC_LOOKUP_STAGES = new Set<EntityResolutionStage>([
  'official_website',
  'public_web',
]);

/**
 * Shared ordered identity-resolution path for every Capiro surface.
 *
 * This service owns orchestration and policy only. Source providers return
 * normalized candidates and never write canonical identity directly. Public
 * web and model-assisted candidates always remain review-only.
 */
@Injectable()
export class UniversalEntityResolutionOrchestratorService {
  constructor(
    private readonly resolver: UniversalEntityResolutionService,
    private readonly registration: CanonicalEntityRegistrationService,
    @Optional()
    @Inject(ENTITY_RESOLUTION_FALLBACK_PROVIDERS)
    private readonly providers: readonly EntityResolutionFallbackProvider[] = [],
  ) {}

  async resolveAcrossSources(
    tenantId: string,
    input: ResolveEntityAcrossSourcesInput,
  ): Promise<UniversalEntityResolutionOrchestrationResult> {
    const normalized = normalizeOrchestrationInput(input);
    const providers = providerMap(this.providers);
    const attemptedStages: EntityResolutionStageTrace[] = [];
    const candidates = new Map<string, EntityResolutionOrchestrationCandidate>();
    const provenance: EntityResolutionProvenance[] = [];
    let publicLookupRan = false;

    for (const stage of ENTITY_RESOLUTION_STAGE_ORDER) {
      const deterministicInput = deterministicInputForStage(stage, normalized);
      let stageWasAttempted = false;
      let stageStatus: EntityResolutionStageTrace['status'] = 'unresolved';
      let sourceStatus: EntityResolutionStageTrace['sourceStatus'] = 'complete';
      let resolutionMethod = 'unresolved';
      let stopReason: string | null = null;

      if (deterministicInput) {
        stageWasAttempted = true;
        const preview = await this.resolver.preview(tenantId, deterministicInput);
        addCanonicalCandidates(candidates, stage, preview.candidates);
        provenance.push(...preview.provenance);
        stageStatus = preview.status;
        resolutionMethod = preview.resolutionMethod;

        if (preview.status === 'resolved') {
          const persisted = await this.resolver.resolve(tenantId, deterministicInput);
          attemptedStages.push(
            trace(stage, sourceStatus, 'resolved', preview.candidates.length, resolutionMethod, null),
          );
          return resultFromResolved(
            persisted.resolutionId,
            persisted.entity,
            persisted.confidence,
            persisted.resolutionMethod,
            candidates,
            provenance,
            attemptedStages,
            publicLookupRan,
            'deterministic_match',
          );
        }

        if (
          preview.status === 'ambiguous' &&
          HARD_STOP_METHODS.has(preview.resolutionMethod)
        ) {
          const persisted = await this.resolver.resolve(tenantId, deterministicInput);
          stopReason = 'authoritative_identifier_conflict';
          attemptedStages.push(
            trace(
              stage,
              sourceStatus,
              'ambiguous',
              preview.candidates.length,
              preview.resolutionMethod,
              stopReason,
            ),
          );
          return resultFromOpenCandidates({
            resolutionId: persisted.resolutionId,
            status: 'ambiguous',
            confidence: persisted.confidence,
            resolutionMethod: persisted.resolutionMethod,
            candidates,
            provenance,
            attemptedStages,
            publicLookupRan,
            stopReason,
          });
        }
      }

      const provider = providers.get(stage);
      if (provider) {
        stageWasAttempted = true;
        if (PUBLIC_LOOKUP_STAGES.has(stage)) publicLookupRan = true;

        try {
          const providerResult = await provider.lookup({
            tenantId,
            actorUserId: normalized.actorUserId,
            query: normalized.rawInput,
            normalizedQuery: normalized.normalizedInput,
            entityTypeHint: normalized.entityTypeHint,
            identifiers: normalized.identifiers,
            priorCandidates: [...candidates.values()],
          });
          if (providerResult.stage !== stage) {
            throw new BadRequestException(
              `Entity fallback provider for ${stage} returned ${providerResult.stage}.`,
            );
          }

          sourceStatus = providerResult.sourceStatus;
          stopReason = providerResult.stopReason?.trim() || null;
          const providerCandidates = normalizeProviderCandidates(
            tenantId,
            normalized.entityTypeHint,
            providerResult.candidates,
          );
          addFallbackCandidates(candidates, stage, providerCandidates);
          provenance.push(...(providerResult.provenance ?? []));
          for (const candidate of providerCandidates) {
            provenance.push(...candidateProvenance(candidate));
          }

          const evidenceKinds = uniqueEvidenceKinds(
            providerCandidates.flatMap((candidate) => candidate.evidenceKinds),
          );
          const policy = decideEntityResolutionStagePolicy(stage, {
            candidateCount: providerCandidates.length,
            evidenceKinds,
            conflictingIdentifiers: providerResult.conflictingIdentifiers === true,
            candidateAlreadyCanonical:
              providerCandidates.length === 1 &&
              providerCandidates[0]?.canonicalEntity != null,
          });

          stageStatus = policy.autoResolve
            ? 'resolved'
            : providerCandidates.length > 0
              ? 'ambiguous'
              : 'unresolved';
          resolutionMethod = stage;

          if (policy.reason === 'conflicting_identifiers') {
            stopReason = 'authoritative_identifier_conflict';
            attemptedStages.push(
              trace(
                stage,
                sourceStatus,
                'ambiguous',
                providerCandidates.length,
                resolutionMethod,
                stopReason,
              ),
            );
            return resultFromOpenCandidates({
              resolutionId: null,
              status: 'ambiguous',
              confidence: topConfidence(candidates),
              resolutionMethod,
              candidates,
              provenance,
              attemptedStages,
              publicLookupRan,
              stopReason,
            });
          }

          if (policy.autoResolve && providerCandidates.length === 1) {
            const candidate = providerCandidates[0]!;
            let entity = candidate.canonicalEntity ?? null;

            if (!entity && policy.mayRegisterGlobalPublic) {
              if (input.allowAuthoritativePublicRegistration !== true) {
                stageStatus = 'ambiguous';
                stopReason = 'authoritative_registration_requires_opt_in';
              } else {
                entity = await this.registration.registerGlobalPublicEntity({
                  actorUserId: normalized.actorUserId,
                  entityType: candidate.entityType,
                  canonicalName: candidate.canonicalName,
                  resolutionMethod: candidate.sourceType,
                  resolutionConfidence: candidate.confidence,
                  metadata: {
                    resolutionStage: stage,
                    sourceUrl: candidate.sourceUrl ?? null,
                    observedAt: candidate.observedAt.toISOString(),
                  },
                  aliases: candidate.aliases ?? [],
                  identifiers: candidate.identifiers ?? [],
                });
              }
            }

            if (entity) {
              const persisted = await persistProviderSelection(
                this.resolver,
                tenantId,
                normalized.actorUserId,
                candidate,
              );
              if (persisted.status === 'resolved' && persisted.entity) {
                attemptedStages.push(
                  trace(
                    stage,
                    sourceStatus,
                    'resolved',
                    providerCandidates.length,
                    persisted.resolutionMethod,
                    null,
                  ),
                );
                return resultFromResolved(
                  persisted.resolutionId,
                  persisted.entity,
                  persisted.confidence,
                  persisted.resolutionMethod,
                  candidates,
                  provenance,
                  attemptedStages,
                  publicLookupRan,
                  'authoritative_fallback_match',
                );
              }
              stageStatus = 'ambiguous';
              stopReason = 'registered_identity_did_not_resolve_uniquely';
            }
          }
        } catch (error) {
          sourceStatus = 'error';
          stageStatus = 'unresolved';
          resolutionMethod = 'provider_error';
          stopReason = errorCode(error);
        }
      }

      if (stageWasAttempted) {
        attemptedStages.push(
          trace(
            stage,
            sourceStatus,
            stageStatus,
            countCandidatesForStage(candidates, stage),
            resolutionMethod,
            stopReason,
          ),
        );
      }
    }

    const hasCandidates = candidates.size > 0;
    return resultFromOpenCandidates({
      resolutionId: null,
      status: hasCandidates ? 'ambiguous' : 'unresolved',
      confidence: topConfidence(candidates),
      resolutionMethod: hasCandidates
        ? 'fallback_candidates_require_confirmation'
        : 'unresolved_after_all_available_stages',
      candidates,
      provenance,
      attemptedStages,
      publicLookupRan,
      stopReason: hasCandidates
        ? 'human_confirmation_required'
        : 'no_candidate_found',
    });
  }
}

interface NormalizedOrchestrationInput {
  rawInput: string;
  normalizedInput: string;
  actorUserId: string | null;
  entityTypeHint: string | null;
  identifiers: Array<{ type: string; value: string; normalizedValue: string }>;
  maxCandidates: number | undefined;
}

function normalizeOrchestrationInput(
  input: ResolveEntityAcrossSourcesInput,
): NormalizedOrchestrationInput {
  const identifiers = (input.identifiers ?? []).map((identifier) => {
    const type = normalizeIdentifierType(identifier.type);
    return {
      type,
      value: identifier.value.trim(),
      normalizedValue: normalizeEntityIdentifier(type, identifier.value),
    };
  });
  const rawInput = input.query.trim();
  const normalizedInput = normalizeEntityText(rawInput);
  if (!normalizedInput && identifiers.length === 0) {
    throw new BadRequestException('Entity query or identifier is required.');
  }
  return {
    rawInput,
    normalizedInput,
    actorUserId: input.actorUserId ?? null,
    entityTypeHint: normalizeEntityType(input.entityTypeHint),
    identifiers,
    maxCandidates: input.maxCandidates,
  };
}

function deterministicInputForStage(
  stage: EntityResolutionStage,
  input: NormalizedOrchestrationInput,
): ResolveEntityInput | null {
  if (stage === 'existing_canonical') {
    return input.normalizedInput
      ? {
          query: input.rawInput,
          actorUserId: input.actorUserId,
          entityTypeHint: input.entityTypeHint,
          maxCandidates: input.maxCandidates,
        }
      : null;
  }

  const identifiers = input.identifiers.filter(
    (identifier) => identifierStage(identifier.type) === stage,
  );
  if (identifiers.length === 0) return null;
  return {
    query: '',
    actorUserId: input.actorUserId,
    entityTypeHint: input.entityTypeHint,
    identifiers: identifiers.map(({ type, value }) => ({ type, value })),
    maxCandidates: input.maxCandidates,
  };
}

function identifierStage(type: string): EntityResolutionStage | null {
  switch (normalizeIdentifierType(type)) {
    case 'canonical_entity_id':
      return 'existing_canonical';
    case 'crm_client_id':
    case 'crm_company_id':
      return 'crm_identity';
    case 'crm_contact_id':
    case 'engagement_contact_id':
    case 'provider_contact_id':
    case 'email':
      return 'contact_email';
    case 'domain':
    case 'official_domain':
      return 'email_domain';
    case 'directory_person_id':
    case 'acquisition_personnel_id':
    case 'congress_id':
    case 'bioguide_id':
    case 'lis_id':
    case 'committee_id':
    case 'legiscan_people_id':
    case 'openstates_person_id':
    case 'program_element_code':
      return 'directory_government_id';
    case 'uei':
    case 'cage':
    case 'sam_entity_id':
    case 'federal_contractor_id':
      return 'sam_uei_cage';
    case 'usaspending_recipient_id':
      return 'usaspending';
    case 'lda_client_id':
    case 'lda_registrant_id':
    case 'lda_lobbyist_id':
      return 'lda';
    case 'cik':
      return 'sec_cik';
    default:
      return null;
  }
}

function providerMap(
  providers: readonly EntityResolutionFallbackProvider[],
): Map<EntityResolutionStage, EntityResolutionFallbackProvider> {
  const byStage = new Map<EntityResolutionStage, EntityResolutionFallbackProvider>();
  for (const provider of providers) {
    if (provider.stage === 'existing_canonical') {
      throw new BadRequestException(
        'existing_canonical is owned by UniversalEntityResolutionService.',
      );
    }
    if (byStage.has(provider.stage)) {
      throw new BadRequestException(
        `Multiple entity fallback providers registered for ${provider.stage}.`,
      );
    }
    byStage.set(provider.stage, provider);
  }
  return byStage;
}

function normalizeProviderCandidates(
  tenantId: string,
  entityTypeHint: string | null,
  values: readonly EntityResolutionFallbackCandidate[],
): EntityResolutionFallbackCandidate[] {
  const output: EntityResolutionFallbackCandidate[] = [];
  for (const candidate of values) {
    const canonicalName = candidate.canonicalName.trim();
    const entityType = normalizeEntityType(candidate.entityType);
    if (!candidate.candidateKey.trim() || !canonicalName || !entityType) continue;
    if (entityTypeHint && entityTypeHint !== entityType) continue;
    if (
      candidate.canonicalEntity?.identityScope === 'tenant_private' &&
      candidate.canonicalEntity.tenantId !== tenantId
    ) {
      throw new BadRequestException(
        'Entity fallback provider returned a cross-tenant private candidate.',
      );
    }
    output.push({
      ...candidate,
      candidateKey: candidate.candidateKey.trim(),
      canonicalName,
      entityType,
      confidence: clampResolutionConfidence(candidate.confidence, 0),
      evidenceKinds: uniqueEvidenceKinds(candidate.evidenceKinds),
    });
  }
  return dedupeProviderCandidates(output);
}

function dedupeProviderCandidates(
  values: readonly EntityResolutionFallbackCandidate[],
): EntityResolutionFallbackCandidate[] {
  const byKey = new Map<string, EntityResolutionFallbackCandidate>();
  for (const value of values) {
    const key = value.canonicalEntity?.id
      ? `entity:${value.canonicalEntity.id}`
      : `${value.sourceType}:${value.candidateKey}`;
    const existing = byKey.get(key);
    if (!existing || value.confidence > existing.confidence) byKey.set(key, value);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.canonicalName.localeCompare(right.canonicalName),
  );
}

function addCanonicalCandidates(
  target: Map<string, EntityResolutionOrchestrationCandidate>,
  stage: EntityResolutionStage,
  values: readonly EntityResolutionCandidate[],
): void {
  for (const candidate of values) {
    const key = `entity:${candidate.entity.id}`;
    const value: EntityResolutionOrchestrationCandidate = {
      candidateKey: key,
      entityId: candidate.entity.id,
      canonicalName: candidate.entity.canonicalName,
      entityType: candidate.entity.entityType,
      confidence: candidate.confidence,
      stage,
      sourceType: candidate.provenance[0]?.sourceType ?? 'canonical_entity',
      sourceId: candidate.provenance[0]?.sourceId ?? null,
      sourceUrl: null,
      evidenceKinds: [evidenceKindForCandidate(candidate)],
      provenance: candidate.provenance,
    };
    const existing = target.get(key);
    if (!existing || value.confidence > existing.confidence) target.set(key, value);
  }
}

function addFallbackCandidates(
  target: Map<string, EntityResolutionOrchestrationCandidate>,
  stage: EntityResolutionStage,
  values: readonly EntityResolutionFallbackCandidate[],
): void {
  for (const candidate of values) {
    const key = candidate.canonicalEntity?.id
      ? `entity:${candidate.canonicalEntity.id}`
      : `${candidate.sourceType}:${candidate.candidateKey}`;
    const value: EntityResolutionOrchestrationCandidate = {
      candidateKey: candidate.candidateKey,
      entityId: candidate.canonicalEntity?.id ?? null,
      canonicalName: candidate.canonicalName,
      entityType: candidate.entityType,
      confidence: candidate.confidence,
      stage,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId ?? null,
      sourceUrl: candidate.sourceUrl ?? null,
      evidenceKinds: candidate.evidenceKinds,
      provenance: candidateProvenance(candidate),
    };
    const existing = target.get(key);
    if (!existing || value.confidence > existing.confidence) target.set(key, value);
  }
}

function evidenceKindForCandidate(
  candidate: EntityResolutionCandidate,
): EntityResolutionEvidenceKind {
  switch (candidate.resolutionMethod) {
    case 'identifier_exact':
      return 'exact_authoritative_identifier';
    case 'alias_exact':
      return 'exact_verified_alias';
    case 'canonical_name_exact':
      return 'name_only';
  }
}

function candidateProvenance(
  candidate: EntityResolutionFallbackCandidate,
): EntityResolutionProvenance[] {
  const identifiers = candidate.identifiers ?? [];
  if (identifiers.length > 0) {
    return identifiers.map((identifier) => ({
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId ?? null,
      identifierType: identifier.type,
      matchValue: identifier.value,
    }));
  }
  return [
    {
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId ?? candidate.sourceUrl ?? null,
      matchValue: candidate.canonicalName,
    },
  ];
}

async function persistProviderSelection(
  resolver: UniversalEntityResolutionService,
  tenantId: string,
  actorUserId: string | null,
  candidate: EntityResolutionFallbackCandidate,
) {
  const identifiers: EntityIdentifierInput[] = (candidate.identifiers ?? []).map(
    ({ type, value }) => ({ type, value }),
  );
  return resolver.resolve(tenantId, {
    query: candidate.canonicalName,
    actorUserId,
    entityTypeHint: candidate.entityType,
    identifiers,
  });
}

function resultFromResolved(
  resolutionId: string,
  entity: CanonicalEntityRecord | null,
  confidence: number,
  resolutionMethod: string,
  candidates: Map<string, EntityResolutionOrchestrationCandidate>,
  provenance: EntityResolutionProvenance[],
  attemptedStages: EntityResolutionStageTrace[],
  publicLookupRan: boolean,
  stopReason: string,
): UniversalEntityResolutionOrchestrationResult {
  return {
    resolutionId,
    status: 'resolved',
    entity,
    confidence,
    resolutionMethod,
    candidates: [...candidates.values()],
    provenance: dedupeProvenance(provenance),
    requiresUserConfirmation: false,
    attemptedStages,
    publicLookupRan,
    stopReason,
  };
}

function resultFromOpenCandidates(input: {
  resolutionId: string | null;
  status: 'ambiguous' | 'unresolved';
  confidence: number;
  resolutionMethod: string;
  candidates: Map<string, EntityResolutionOrchestrationCandidate>;
  provenance: EntityResolutionProvenance[];
  attemptedStages: EntityResolutionStageTrace[];
  publicLookupRan: boolean;
  stopReason: string;
}): UniversalEntityResolutionOrchestrationResult {
  return {
    resolutionId: input.resolutionId,
    status: input.status,
    entity: null,
    confidence: input.confidence,
    resolutionMethod: input.resolutionMethod,
    candidates: [...input.candidates.values()],
    provenance: dedupeProvenance(input.provenance),
    requiresUserConfirmation: input.status === 'ambiguous',
    attemptedStages: input.attemptedStages,
    publicLookupRan: input.publicLookupRan,
    stopReason: input.stopReason,
  };
}

function trace(
  stage: EntityResolutionStage,
  sourceStatus: EntityResolutionStageTrace['sourceStatus'],
  status: EntityResolutionStageTrace['status'],
  candidateCount: number,
  resolutionMethod: string,
  stopReason: string | null,
): EntityResolutionStageTrace {
  return {
    stage,
    sourceStatus,
    status,
    candidateCount,
    resolutionMethod,
    stopReason,
  };
}

function countCandidatesForStage(
  candidates: Map<string, EntityResolutionOrchestrationCandidate>,
  stage: EntityResolutionStage,
): number {
  return [...candidates.values()].filter((candidate) => candidate.stage === stage).length;
}

function topConfidence(
  candidates: Map<string, EntityResolutionOrchestrationCandidate>,
): number {
  return Math.max(0, ...[...candidates.values()].map((candidate) => candidate.confidence));
}

function uniqueEvidenceKinds(
  values: readonly EntityResolutionEvidenceKind[],
): EntityResolutionEvidenceKind[] {
  return [...new Set(values)];
}

function dedupeProvenance(
  values: readonly EntityResolutionProvenance[],
): EntityResolutionProvenance[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return 'EntityFallbackProviderError';
}
