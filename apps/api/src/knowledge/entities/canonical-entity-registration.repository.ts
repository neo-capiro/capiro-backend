import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  clampResolutionConfidence,
  normalizeEntityIdentifier,
  normalizeEntityText,
  normalizeEntityType,
  normalizeIdentifierType,
} from './entity-normalization.js';
import type {
  CanonicalEntityRecord,
  EntityAliasInput,
  EntityIdentifierRegistrationInput,
} from './entity-resolution.types.js';
import type {
  AttachEntityIdentityInput,
  GlobalIdentifierLookupInput,
  RegisterGlobalPublicEntityInput,
} from './canonical-entity-registration.types.js';

interface CanonicalEntityRow {
  id: string;
  tenant_id: string | null;
  identity_scope: 'global_public' | 'tenant_private';
  entity_type: string;
  canonical_name: string;
  normalized_name: string;
  status: 'active' | 'merged' | 'withdrawn';
  resolution_confidence: Prisma.Decimal | number | string;
  resolution_method: string;
  metadata: unknown;
  merged_into_entity_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface IdentifierOwnerRow {
  entity_id: string;
}

/**
 * Trusted registration boundary for canonical identity.
 *
 * Tenant callers may attach tenant-private aliases/identifiers to a visible
 * entity. Only trusted server code using withSystem may create or enrich a
 * globally reusable public identity. No controller exposes this repository.
 */
@Injectable()
export class CanonicalEntityRegistrationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findGlobalByIdentifiers(
    identifiers: readonly GlobalIdentifierLookupInput[],
  ): Promise<CanonicalEntityRecord[]> {
    if (identifiers.length === 0) return [];

    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<CanonicalEntityRow[]>`
        WITH requested AS (
          SELECT identifier_type, normalized_value
          FROM jsonb_to_recordset(
            CAST(${JSON.stringify(
              identifiers.map((identifier) => ({
                identifier_type: identifier.type,
                normalized_value: identifier.normalizedValue,
              })),
            )} AS jsonb)
          ) AS item(identifier_type text, normalized_value text)
        )
        SELECT DISTINCT
          entity.id,
          entity.tenant_id,
          entity.identity_scope,
          entity.entity_type,
          entity.canonical_name,
          entity.normalized_name,
          entity.status,
          entity.resolution_confidence,
          entity.resolution_method,
          entity.metadata,
          entity.merged_into_entity_id,
          entity.created_at,
          entity.updated_at
        FROM requested
        JOIN entity_identifiers AS identifier
          ON identifier.identifier_type = requested.identifier_type
         AND identifier.normalized_value = requested.normalized_value
         AND identifier.identity_scope = 'global_public'
         AND identifier.tenant_id IS NULL
         AND identifier.status = 'active'
        JOIN canonical_entities AS entity
          ON entity.id = identifier.entity_id
         AND entity.identity_scope = 'global_public'
         AND entity.tenant_id IS NULL
         AND entity.status = 'active'
        ORDER BY entity.canonical_name, entity.id
      `;
      return rows.map(mapEntity);
    });
  }

  async createGlobalPublicEntity(
    input: RegisterGlobalPublicEntityInput,
  ): Promise<CanonicalEntityRecord> {
    return this.prisma.withSystem(async (tx) => {
      const normalizedName = normalizeEntityText(input.canonicalName);
      const entityType = normalizeEntityType(input.entityType);
      if (!normalizedName || !entityType) {
        throw new Error('Canonical entity name and type are required.');
      }

      const rows = await tx.$queryRaw<CanonicalEntityRow[]>`
        INSERT INTO canonical_entities (
          tenant_id,
          identity_scope,
          entity_type,
          canonical_name,
          normalized_name,
          status,
          resolution_confidence,
          resolution_method,
          metadata
        )
        VALUES (
          NULL,
          'global_public',
          ${entityType},
          ${input.canonicalName.trim()},
          ${normalizedName},
          'active',
          ${clampResolutionConfidence(input.resolutionConfidence, 1)},
          ${normalizeIdentifierType(input.resolutionMethod)},
          CAST(${JSON.stringify(input.metadata ?? {})} AS jsonb)
        )
        RETURNING
          id,
          tenant_id,
          identity_scope,
          entity_type,
          canonical_name,
          normalized_name,
          status,
          resolution_confidence,
          resolution_method,
          metadata,
          merged_into_entity_id,
          created_at,
          updated_at
      `;
      const entity = rows[0];
      if (!entity) {
        throw new InternalServerErrorException(
          'Global canonical entity insert did not return a row.',
        );
      }

      await this.appendGlobalIdentityLinks(
        tx,
        entity.id,
        input.aliases ?? [],
        input.identifiers,
      );
      return mapEntity(entity);
    });
  }

  async attachGlobalIdentity(
    entityId: string,
    input: AttachEntityIdentityInput,
  ): Promise<CanonicalEntityRecord> {
    return this.prisma.withSystem(async (tx) => {
      const entity = await this.loadGlobalEntity(tx, entityId);
      await this.appendGlobalIdentityLinks(
        tx,
        entity.id,
        input.aliases ?? [],
        input.identifiers ?? [],
      );
      return mapEntity(entity);
    });
  }

  async attachTenantPrivateIdentity(
    tenantId: string,
    entityId: string,
    input: AttachEntityIdentityInput,
  ): Promise<CanonicalEntityRecord> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<CanonicalEntityRow[]>`
        SELECT
          id,
          tenant_id,
          identity_scope,
          entity_type,
          canonical_name,
          normalized_name,
          status,
          resolution_confidence,
          resolution_method,
          metadata,
          merged_into_entity_id,
          created_at,
          updated_at
        FROM canonical_entities
        WHERE id = ${entityId}::uuid
          AND status = 'active'
          AND (
            identity_scope = 'global_public'
            OR tenant_id = ${tenantId}::uuid
          )
        LIMIT 1
      `;
      const entity = rows[0];
      if (!entity) {
        throw new NotFoundException(
          'Canonical entity is not visible to this tenant.',
        );
      }

      for (const alias of input.aliases ?? []) {
        await insertAlias(tx, entity.id, tenantId, 'tenant_private', alias);
      }
      for (const identifier of input.identifiers ?? []) {
        await insertIdentifier(
          tx,
          entity.id,
          tenantId,
          'tenant_private',
          identifier,
        );
        await assertIdentifierOwner(
          tx,
          entity.id,
          tenantId,
          'tenant_private',
          identifier,
        );
      }

      return mapEntity(entity);
    });
  }

  private async loadGlobalEntity(
    tx: Prisma.TransactionClient,
    entityId: string,
  ): Promise<CanonicalEntityRow> {
    const rows = await tx.$queryRaw<CanonicalEntityRow[]>`
      SELECT
        id,
        tenant_id,
        identity_scope,
        entity_type,
        canonical_name,
        normalized_name,
        status,
        resolution_confidence,
        resolution_method,
        metadata,
        merged_into_entity_id,
        created_at,
        updated_at
      FROM canonical_entities
      WHERE id = ${entityId}::uuid
        AND identity_scope = 'global_public'
        AND tenant_id IS NULL
        AND status = 'active'
      LIMIT 1
    `;
    const entity = rows[0];
    if (!entity) {
      throw new NotFoundException('Global canonical entity not found.');
    }
    return entity;
  }

  private async appendGlobalIdentityLinks(
    tx: Prisma.TransactionClient,
    entityId: string,
    aliases: readonly EntityAliasInput[],
    identifiers: readonly EntityIdentifierRegistrationInput[],
  ): Promise<void> {
    for (const alias of aliases) {
      await insertAlias(tx, entityId, null, 'global_public', alias);
    }
    for (const identifier of identifiers) {
      await insertIdentifier(
        tx,
        entityId,
        null,
        'global_public',
        identifier,
      );
      await assertIdentifierOwner(
        tx,
        entityId,
        null,
        'global_public',
        identifier,
      );
    }
  }
}

async function insertAlias(
  tx: Prisma.TransactionClient,
  entityId: string,
  tenantId: string | null,
  identityScope: 'global_public' | 'tenant_private',
  alias: EntityAliasInput,
): Promise<void> {
  const normalizedAlias = normalizeEntityText(alias.value);
  if (!normalizedAlias) return;

  await tx.$executeRaw`
    INSERT INTO entity_aliases (
      entity_id,
      tenant_id,
      identity_scope,
      alias,
      normalized_alias,
      source_type,
      source_id,
      confidence,
      verified_at,
      status
    )
    VALUES (
      ${entityId}::uuid,
      ${tenantId}::uuid,
      ${identityScope},
      ${alias.value.trim()},
      ${normalizedAlias},
      ${normalizeIdentifierType(alias.sourceType)},
      ${alias.sourceId ?? null},
      ${clampResolutionConfidence(alias.confidence, 1)},
      ${alias.verifiedAt ?? null},
      'active'
    )
    ON CONFLICT DO NOTHING
  `;
}

async function insertIdentifier(
  tx: Prisma.TransactionClient,
  entityId: string,
  tenantId: string | null,
  identityScope: 'global_public' | 'tenant_private',
  identifier: EntityIdentifierRegistrationInput,
): Promise<void> {
  const type = normalizeIdentifierType(identifier.type);
  const normalizedValue = normalizeEntityIdentifier(type, identifier.value);

  await tx.$executeRaw`
    INSERT INTO entity_identifiers (
      entity_id,
      tenant_id,
      identity_scope,
      identifier_type,
      identifier_value,
      normalized_value,
      source_type,
      source_id,
      confidence,
      verified_at,
      status
    )
    VALUES (
      ${entityId}::uuid,
      ${tenantId}::uuid,
      ${identityScope},
      ${type},
      ${identifier.value.trim()},
      ${normalizedValue},
      ${normalizeIdentifierType(identifier.sourceType)},
      ${identifier.sourceId ?? null},
      ${clampResolutionConfidence(identifier.confidence, 1)},
      ${identifier.verifiedAt ?? null},
      'active'
    )
    ON CONFLICT DO NOTHING
  `;
}

async function assertIdentifierOwner(
  tx: Prisma.TransactionClient,
  entityId: string,
  tenantId: string | null,
  identityScope: 'global_public' | 'tenant_private',
  identifier: EntityIdentifierRegistrationInput,
): Promise<void> {
  const type = normalizeIdentifierType(identifier.type);
  const normalizedValue = normalizeEntityIdentifier(type, identifier.value);
  const rows = await tx.$queryRaw<IdentifierOwnerRow[]>`
    SELECT entity_id
    FROM entity_identifiers
    WHERE identifier_type = ${type}
      AND normalized_value = ${normalizedValue}
      AND identity_scope = ${identityScope}
      AND status = 'active'
      AND (
        (${tenantId}::uuid IS NULL AND tenant_id IS NULL)
        OR tenant_id = ${tenantId}::uuid
      )
    LIMIT 1
  `;
  if (rows[0]?.entity_id !== entityId) {
    throw new ConflictException(
      `Identifier ${type}:${identifier.value.trim()} is already linked to another canonical entity.`,
    );
  }
}

function mapEntity(row: CanonicalEntityRow): CanonicalEntityRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    identityScope: row.identity_scope,
    entityType: row.entity_type,
    canonicalName: row.canonical_name,
    normalizedName: row.normalized_name,
    status: row.status,
    resolutionConfidence: Number(row.resolution_confidence),
    resolutionMethod: row.resolution_method,
    metadata: asObject(row.metadata),
    mergedIntoEntityId: row.merged_into_entity_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
