import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { KnowledgeAssertionRepository } from '../assertions/knowledge-assertion.repository.js';
import { KnowledgeEventService } from '../events/knowledge-event.service.js';
import {
  requireText,
  requireToken,
  requireUuid,
} from '../knowledge.helpers.js';
import type {
  KnowledgeAssertionProvenance,
  KnowledgeEvidenceProvenanceEntry,
  KnowledgeEvidenceRecord,
  KnowledgeEventRecord,
} from '../knowledge.types.js';
import { KnowledgeEvidenceRepository } from './knowledge-evidence.repository.js';

/** Read-only provenance facade for the future “Why Capiro Knows This” surface. */
@Injectable()
export class KnowledgeEvidenceService {
  constructor(
    private readonly evidence: KnowledgeEvidenceRepository,
    private readonly assertions: KnowledgeAssertionRepository,
    private readonly events: KnowledgeEventService,
  ) {}

  async findByAssertionId(
    tenantId: string,
    assertionId: string,
  ): Promise<KnowledgeEvidenceRecord[]> {
    return this.evidence.findByAssertionId(
      requireUuid(tenantId, 'tenantId'),
      requireUuid(assertionId, 'assertionId'),
    );
  }

  async findByEventId(
    tenantId: string,
    eventId: string,
  ): Promise<KnowledgeEvidenceRecord[]> {
    return this.evidence.findByEventId(
      requireUuid(tenantId, 'tenantId'),
      requireUuid(eventId, 'eventId'),
    );
  }

  async findBySource(
    tenantId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<KnowledgeEvidenceRecord[]> {
    return this.evidence.findBySource(
      requireUuid(tenantId, 'tenantId'),
      requireToken(sourceType, 'sourceType'),
      requireText(sourceId, 'sourceId', 512),
    );
  }

  async getAssertionProvenance(
    tenantId: string,
    assertionId: string,
  ): Promise<KnowledgeAssertionProvenance> {
    const normalizedTenantId = requireUuid(tenantId, 'tenantId');
    const normalizedAssertionId = requireUuid(assertionId, 'assertionId');
    const assertion = await this.assertions.findById(
      normalizedTenantId,
      normalizedAssertionId,
    );
    if (!assertion) throw new NotFoundException('KnowledgeAssertion not found.');

    const links = await this.evidence.findByAssertionId(
      normalizedTenantId,
      normalizedAssertionId,
    );
    if (links.length === 0) {
      throw new InternalServerErrorException(
        'KnowledgeAssertion has no immutable evidence provenance.',
      );
    }

    const eventCache = new Map<string, KnowledgeEventRecord>();
    const provenance: KnowledgeEvidenceProvenanceEntry[] = [];
    for (const link of links) {
      let event = eventCache.get(link.eventId);
      if (!event) {
        const loaded = await this.events.findById(normalizedTenantId, link.eventId);
        if (!loaded) {
          throw new InternalServerErrorException(
            'KnowledgeEvidence references an unavailable KnowledgeEvent.',
          );
        }
        event = loaded;
        eventCache.set(link.eventId, event);
      }
      provenance.push({ evidence: link, event });
    }

    return { assertion, evidence: provenance };
  }
}
