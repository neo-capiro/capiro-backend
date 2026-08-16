import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { KnowledgeEvidenceValidatorService } from '../evidence/knowledge-evidence-validator.service.js';
import { KnowledgeEventService } from '../events/knowledge-event.service.js';
import {
  KNOWLEDGE_ASSERTION_CLASSES,
  KNOWLEDGE_ASSERTION_STATUSES,
  KNOWLEDGE_AUTHORITIES,
  KNOWLEDGE_CONFLICT_STATUSES,
  type AppendKnowledgeAssertionInput,
  type KnowledgeAssertionRecord,
  type KnowledgeEventRecord,
  type KnowledgeJsonObject,
  type KnowledgeJsonValue,
  type NormalizedKnowledgeAssertionInput,
  type NormalizedKnowledgeEvidenceInput,
} from '../knowledge.types.js';
import {
  assertJsonValue,
  cloneJson,
  jsonEquals,
  normalizeJsonObject,
  optionalText,
  requireDate,
  requireText,
  requireToken,
  requireUuid,
  sha256Identity,
} from '../knowledge.helpers.js';
import { KnowledgeAssertionRepository } from './knowledge-assertion.repository.js';

/**
 * Creates immutable atomic interpretations and their exact source proof.
 * No assertion can commit without at least one validated KnowledgeEvidence row.
 */
@Injectable()
export class KnowledgeAssertionService {
  constructor(
    private readonly assertions: KnowledgeAssertionRepository,
    private readonly events: KnowledgeEventService,
    private readonly evidenceValidator: KnowledgeEvidenceValidatorService,
  ) {}

  async append(
    tenantId: string,
    input: AppendKnowledgeAssertionInput,
  ): Promise<KnowledgeAssertionRecord> {
    const normalizedTenantId = requireUuid(tenantId, 'tenantId');
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
      throw new BadRequestException('A durable KnowledgeAssertion requires evidence.');
    }

    const originEventId = requireUuid(input.originEventId, 'originEventId');
    const originEvent = await this.events.findById(normalizedTenantId, originEventId);
    if (!originEvent) throw new NotFoundException('Origin KnowledgeEvent not found.');
    if (originEvent.status !== 'active') {
      throw new BadRequestException('Assertions require an active origin KnowledgeEvent.');
    }

    const normalized = await this.normalizeAssertion(normalizedTenantId, originEvent, {
      ...input,
      originEventId,
    });
    const normalizedEvidence = await this.normalizeEvidence(
      normalizedTenantId,
      originEvent,
      normalized,
      input,
    );

    return this.assertions.appendWithEvidence(
      normalizedTenantId,
      normalized,
      normalizedEvidence,
    );
  }

  async findById(
    tenantId: string,
    assertionId: string,
  ): Promise<KnowledgeAssertionRecord | null> {
    return this.assertions.findById(
      requireUuid(tenantId, 'tenantId'),
      requireUuid(assertionId, 'assertionId'),
    );
  }

  private async normalizeEvidence(
    tenantId: string,
    originEvent: KnowledgeEventRecord,
    assertion: NormalizedKnowledgeAssertionInput,
    input: AppendKnowledgeAssertionInput,
  ): Promise<NormalizedKnowledgeEvidenceInput[]> {
    const eventCache = new Map<string, KnowledgeEventRecord>([[originEvent.id, originEvent]]);
    const uniqueEvidence = new Map<string, NormalizedKnowledgeEvidenceInput>();
    let originEventSupported = false;

    for (const [index, evidenceInput] of input.evidence.entries()) {
      const eventId = requireUuid(evidenceInput.eventId, `evidence[${index}].eventId`);
      let event = eventCache.get(eventId);
      if (!event) {
        const loaded = await this.events.findById(tenantId, eventId);
        if (!loaded) {
          throw new NotFoundException(`KnowledgeEvidence[${index}] event not found.`);
        }
        event = loaded;
        eventCache.set(eventId, event);
      }

      if (
        event.sensitivity !== assertion.sensitivity ||
        !jsonEquals(event.accessScope, assertion.accessScope)
      ) {
        throw new BadRequestException(
          'All evidence must share the assertion sensitivity and access scope.',
        );
      }

      const normalized = this.evidenceValidator.normalize(
        tenantId,
        event,
        { ...evidenceInput, eventId },
        index,
      );
      if (eventId === originEvent.id) originEventSupported = true;

      const identity = [
        normalized.eventId,
        normalized.contentHash,
        normalized.startOffset,
        normalized.endOffset,
      ].join(':');
      uniqueEvidence.set(identity, normalized);
    }

    if (!originEventSupported) {
      throw new BadRequestException(
        'At least one evidence excerpt must come from the origin KnowledgeEvent.',
      );
    }
    return [...uniqueEvidence.values()];
  }

  private async normalizeAssertion(
    tenantId: string,
    event: KnowledgeEventRecord,
    input: AppendKnowledgeAssertionInput,
  ): Promise<NormalizedKnowledgeAssertionInput> {
    const subjectType = requireToken(input.subjectType, 'subjectType');
    const subjectId = requireText(input.subjectId, 'subjectId', 512);
    const predicate = requireToken(input.predicate, 'predicate');
    const objectType = requireToken(input.objectType, 'objectType');
    const objectId = optionalText(input.objectId, 'objectId', 512);

    let objectValue: KnowledgeJsonValue | null = null;
    if (input.objectValue !== undefined) {
      assertJsonValue(input.objectValue, 'objectValue');
      objectValue = cloneJson(input.objectValue);
    }
    if (objectId === null && objectValue === null) {
      throw new BadRequestException('An assertion requires objectId or objectValue.');
    }

    const assertionClass = input.assertionClass;
    if (!KNOWLEDGE_ASSERTION_CLASSES.some((candidate) => candidate === assertionClass)) {
      throw new BadRequestException('assertionClass is not supported.');
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new BadRequestException('confidence must be between 0 and 1.');
    }
    const authority = input.authority;
    if (!KNOWLEDGE_AUTHORITIES.some((candidate) => candidate === authority)) {
      throw new BadRequestException('authority is not supported.');
    }

    const observedAt = requireDate(input.observedAt ?? event.observedAt, 'observedAt');
    if (observedAt.getTime() < event.occurredAt.getTime()) {
      throw new BadRequestException('observedAt cannot be before the origin KnowledgeEvent occurred.');
    }
    const validFrom = requireDate(input.validFrom ?? observedAt, 'validFrom');
    const validUntil = input.validUntil == null ? null : requireDate(input.validUntil, 'validUntil');
    if (validUntil && validUntil.getTime() <= validFrom.getTime()) {
      throw new BadRequestException('validUntil must be after validFrom.');
    }

    const status = input.status ?? 'active';
    if (!KNOWLEDGE_ASSERTION_STATUSES.some((candidate) => candidate === status)) {
      throw new BadRequestException('status is not supported.');
    }
    const conflictStatus = input.conflictStatus ?? 'none';
    if (!KNOWLEDGE_CONFLICT_STATUSES.some((candidate) => candidate === conflictStatus)) {
      throw new BadRequestException('conflictStatus is not supported.');
    }
    const conflictGroupId = input.conflictGroupId
      ? requireUuid(input.conflictGroupId, 'conflictGroupId')
      : null;
    if (conflictStatus === 'none' && conflictGroupId) {
      throw new BadRequestException('conflictGroupId requires a non-none conflictStatus.');
    }
    if (conflictStatus !== 'none' && !conflictGroupId) {
      throw new BadRequestException('A non-none conflictStatus requires conflictGroupId.');
    }

    const supersedesAssertionId = input.supersedesAssertionId
      ? requireUuid(input.supersedesAssertionId, 'supersedesAssertionId')
      : null;
    const contradictsAssertionId = input.contradictsAssertionId
      ? requireUuid(input.contradictsAssertionId, 'contradictsAssertionId')
      : null;
    if (contradictsAssertionId && conflictStatus === 'none') {
      throw new BadRequestException('A contradiction requires a conflict status.');
    }
    await this.requireLinkedAssertion(tenantId, supersedesAssertionId, 'Superseded');
    await this.requireLinkedAssertion(tenantId, contradictsAssertionId, 'Contradicted');

    const requestedSensitivity = input.sensitivity
      ? requireToken(input.sensitivity, 'sensitivity')
      : event.sensitivity;
    if (requestedSensitivity !== event.sensitivity) {
      throw new BadRequestException(
        'Assertion sensitivity must inherit from its origin KnowledgeEvent.',
      );
    }
    const requestedScope = input.accessScope
      ? normalizeJsonObject(input.accessScope, 'accessScope', event.accessScope)
      : event.accessScope;
    if (!jsonEquals(requestedScope, event.accessScope)) {
      throw new BadRequestException(
        'Assertion accessScope must inherit from its origin KnowledgeEvent.',
      );
    }
    const createdBy = input.createdBy ? requireUuid(input.createdBy, 'createdBy') : null;

    const identity: KnowledgeJsonObject = {
      tenantId,
      originEventId: input.originEventId,
      subjectType,
      subjectId,
      predicate,
      objectType,
      objectId,
      objectValue,
      assertionClass,
      observedAt: observedAt.toISOString(),
      validFrom: validFrom.toISOString(),
      validUntil: validUntil?.toISOString() ?? null,
      status,
      conflictStatus,
      conflictGroupId,
      supersedesAssertionId,
      contradictsAssertionId,
    };

    return {
      idempotencyKey: sha256Identity(identity),
      originEventId: input.originEventId,
      subjectType,
      subjectId,
      predicate,
      objectType,
      objectId,
      objectValue,
      assertionClass,
      confidence: input.confidence,
      authority,
      observedAt,
      validFrom,
      validUntil,
      status,
      conflictStatus,
      conflictGroupId,
      supersedesAssertionId,
      contradictsAssertionId,
      sensitivity: event.sensitivity,
      accessScope: event.accessScope,
      createdBy,
    };
  }

  private async requireLinkedAssertion(
    tenantId: string,
    assertionId: string | null,
    label: string,
  ): Promise<void> {
    if (!assertionId) return;
    if (!(await this.assertions.findById(tenantId, assertionId))) {
      throw new NotFoundException(`${label} KnowledgeAssertion not found.`);
    }
  }
}
