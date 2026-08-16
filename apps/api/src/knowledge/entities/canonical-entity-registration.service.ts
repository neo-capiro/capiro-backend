import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  normalizeEntityIdentifier,
  normalizeEntityType,
  normalizeIdentifierType,
} from './entity-normalization.js';
import type { CanonicalEntityRecord } from './entity-resolution.types.js';
import {
  CANONICAL_ENTITY_MERGE_REASON_CODES,
  GLOBAL_AUTHORITATIVE_IDENTIFIER_TYPES,
  GLOBAL_AUTHORITATIVE_SOURCE_TYPES,
  type LinkTenantIdentityInput,
  type MergeTenantPrivateEntityInput,
  type RegisterGlobalPublicEntityInput,
} from './canonical-entity-registration.types.js';
import { CanonicalEntityRegistrationRepository } from './canonical-entity-registration.repository.js';

/**
 * Internal registration boundary for trusted global identity and tenant-local
 * source bindings. It is intentionally not exposed through a controller.
 */
@Injectable()
export class CanonicalEntityRegistrationService {
  constructor(
    private readonly repository: CanonicalEntityRegistrationRepository,
  ) {}

  async registerGlobalPublicEntity(
    input: RegisterGlobalPublicEntityInput,
  ): Promise<CanonicalEntityRecord> {
    const entityType = normalizeEntityType(input.entityType);
    if (!entityType || !input.canonicalName.trim()) {
      throw new BadRequestException(
        'Global canonical entity name and type are required.',
      );
    }
    if (input.identifiers.length === 0) {
      throw new BadRequestException(
        'A global public entity requires at least one authoritative identifier.',
      );
    }

    assertAuthoritativeSource(input.resolutionMethod);
    const identifiers = input.identifiers.map((identifier) => {
      assertAuthoritativeSource(identifier.sourceType);
      const type = normalizeIdentifierType(identifier.type);
      if (
        !(GLOBAL_AUTHORITATIVE_IDENTIFIER_TYPES as readonly string[]).includes(
          type,
        )
      ) {
        throw new BadRequestException(
          `Identifier type ${type} cannot establish globally reusable identity.`,
        );
      }
      return {
        type,
        normalizedValue: normalizeEntityIdentifier(type, identifier.value),
      };
    });

    for (const alias of input.aliases ?? []) {
      assertAuthoritativeSource(alias.sourceType);
    }

    const existing = await this.repository.findGlobalByIdentifiers(identifiers);
    if (existing.length > 1) {
      throw new ConflictException(
        'Authoritative identifiers resolve to different global entities; human reconciliation is required.',
      );
    }

    const match = existing[0];
    if (match) {
      if (match.entityType !== entityType) {
        throw new ConflictException(
          `Authoritative identifier is already linked to entity type ${match.entityType}.`,
        );
      }
      return this.repository.attachGlobalIdentity(match.id, input);
    }

    const exactNameMatches = await this.repository.findGlobalByExactName(
      entityType,
      input.canonicalName,
    );
    if (exactNameMatches.length > 0) {
      throw new ConflictException(
        'An exact-name global entity already exists without matching authoritative identifiers; human reconciliation is required.',
      );
    }

    return this.repository.createGlobalPublicEntity(input);
  }

  async mergeTenantPrivateEntity(
    tenantId: string,
    input: MergeTenantPrivateEntityInput,
  ): Promise<CanonicalEntityRecord> {
    if (input.sourceEntityId === input.targetEntityId) {
      throw new BadRequestException('Canonical merge source and target must differ.');
    }
    const reasonCode = normalizeIdentifierType(input.reasonCode);
    if (
      !(CANONICAL_ENTITY_MERGE_REASON_CODES as readonly string[]).includes(
        reasonCode,
      )
    ) {
      throw new BadRequestException(
        `Unsupported canonical merge reason: ${reasonCode}.`,
      );
    }
    return this.repository.mergeTenantPrivateEntity(tenantId, {
      ...input,
      reasonCode,
    });
  }

  async linkTenantIdentity(
    tenantId: string,
    input: LinkTenantIdentityInput,
  ): Promise<CanonicalEntityRecord> {
    if (
      (input.aliases?.length ?? 0) === 0 &&
      (input.identifiers?.length ?? 0) === 0
    ) {
      throw new BadRequestException(
        'At least one tenant-private alias or identifier is required.',
      );
    }
    return this.repository.attachTenantPrivateIdentity(
      tenantId,
      input.entityId,
      input,
    );
  }
}

function assertAuthoritativeSource(sourceType: string): void {
  const normalized = normalizeIdentifierType(sourceType);
  if (
    !(GLOBAL_AUTHORITATIVE_SOURCE_TYPES as readonly string[]).includes(
      normalized,
    )
  ) {
    throw new BadRequestException(
      `Source type ${normalized} cannot establish globally reusable identity.`,
    );
  }
}
