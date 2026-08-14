import { BadRequestException, Injectable } from '@nestjs/common';
import { isDisallowedKnowledgeFactualSourceType } from '../events/knowledge-event.service.js';
import {
  requireSha256,
  requireText,
  requireToken,
  requireUuid,
  sha256Text,
} from '../knowledge.helpers.js';
import type {
  AppendKnowledgeEvidenceInput,
  KnowledgeEventRecord,
  NormalizedKnowledgeEvidenceInput,
} from '../knowledge.types.js';

const MAX_EVIDENCE_EXCERPT_CHARS = 16_000;
const MAX_CANONICAL_SOURCE_CHARS = 10_000_000;

/**
 * Validates exact excerpt-level proof before anything durable is written.
 * The canonical source text is used transiently and never persisted here.
 */
@Injectable()
export class KnowledgeEvidenceValidatorService {
  normalize(
    tenantId: string,
    event: KnowledgeEventRecord,
    input: AppendKnowledgeEvidenceInput,
    index = 0,
  ): NormalizedKnowledgeEvidenceInput {
    const prefix = `evidence[${index}]`;
    const normalizedTenantId = requireUuid(tenantId, 'tenantId');
    if (event.tenantId !== normalizedTenantId) {
      throw new BadRequestException(`${prefix} event must belong to the same tenant.`);
    }
    if (event.status !== 'active') {
      throw new BadRequestException(`${prefix} requires an active KnowledgeEvent.`);
    }
    if (isDisallowedKnowledgeFactualSourceType(event.sourceType)) {
      throw new BadRequestException(
        `${prefix} cannot use an AI-generated answer as factual evidence.`,
      );
    }

    const eventId = requireUuid(input.eventId, `${prefix}.eventId`);
    if (eventId !== event.id) {
      throw new BadRequestException(`${prefix}.eventId does not match the loaded event.`);
    }

    const sourceType = requireToken(input.sourceType, `${prefix}.sourceType`);
    if (sourceType !== event.sourceType) {
      throw new BadRequestException(`${prefix}.sourceType must match the KnowledgeEvent.`);
    }

    const sourceId = requireText(input.sourceId, `${prefix}.sourceId`, 512);
    if (sourceId !== event.sourceId) {
      throw new BadRequestException(`${prefix}.sourceId must match the KnowledgeEvent.`);
    }

    const contentHash = requireSha256(input.contentHash, `${prefix}.contentHash`);
    if (contentHash !== event.sourceContentHash) {
      throw new BadRequestException(
        `${prefix}.contentHash must match the KnowledgeEvent source version.`,
      );
    }

    if (typeof input.sourceText !== 'string' || input.sourceText.length === 0) {
      throw new BadRequestException(`${prefix}.sourceText is required for exact validation.`);
    }
    if (input.sourceText.length > MAX_CANONICAL_SOURCE_CHARS) {
      throw new BadRequestException(
        `${prefix}.sourceText exceeds the ${MAX_CANONICAL_SOURCE_CHARS}-character validation limit.`,
      );
    }
    if (sha256Text(input.sourceText) !== contentHash) {
      throw new BadRequestException(
        `${prefix}.sourceText does not match the event content hash.`,
      );
    }

    if (!Number.isInteger(input.startOffset) || input.startOffset < 0) {
      throw new BadRequestException(`${prefix}.startOffset must be a non-negative integer.`);
    }
    if (!Number.isInteger(input.endOffset) || input.endOffset <= input.startOffset) {
      throw new BadRequestException(
        `${prefix}.endOffset must be an integer greater than startOffset.`,
      );
    }
    if (input.endOffset > input.sourceText.length) {
      throw new BadRequestException(`${prefix}.endOffset exceeds the canonical source text.`);
    }

    if (typeof input.excerpt !== 'string' || input.excerpt.trim().length === 0) {
      throw new BadRequestException(`${prefix}.excerpt must contain exact source text.`);
    }
    if (input.excerpt.length > MAX_EVIDENCE_EXCERPT_CHARS) {
      throw new BadRequestException(
        `${prefix}.excerpt must be at most ${MAX_EVIDENCE_EXCERPT_CHARS} characters.`,
      );
    }

    const exactExcerpt = input.sourceText.slice(input.startOffset, input.endOffset);
    if (exactExcerpt !== input.excerpt) {
      throw new BadRequestException(
        `${prefix}.excerpt must exactly equal sourceText.slice(startOffset, endOffset).`,
      );
    }

    return {
      eventId,
      sourceType,
      sourceId,
      excerpt: input.excerpt,
      startOffset: input.startOffset,
      endOffset: input.endOffset,
      contentHash,
    };
  }
}
