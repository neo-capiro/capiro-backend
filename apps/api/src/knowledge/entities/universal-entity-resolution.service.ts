import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CanonicalEntityRepository } from './canonical-entity.repository.js';
import {
  clampResolutionConfidence,
  normalizeEntityIdentifier,
  normalizeEntityText,
  normalizeEntityType,
  normalizeIdentifierType,
} from './entity-normalization.js';
import type {
  AppendResolutionInput,
  CanonicalEntityRecord,
  CorrectEntityResolutionInput,
  EntityResolutionCandidate,
  EntityResolutionProvenance,
  EntityResolutionResult,
  NormalizedResolveEntityInput,
  RegisterTenantPrivateEntityInput,
  ResolveEntityInput,
} from './entity-resolution.types.js';

const DEFAULT_MAX_CANDIDATES = 10;
const MAX_CANDIDATES = 25;
const UNIQUE_EXACT_MATCH_THRESHOLD = 0.9;

/**
 * Shared deterministic resolver for every Capiro surface.
 *
 * Phase 5 begins precision-first: exact names, aliases, and namespaced
 * identifiers. Fuzzy/model/public-registry fallbacks plug in after this
 * boundary, but they may never silently override deterministic ambiguity.
 */
@Injectable()
export class UniversalEntityResolutionService {
  constructor(private readonly repository: CanonicalEntityRepository) {}

  async resolve(tenantId: string, input: ResolveEntityInput): Promise<EntityResolutionResult> {
    const normalized = normalizeResolveInput(input);
    const candidates = await this.repository.findExactCandidates(tenantId, normalized);
    const decision = decideResolution(candidates);

    const provenance = dedupeProvenance(
      candidates.flatMap((candidate) => candidate.provenance),
    );
    const resolution = await this.repository.appendResolution(
      tenantId,
      buildAppendInput(normalized, candidates, decision, provenance),
    );

    return {
      resolutionId: resolution.id,
      status: decision.status,
      entity: decision.entity,
      confidence: decision.confidence,
      resolutionMethod: decision.resolutionMethod,
      candidates,
      provenance,
      requiresUserConfirmation: decision.status === 'ambiguous',
    };
  }

  async registerTenantPrivateEntity(
    tenantId: string,
    input: RegisterTenantPrivateEntityInput,
  ): Promise<CanonicalEntityRecord> {
    const identifiers = (input.identifiers ?? []).map((identifier) => ({
      type: identifier.type,
      value: identifier.value,
    }));

    const existing = await this.resolve(tenantId, {
      query: input.canonicalName,
      actorUserId: input.actorUserId ?? null,
      entityTypeHint: input.entityType,
      identifiers,
      maxCandidates: 10,
    });

    if (existing.status === 'resolved' && existing.entity) {
      return existing.entity;
    }
    if (existing.status === 'ambiguous') {
      throw new ConflictException(
        'Canonical entity registration is ambiguous; confirm the intended entity instead of creating a duplicate.',
      );
    }

    const entity = await this.repository.createTenantPrivateEntity(tenantId, input);
    const provenance: EntityResolutionProvenance[] = [
      {
        sourceType: normalizeIdentifierType(input.resolutionMethod),
        sourceId: entity.id,
        matchValue: entity.canonicalName,
      },
    ];
    await this.repository.appendResolution(tenantId, {
      idempotencyKey: resolutionIdempotencyKey({
        kind: 'registration',
        tenantId,
        entityId: entity.id,
        actorUserId: input.actorUserId ?? null,
      }),
      actorUserId: input.actorUserId ?? null,
      rawInput: input.canonicalName.trim(),
      normalizedInput: entity.normalizedName,
      entityTypeHint: entity.entityType,
      candidateEntityIds: [entity.id],
      selectedEntityId: entity.id,
      status: 'resolved',
      confidence: entity.resolutionConfidence,
      resolutionMethod: 'source_registration',
      provenance,
      correctionOfResolutionId: null,
    });
    return entity;
  }

  async correctResolution(
    tenantId: string,
    input: CorrectEntityResolutionInput,
  ): Promise<EntityResolutionResult> {
    const previous = await this.repository.findResolutionById(tenantId, input.resolutionId);
    if (!previous) throw new NotFoundException('Entity resolution not found.');

    const entity = await this.repository.findVisibleById(tenantId, input.selectedEntityId);
    if (!entity) {
      throw new NotFoundException('Selected canonical entity is not visible to this tenant.');
    }

    const provenance: EntityResolutionProvenance[] = [
      {
        sourceType: 'user_correction',
        sourceId: input.actorUserId,
        matchValue: input.reason?.trim() || null,
      },
    ];
    const candidateEntityIds = uniqueStrings([
      ...previous.candidateEntityIds,
      entity.id,
    ]);
    const corrected = await this.repository.appendResolution(tenantId, {
      idempotencyKey: resolutionIdempotencyKey({
        kind: 'correction',
        tenantId,
        previousResolutionId: previous.id,
        selectedEntityId: entity.id,
        actorUserId: input.actorUserId,
        reason: input.reason?.trim() || null,
      }),
      actorUserId: input.actorUserId,
      rawInput: previous.rawInput,
      normalizedInput: previous.normalizedInput,
      entityTypeHint: previous.entityTypeHint,
      candidateEntityIds,
      selectedEntityId: entity.id,
      status: 'corrected',
      confidence: 1,
      resolutionMethod: 'user_corrected',
      provenance,
      correctionOfResolutionId: previous.id,
    });

    return {
      resolutionId: corrected.id,
      status: 'resolved',
      entity,
      confidence: 1,
      resolutionMethod: 'user_corrected',
      candidates: [],
      provenance,
      requiresUserConfirmation: false,
    };
  }
}

interface ResolutionDecision {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  entity: CanonicalEntityRecord | null;
  confidence: number;
  resolutionMethod: string;
}

function normalizeResolveInput(input: ResolveEntityInput): NormalizedResolveEntityInput {
  const identifiers = (input.identifiers ?? []).map((identifier) => {
    const type = normalizeIdentifierType(identifier.type);
    return {
      type,
      value: identifier.value.trim(),
      normalizedValue: normalizeEntityIdentifier(type, identifier.value),
    };
  });

  const rawInput =
    input.query.trim() ||
    identifiers.map((identifier) => `${identifier.type}:${identifier.value}`).join(', ');
  const normalizedInput = normalizeEntityText(rawInput);
  if (!rawInput || (!normalizedInput && identifiers.length === 0)) {
    throw new BadRequestException('Entity query or identifier is required.');
  }

  const requestedLimit = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new BadRequestException('maxCandidates must be a positive integer.');
  }

  return {
    rawInput,
    normalizedInput,
    actorUserId: input.actorUserId ?? null,
    entityTypeHint: normalizeEntityType(input.entityTypeHint),
    identifiers,
    maxCandidates: Math.min(requestedLimit, MAX_CANDIDATES),
  };
}

function decideResolution(candidates: EntityResolutionCandidate[]): ResolutionDecision {
  if (candidates.length === 0) {
    return {
      status: 'unresolved',
      entity: null,
      confidence: 0,
      resolutionMethod: 'unresolved',
    };
  }

  const identifierMatches = candidates.filter(
    (candidate) => candidate.resolutionMethod === 'identifier_exact',
  );
  if (identifierMatches.length === 1) {
    const match = identifierMatches[0]!;
    return {
      status: 'resolved',
      entity: match.entity,
      confidence: clampResolutionConfidence(match.confidence),
      resolutionMethod: 'identifier_exact',
    };
  }
  if (identifierMatches.length > 1) {
    return {
      status: 'ambiguous',
      entity: null,
      confidence: clampResolutionConfidence(identifierMatches[0]?.confidence, 0),
      resolutionMethod: 'conflicting_identifiers',
    };
  }

  if (candidates.length === 1 && candidates[0]!.confidence >= UNIQUE_EXACT_MATCH_THRESHOLD) {
    const match = candidates[0]!;
    return {
      status: 'resolved',
      entity: match.entity,
      confidence: clampResolutionConfidence(match.confidence),
      resolutionMethod: match.resolutionMethod,
    };
  }

  return {
    status: 'ambiguous',
    entity: null,
    confidence: clampResolutionConfidence(candidates[0]?.confidence, 0),
    resolutionMethod: 'multiple_exact_candidates',
  };
}

function buildAppendInput(
  normalized: NormalizedResolveEntityInput,
  candidates: EntityResolutionCandidate[],
  decision: ResolutionDecision,
  provenance: EntityResolutionProvenance[],
): AppendResolutionInput {
  const candidateEntityIds = uniqueStrings(candidates.map((candidate) => candidate.entity.id));
  const selectedEntityId = decision.entity?.id ?? null;
  return {
    idempotencyKey: resolutionIdempotencyKey({
      kind: 'resolve',
      rawInput: normalized.rawInput,
      normalizedInput: normalized.normalizedInput,
      actorUserId: normalized.actorUserId,
      entityTypeHint: normalized.entityTypeHint,
      identifiers: normalized.identifiers,
      candidateEntityIds,
      selectedEntityId,
      status: decision.status,
      resolutionMethod: decision.resolutionMethod,
    }),
    actorUserId: normalized.actorUserId,
    rawInput: normalized.rawInput,
    normalizedInput: normalized.normalizedInput,
    entityTypeHint: normalized.entityTypeHint,
    candidateEntityIds,
    selectedEntityId,
    status: decision.status,
    confidence: decision.confidence,
    resolutionMethod: decision.resolutionMethod,
    provenance,
    correctionOfResolutionId: null,
  };
}

function resolutionIdempotencyKey(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function dedupeProvenance(
  values: EntityResolutionProvenance[],
): EntityResolutionProvenance[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = stableStringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
