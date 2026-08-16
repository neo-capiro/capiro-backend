import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { KnowledgeAssertionService } from '../assertions/knowledge-assertion.service.js';
import type { UniversalEntityResolutionOrchestrationResult } from '../entities/universal-entity-resolution-orchestrator.types.js';
import { UniversalEntityResolutionOrchestratorService } from '../entities/universal-entity-resolution-orchestrator.service.js';
import { KnowledgeEventService } from '../events/knowledge-event.service.js';
import { jsonEquals } from '../knowledge.helpers.js';
import type { KnowledgeEventRecord, KnowledgeJsonObject } from '../knowledge.types.js';
import { hasAuthoritativeProviderBody } from './mailbox-knowledge.consumer.js';
import { MailboxKnowledgeFlagsService } from './mailbox-knowledge-flags.service.js';
import { MailboxKnowledgeRepository } from './mailbox-knowledge.repository.js';
import type { MailboxMessageRecord, NormalizedMailboxMessage } from './mailbox-knowledge.types.js';
import { MailboxNormalizerService } from './mailbox-normalizer.service.js';
import { MailboxKnowledgeExtractionRepository } from './mailbox-knowledge-extraction.repository.js';
import {
  MailboxKnowledgeExtractorService,
  parseMailboxExtractionModelResult,
} from './mailbox-knowledge-extractor.service.js';
import type {
  MailboxClaimPrimitive,
  MailboxClaimResolutionManifest,
  MailboxExtractedClaimCandidate,
  MailboxExtractionIdentityHint,
  MailboxExtractionModelResult,
  MailboxKnowledgeExtractionDrainResult,
  MailboxKnowledgeExtractionJobRecord,
} from './mailbox-knowledge-extraction.types.js';

const LINKED_CLIENT_RESOLUTION_KEY = 'linked_client';
const SENDER_RESOLUTION_PREFIX = 'sender:';
const EXTRACTION_CHECKPOINT = 'mailbox_extraction_candidates_v1';

interface PreResolvedEnvelopeIdentities {
  hints: MailboxExtractionIdentityHint[];
  resolutions: Map<string, UniversalEntityResolutionOrchestrationResult>;
}

/**
 * Phase 6 post-event worker. It can never make the model an identity authority:
 * known envelope subjects are resolved before extraction, extracted subject/
 * object mentions are resolved during claim processing, and only the single
 * Phase 5 orchestrator may bind a durable assertion to a canonical UUID.
 */
@Injectable()
export class MailboxKnowledgeExtractionConsumer {
  private readonly logger = new Logger(MailboxKnowledgeExtractionConsumer.name);
  private readonly workerId = `${process.env.HOSTNAME ?? 'local'}:${process.pid}:${randomUUID()}`;
  private draining = false;

  constructor(
    private readonly flags: MailboxKnowledgeFlagsService,
    private readonly repository: MailboxKnowledgeExtractionRepository,
    private readonly mailbox: MailboxKnowledgeRepository,
    private readonly normalizer: MailboxNormalizerService,
    private readonly events: KnowledgeEventService,
    private readonly extractor: MailboxKnowledgeExtractorService,
    private readonly resolver: UniversalEntityResolutionOrchestratorService,
    private readonly assertions: KnowledgeAssertionService,
  ) {}

  async drainOnce(): Promise<MailboxKnowledgeExtractionDrainResult> {
    const result: MailboxKnowledgeExtractionDrainResult = {
      claimed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    };
    if (!this.flags.extractionEnabled() || this.draining) return result;

    this.draining = true;
    try {
      const jobs = await this.repository.claimBatch(
        this.workerId,
        this.flags.extractionBatchSize(),
      );
      result.claimed = jobs.length;
      for (const job of jobs) {
        const outcome = await this.processClaimedJob(job);
        result[outcome] += 1;
      }
      return result;
    } finally {
      this.draining = false;
    }
  }

  private async processClaimedJob(
    job: MailboxKnowledgeExtractionJobRecord,
  ): Promise<'succeeded' | 'skipped' | 'failed'> {
    try {
      const message = await this.mailbox.loadMessage(job.tenantId, job.mailMessageId);
      if (!message) return this.skip(job, 'mail message no longer exists');
      if (message.removedAt) {
        return this.skip(
          job,
          `mail message is removed${message.removedReason ? `: ${message.removedReason}` : ''}`,
        );
      }
      if (message.currentSourceRevision !== job.sourceRevision) {
        return this.skip(job, 'mail message revision was superseded before extraction');
      }
      if (!hasAuthoritativeProviderBody(message)) {
        return this.skip(job, 'mail message no longer has a full authoritative provider body');
      }

      const normalized = this.normalizer.normalize(message);
      if (!normalized.authoritativeText || !normalized.normalizedText) {
        return this.skip(job, 'mail message has no canonical authoritative extraction text');
      }
      if (normalized.authoritativeContentHash !== job.contentHash) {
        return this.skip(
          job,
          'mail message content hash no longer matches the queued KnowledgeEvent',
        );
      }

      const event = await this.events.findById(job.tenantId, job.eventId);
      const invalidEvent = validateEvent(job, event);
      if (invalidEvent) return this.skip(job, invalidEvent);
      const activeEvent = event!;

      const actorUserId = readString(activeEvent.accessScope, 'userId');
      if (!actorUserId) {
        return this.skip(job, 'KnowledgeEvent access scope has no mailbox owner user');
      }

      const linkedClientId =
        activeEvent.clientRefs.find((ref) => ref.type === 'client')?.id ?? null;
      const preResolved = await this.preResolveEnvelopeIdentities({
        tenantId: job.tenantId,
        actorUserId,
        message,
        linkedClientId,
      });

      let replayedFromCheckpoint = false;
      let extraction = readExtractionCheckpoint(job.result, job);
      if (extraction) {
        replayedFromCheckpoint = true;
      } else {
        extraction = await this.extractor.extract(
          job.tenantId,
          message,
          normalized,
          preResolved.hints,
        );
        const checkpointed = await this.repository.checkpointExtraction(
          job,
          buildExtractionCheckpoint(job, extraction),
        );
        if (checkpointed === false) return 'skipped';
      }

      const manifests: MailboxClaimResolutionManifest[] = [];
      for (const [index, candidate] of extraction.candidates.entries()) {
        const manifest = await this.repository.withClaimLease(job, () =>
          this.processCandidate({
            tenantId: job.tenantId,
            actorUserId,
            event: activeEvent,
            message,
            normalized,
            linkedClientId,
            preResolved: preResolved.resolutions,
            candidate,
            index,
          }),
        );
        if (!manifest) return 'skipped';
        manifests.push(manifest);
      }

      const assertionIds = new Set(
        manifests.flatMap((manifest) => (manifest.assertionId ? [manifest.assertionId] : [])),
      );
      const heldCount = manifests.filter((manifest) => manifest.disposition !== 'asserted').length;
      const result = {
        phase: 6,
        pipeline: 'mailbox-knowledge-extraction-v1',
        eventId: activeEvent.id,
        sourceRevision: job.sourceRevision,
        contentHash: job.contentHash,
        provider: extraction.provider,
        model: extraction.model,
        inputTruncated: extraction.inputTruncated,
        replayedFromCheckpoint,
        preResolvedIdentityContext: preResolved.hints,
        candidateCount: extraction.candidates.length,
        claims: manifests,
      } as unknown as KnowledgeJsonObject;

      const completed = await this.repository.complete(job, result, assertionIds.size, heldCount);
      if (completed === false) return 'skipped';
      return 'succeeded';
    } catch (error) {
      const failed = await this.repository.fail(job, error, this.flags.extractionMaxAttempts());
      if (failed === false) return 'skipped';
      this.logger.warn(
        `Mailbox knowledge extraction job failed on attempt ${job.attemptCount}: ${
          error instanceof Error ? error.name : 'UnknownError'
        }`,
      );
      return 'failed';
    }
  }

  private async preResolveEnvelopeIdentities(input: {
    tenantId: string;
    actorUserId: string;
    message: MailboxMessageRecord;
    linkedClientId: string | null;
  }): Promise<PreResolvedEnvelopeIdentities> {
    const hints: MailboxExtractionIdentityHint[] = [];
    const resolutions = new Map<string, UniversalEntityResolutionOrchestrationResult>();

    if (input.linkedClientId) {
      const resolution = await this.resolver.resolveAcrossSources(input.tenantId, {
        query: '',
        actorUserId: input.actorUserId,
        entityTypeHint: 'organization',
        identifiers: [{ type: 'crm_client_id', value: input.linkedClientId }],
        allowAuthoritativePublicRegistration: false,
        allowExternalLookup: false,
      });
      resolutions.set(LINKED_CLIENT_RESOLUTION_KEY, resolution);
      hints.push(identityHint('linked_client', null, null, resolution));
    }

    const senderEmail = input.message.fromEmail?.trim().toLowerCase() ?? null;
    if (senderEmail) {
      const resolution = await this.resolver.resolveAcrossSources(input.tenantId, {
        query: input.message.fromName?.trim() || senderEmail,
        actorUserId: input.actorUserId,
        entityTypeHint: 'person',
        identifiers: identityIdentifiers(senderEmail),
        allowAuthoritativePublicRegistration: false,
        allowExternalLookup: false,
      });
      resolutions.set(senderResolutionKey(senderEmail), resolution);
      hints.push(
        identityHint('sender', input.message.fromName?.trim() || null, senderEmail, resolution),
      );
    }

    return { hints, resolutions };
  }

  private async processCandidate(input: {
    tenantId: string;
    actorUserId: string;
    event: KnowledgeEventRecord;
    message: MailboxMessageRecord;
    normalized: NormalizedMailboxMessage;
    linkedClientId: string | null;
    preResolved: Map<string, UniversalEntityResolutionOrchestrationResult>;
    candidate: MailboxExtractedClaimCandidate;
    index: number;
  }): Promise<MailboxClaimResolutionManifest> {
    const evidence = locateEvidence(
      input.normalized.authoritativeText,
      input.candidate.excerpt,
      input.event.sourceContentHash,
    );
    const base = baseManifest(input.candidate, input.index, evidence);
    if (!evidence) {
      return { ...base, disposition: 'held_invalid_evidence' };
    }

    const subjectInput = subjectResolutionInput(
      input.candidate,
      input.message,
      input.linkedClientId,
      input.actorUserId,
    );
    if (!subjectInput) {
      return { ...base, disposition: 'held_invalid_subject' };
    }

    const preResolvedSubject = preResolvedSubjectForCandidate(
      input.candidate,
      input.message,
      input.preResolved,
    );
    const subject =
      preResolvedSubject ??
      (await this.resolver.resolveAcrossSources(input.tenantId, subjectInput));
    const subjectManifest = resolutionManifest(subject);
    base.subject = {
      ...base.subject,
      ...subjectManifest,
    };
    if (subject.status !== 'resolved' || !subject.entity) {
      return {
        ...base,
        disposition:
          subject.status === 'ambiguous' ? 'held_subject_ambiguous' : 'held_subject_unresolved',
      };
    }

    let objectEntity: UniversalEntityResolutionOrchestrationResult | null = null;
    if (hasObjectEntity(input.candidate)) {
      objectEntity = await this.resolver.resolveAcrossSources(input.tenantId, {
        query: input.candidate.objectEntityText ?? '',
        actorUserId: input.actorUserId,
        entityTypeHint: input.candidate.objectEntityType,
        identifiers: identityIdentifiers(input.candidate.objectEntityEmail),
        allowAuthoritativePublicRegistration: false,
        allowExternalLookup: false,
      });
      base.object = {
        ...base.object,
        ...objectResolutionManifest(objectEntity),
      };
      if (objectEntity.status !== 'resolved' || !objectEntity.entity) {
        return {
          ...base,
          disposition:
            objectEntity.status === 'ambiguous'
              ? 'held_object_ambiguous'
              : 'held_object_unresolved',
        };
      }
    }

    const assertion = await this.assertions.append(input.tenantId, {
      originEventId: input.event.id,
      subjectType: 'canonical_entity',
      subjectId: subject.entity.id,
      predicate: input.candidate.predicate,
      objectType: objectEntity?.entity ? 'canonical_entity' : input.candidate.objectType,
      objectId: objectEntity?.entity?.id ?? null,
      ...(objectEntity?.entity
        ? {}
        : { objectValue: input.candidate.objectValue as Exclude<MailboxClaimPrimitive, null> }),
      assertionClass: input.candidate.assertionClass,
      confidence: input.candidate.confidence,
      authority: 'source_reported',
      observedAt: input.event.observedAt,
      validFrom: input.event.occurredAt,
      evidence: [
        {
          eventId: input.event.id,
          sourceType: input.event.sourceType,
          sourceId: input.event.sourceId,
          excerpt: input.candidate.excerpt,
          startOffset: evidence.startOffset,
          endOffset: evidence.endOffset,
          contentHash: input.event.sourceContentHash,
          sourceText: input.normalized.authoritativeText,
        },
      ],
    });

    return {
      ...base,
      disposition: 'asserted',
      assertionId: assertion.id,
      subject: {
        ...base.subject,
        canonicalEntityId: subject.entity.id,
      },
      object: {
        ...base.object,
        canonicalEntityId: objectEntity?.entity?.id ?? null,
      },
    };
  }

  private async skip(job: MailboxKnowledgeExtractionJobRecord, reason: string): Promise<'skipped'> {
    await this.repository.skip(job, reason, {
      phase: 6,
      pipeline: 'mailbox-knowledge-extraction-v1',
      eventId: job.eventId,
      sourceRevision: job.sourceRevision,
      contentHash: job.contentHash,
      skipped: true,
      reason,
    });
    return 'skipped';
  }
}

function buildExtractionCheckpoint(
  job: MailboxKnowledgeExtractionJobRecord,
  extraction: MailboxExtractionModelResult,
): KnowledgeJsonObject {
  return {
    phase: 6,
    checkpoint: EXTRACTION_CHECKPOINT,
    eventId: job.eventId,
    sourceRevision: job.sourceRevision,
    contentHash: job.contentHash,
    provider: extraction.provider,
    model: extraction.model,
    inputTruncated: extraction.inputTruncated,
    candidates: extraction.candidates as unknown as KnowledgeJsonObject['candidates'],
  };
}

function readExtractionCheckpoint(
  value: KnowledgeJsonObject | null,
  job: MailboxKnowledgeExtractionJobRecord,
): MailboxExtractionModelResult | null {
  if (!value) return null;
  if (
    value.phase !== 6 ||
    value.checkpoint !== EXTRACTION_CHECKPOINT ||
    value.eventId !== job.eventId ||
    value.sourceRevision !== job.sourceRevision ||
    value.contentHash !== job.contentHash
  ) {
    throw new Error('Mailbox knowledge extraction checkpoint does not match the claimed job.');
  }

  const extraction = parseMailboxExtractionModelResult({
    provider: value.provider,
    model: value.model,
    inputTruncated: value.inputTruncated,
    candidates: value.candidates,
  });
  if (!extraction) {
    throw new Error('Mailbox knowledge extraction checkpoint is malformed.');
  }
  return extraction;
}

function validateEvent(
  job: MailboxKnowledgeExtractionJobRecord,
  event: KnowledgeEventRecord | null,
): string | null {
  if (!event) return 'KnowledgeEvent no longer exists';
  if (event.status !== 'active') return 'KnowledgeEvent is no longer active';
  if (event.sourceVersion !== job.sourceRevision) {
    return 'KnowledgeEvent source revision does not match the extraction job';
  }
  if (event.sourceContentHash !== job.contentHash) {
    return 'KnowledgeEvent content hash does not match the extraction job';
  }
  if (event.sensitivity !== job.sensitivity || !jsonEquals(event.accessScope, job.accessScope)) {
    return 'KnowledgeEvent security scope does not match the extraction job';
  }
  if (readString(event.evidenceLocator, 'mailMessageId') !== job.mailMessageId) {
    return 'KnowledgeEvent evidence locator does not match the mailbox message';
  }
  if (event.metadata.readyForExtraction !== true) {
    return 'KnowledgeEvent is not marked ready for extraction';
  }
  return null;
}

function subjectResolutionInput(
  candidate: MailboxExtractedClaimCandidate,
  message: MailboxMessageRecord,
  linkedClientId: string | null,
  actorUserId: string,
) {
  switch (candidate.subjectRole) {
    case 'linked_client':
      return linkedClientId
        ? {
            query: '',
            actorUserId,
            entityTypeHint: 'organization',
            identifiers: [{ type: 'crm_client_id', value: linkedClientId }],
            allowAuthoritativePublicRegistration: false,
            allowExternalLookup: false,
          }
        : null;
    case 'sender': {
      const email = message.fromEmail?.trim().toLowerCase() ?? null;
      if (!email) return null;
      return {
        query: message.fromName?.trim() || email,
        actorUserId,
        entityTypeHint: 'person',
        identifiers: identityIdentifiers(email),
        allowAuthoritativePublicRegistration: false,
        allowExternalLookup: false,
      };
    }
    case 'recipient': {
      const requested = candidate.subjectEmail?.trim().toLowerCase();
      if (!requested) return null;
      const participant = [...message.toRecipients, ...message.ccRecipients].find(
        (recipient) => recipient.email === requested,
      );
      if (!participant) return null;
      return {
        query: participant.name ?? participant.email,
        actorUserId,
        entityTypeHint: candidate.subjectEntityType,
        identifiers: identityIdentifiers(participant.email),
        allowAuthoritativePublicRegistration: false,
        allowExternalLookup: false,
      };
    }
    case 'named_entity':
      if (!candidate.subjectText && !candidate.subjectEmail) return null;
      return {
        query: candidate.subjectText ?? candidate.subjectEmail ?? '',
        actorUserId,
        entityTypeHint: candidate.subjectEntityType,
        identifiers: identityIdentifiers(candidate.subjectEmail),
        allowAuthoritativePublicRegistration: false,
        allowExternalLookup: false,
      };
  }
}

function preResolvedSubjectForCandidate(
  candidate: MailboxExtractedClaimCandidate,
  message: MailboxMessageRecord,
  preResolved: Map<string, UniversalEntityResolutionOrchestrationResult>,
): UniversalEntityResolutionOrchestrationResult | null {
  if (candidate.subjectRole === 'linked_client') {
    return preResolved.get(LINKED_CLIENT_RESOLUTION_KEY) ?? null;
  }
  if (candidate.subjectRole === 'sender') {
    const email = message.fromEmail?.trim().toLowerCase();
    return email ? (preResolved.get(senderResolutionKey(email)) ?? null) : null;
  }
  return null;
}

function senderResolutionKey(email: string): string {
  return `${SENDER_RESOLUTION_PREFIX}${email.trim().toLowerCase()}`;
}

function identityHint(
  role: MailboxExtractionIdentityHint['role'],
  sourceText: string | null,
  sourceEmail: string | null,
  resolution: UniversalEntityResolutionOrchestrationResult,
): MailboxExtractionIdentityHint {
  return {
    role,
    sourceText,
    sourceEmail,
    resolutionStatus: resolution.status,
    canonicalName: resolution.entity?.canonicalName ?? null,
    entityType: resolution.entity?.entityType ?? null,
    confidence: resolution.confidence,
    method: resolution.resolutionMethod,
  };
}

function identityIdentifiers(
  email: string | null | undefined,
): Array<{ type: string; value: string }> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return [];
  const domain = normalized.split('@')[1] ?? '';
  return [
    { type: 'email', value: normalized },
    ...(domain ? [{ type: 'domain', value: domain }] : []),
  ];
}

function hasObjectEntity(candidate: MailboxExtractedClaimCandidate): boolean {
  return Boolean(candidate.objectEntityText || candidate.objectEntityEmail);
}

function locateEvidence(
  sourceText: string,
  excerpt: string,
  contentHash: string,
): { startOffset: number; endOffset: number; contentHash: string } | null {
  const startOffset = sourceText.indexOf(excerpt);
  if (startOffset < 0) return null;
  return {
    startOffset,
    endOffset: startOffset + excerpt.length,
    contentHash,
  };
}

function baseManifest(
  candidate: MailboxExtractedClaimCandidate,
  index: number,
  evidence: { startOffset: number; endOffset: number; contentHash: string } | null,
): MailboxClaimResolutionManifest {
  return {
    index,
    disposition: 'held_invalid_subject',
    assertionClass: candidate.assertionClass,
    predicate: candidate.predicate,
    subject: {
      role: candidate.subjectRole,
      text: candidate.subjectText,
      email: candidate.subjectEmail,
      entityType: candidate.subjectEntityType,
      resolutionStatus: 'not_attempted',
      canonicalEntityId: null,
      resolutionId: null,
      confidence: null,
      method: null,
      stopReason: null,
    },
    object: {
      type: candidate.objectType,
      value: candidate.objectValue,
      entityText: candidate.objectEntityText,
      entityEmail: candidate.objectEntityEmail,
      entityType: candidate.objectEntityType,
      resolutionStatus: hasObjectEntity(candidate) ? 'unresolved' : 'not_applicable',
      canonicalEntityId: null,
      resolutionId: null,
      confidence: null,
      method: null,
      stopReason: null,
    },
    evidence,
    assertionId: null,
  };
}

function resolutionManifest(result: UniversalEntityResolutionOrchestrationResult) {
  return {
    resolutionStatus: result.status,
    canonicalEntityId: result.entity?.id ?? null,
    resolutionId: result.resolutionId,
    confidence: result.confidence,
    method: result.resolutionMethod,
    stopReason: result.stopReason,
  } as const;
}

function objectResolutionManifest(result: UniversalEntityResolutionOrchestrationResult) {
  return {
    resolutionStatus: result.status,
    canonicalEntityId: result.entity?.id ?? null,
    resolutionId: result.resolutionId,
    confidence: result.confidence,
    method: result.resolutionMethod,
    stopReason: result.stopReason,
  } as const;
}

function readString(value: KnowledgeJsonObject, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}
