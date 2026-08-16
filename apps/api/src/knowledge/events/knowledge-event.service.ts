import { BadRequestException, Injectable } from '@nestjs/common';
import { KnowledgeEventRepository } from './knowledge-event.repository.js';
import {
  DISALLOWED_KNOWLEDGE_FACTUAL_SOURCE_TYPES,
  KNOWLEDGE_EVENT_STATUSES,
  type AppendKnowledgeEventInput,
  type KnowledgeEventRecord,
  type KnowledgeJsonObject,
  type NormalizedKnowledgeEventInput,
} from '../knowledge.types.js';
import {
  normalizeJsonObject,
  normalizeRefs,
  optionalText,
  requireDate,
  requireNonEmptyJsonObject,
  requireSha256,
  requireText,
  requireToken,
  requireUuid,
  sha256Identity,
} from '../knowledge.helpers.js';

/** Append-only service for source observations that feed the Knowledge Plane. */
@Injectable()
export class KnowledgeEventService {
  constructor(private readonly events: KnowledgeEventRepository) {}

  async append(tenantId: string, input: AppendKnowledgeEventInput): Promise<KnowledgeEventRecord> {
    const normalizedTenantId = requireUuid(tenantId, 'tenantId');
    const normalized = normalizeKnowledgeEvent(normalizedTenantId, input);
    return this.events.append(normalizedTenantId, normalized);
  }

  async findById(tenantId: string, eventId: string): Promise<KnowledgeEventRecord | null> {
    return this.events.findById(
      requireUuid(tenantId, 'tenantId'),
      requireUuid(eventId, 'eventId'),
    );
  }
}

export function isDisallowedKnowledgeFactualSourceType(sourceType: string): boolean {
  return DISALLOWED_KNOWLEDGE_FACTUAL_SOURCE_TYPES.some(
    (candidate) => candidate === sourceType,
  );
}

export function normalizeKnowledgeEvent(
  tenantId: string,
  input: AppendKnowledgeEventInput,
  observedNow: Date = new Date(),
): NormalizedKnowledgeEventInput {
  const sourceType = requireToken(input.sourceType, 'sourceType');
  if (isDisallowedKnowledgeFactualSourceType(sourceType)) {
    throw new BadRequestException(
      'AI-generated answers cannot be persisted as factual KnowledgeEvent evidence.',
    );
  }

  const sourceId = requireText(input.sourceId, 'sourceId', 512);
  const sourceVersion = optionalText(input.sourceVersion, 'sourceVersion', 160);
  const sourceContentHash = requireSha256(input.sourceContentHash, 'sourceContentHash');
  const eventType = requireToken(input.eventType, 'eventType');
  const occurredAt = requireDate(input.occurredAt, 'occurredAt');
  const observedAt = requireDate(input.observedAt ?? observedNow, 'observedAt');
  if (observedAt.getTime() < occurredAt.getTime()) {
    throw new BadRequestException('observedAt cannot be before occurredAt.');
  }

  const actorRefs = normalizeRefs(input.actorRefs, 'actorRefs');
  const entityRefs = normalizeRefs(input.entityRefs, 'entityRefs');
  const clientRefs = normalizeRefs(input.clientRefs, 'clientRefs');
  const sensitivity = requireToken(input.sensitivity ?? 'normal', 'sensitivity');
  const accessScope = normalizeJsonObject(input.accessScope, 'accessScope', { kind: 'tenant' });
  const evidenceLocator = requireNonEmptyJsonObject(input.evidenceLocator, 'evidenceLocator');
  const metadata = normalizeJsonObject(input.metadata, 'metadata', {});
  const originTraceId = optionalText(input.originTraceId, 'originTraceId', 160);
  const status = input.status ?? 'active';
  if (!KNOWLEDGE_EVENT_STATUSES.some((candidate) => candidate === status)) {
    throw new BadRequestException('status is not a supported KnowledgeEvent status.');
  }

  const idempotencyKey = buildKnowledgeEventIdempotencyKey({
    tenantId,
    sourceType,
    sourceId,
    sourceVersion,
    sourceContentHash,
    eventType,
  });

  return {
    idempotencyKey,
    sourceType,
    sourceId,
    sourceVersion,
    sourceContentHash,
    eventType,
    occurredAt,
    observedAt,
    actorRefs,
    entityRefs,
    clientRefs,
    sensitivity,
    accessScope,
    evidenceLocator,
    metadata,
    originTraceId,
    status,
  };
}

export function buildKnowledgeEventIdempotencyKey(identity: {
  tenantId: string;
  sourceType: string;
  sourceId: string;
  sourceVersion: string | null;
  sourceContentHash: string;
  eventType: string;
}): string {
  return sha256Identity(identity as unknown as KnowledgeJsonObject);
}
