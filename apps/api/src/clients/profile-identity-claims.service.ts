import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { KnowledgeEventService } from '../knowledge/events/knowledge-event.service.js';
import { KnowledgeAssertionService } from '../knowledge/assertions/knowledge-assertion.service.js';
import { CanonicalEntityRegistrationService } from '../knowledge/entities/canonical-entity-registration.service.js';
import { sha256Text } from '../knowledge/knowledge.helpers.js';
import type { ProfileIdentityClaim } from './profile-identity.contracts.js';

/** Person-confirmed relationships remain tenant scoped, including on globally shared identities. */
@Injectable()
export class ProfileIdentityClaimsService {
  constructor(
    private readonly events: KnowledgeEventService,
    private readonly assertions: KnowledgeAssertionService,
    private readonly identity: CanonicalEntityRegistrationService,
  ) {}
  async retain(ctx: TenantContext, entityId: string, claims: ProfileIdentityClaim[]) {
    const aliases = claims
      .filter(
        (claim) => !claim.attachmentId && (claim.kind === 'alias' || claim.kind === 'former_name'),
      )
      .map((claim) => ({
        value: claim.name,
        sourceType: 'person_confirmed_identity',
        sourceId: claim.attachmentId ?? sha256Text(claim.sourceUrl!),
        confidence: 1,
        verifiedAt: null,
      }));
    if (aliases.length) await this.identity.linkTenantIdentity(ctx.tenantId, { entityId, aliases });
    for (const claim of claims) {
      const sourceType = claim.attachmentId
          ? 'profile_identity_document'
          : 'person_confirmed_identity',
        sourceId = claim.attachmentId ?? sha256Text(claim.sourceUrl!),
        contentHash = sha256Text(claim.quote),
        now = new Date();
      const event = await this.events.append(ctx.tenantId, {
        sourceType,
        sourceId,
        sourceContentHash: contentHash,
        eventType: 'identity_relationship_confirmed',
        occurredAt: now,
        observedAt: now,
        actorRefs: [{ type: 'user', id: ctx.userId }],
        entityRefs: [{ type: 'canonical_entity', id: entityId }],
        accessScope: claim.attachmentId
          ? { kind: 'user', userId: ctx.userId, clientIds: [] }
          : { kind: 'tenant' },
        evidenceLocator: claim.attachmentId
          ? { attachmentId: claim.attachmentId }
          : { url: claim.sourceUrl! },
        metadata: { reviewedBy: ctx.userId, claimKind: claim.kind, confirmation: 'person' },
      });
      await this.assertions.append(ctx.tenantId, {
        originEventId: event.id,
        subjectType: 'canonical_entity',
        subjectId: entityId,
        predicate: `identity_${claim.kind}`,
        objectType: 'organization_name',
        objectValue: {
          name: claim.name,
          ...(claim.attachmentId
            ? { attachmentId: claim.attachmentId }
            : { sourceUrl: claim.sourceUrl! }),
        },
        assertionClass: 'relationship',
        authority: 'human_confirmed',
        confidence: 1,
        createdBy: ctx.userId,
        evidence: [
          {
            eventId: event.id,
            sourceType,
            sourceId,
            excerpt: claim.quote,
            startOffset: 0,
            endOffset: claim.quote.length,
            contentHash,
            sourceText: claim.quote,
          },
        ],
      });
    }
  }
}
