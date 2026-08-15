import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  AppendResolutionInput,
  CanonicalEntityRecord,
  EntityResolutionCandidate,
  EntityResolutionProvenance,
  EntityResolutionRecord,
  NormalizedResolveEntityInput,
  RegisterTenantPrivateEntityInput,
} from './entity-resolution.types.js';
import {
  clampResolutionConfidence,
  normalizeEntityIdentifier,
  normalizeEntityText,
  normalizeEntityType,
  normalizeIdentifierType,
} from './entity-normalization.js';

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

interface CandidateRow extends CanonicalEntityRow {
  match_confidence: Prisma.Decimal | number | string;
  match_method: 'identifier_exact' | 'canonical_name_exact' | 'alias_exact';
  match_source_type: string | null;
  match_source_id: string | null;
  match_identifier_type: string | null;
  match_value: string | null;
}

interface EntityResolutionRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  actor_user_id: string | null;
  raw_input: string;
  normalized_input: string;
  entity_type_hint: string | null;
  candidate_entity_ids: unknown;
  selected_entity_id: string | null;
  status: EntityResolutionRecord['status'];
  confidence: Prisma.Decimal | number | string;
  resolution_method: string;
  provenance: unknown;
  correction_of_resolution_id: string | null;
  created_at: Date;
}

/**
 * Tenant-aware persistence for the universal entity registry.
 *
 * Global public identities are readable by every tenant, but ordinary writes
 * create only tenant-private identity records. The runtime DB role can bypass
 * PostgreSQL RLS, so every raw query repeats visibility and tenant predicates.
 * Resolution decisions are append-only.
 */
@Injectable()
export class CanonicalEntityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findExactCandidates(
    tenantId: string,
    input: NormalizedResolveEntityInput,
  ): Promise<EntityResolutionCandidate[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const identifierRows =
        input.identifiers.length === 0
          ? []
          : await tx.$queryRaw<CandidateRow[]>`
              WITH requested AS (
                SELECT identifier_type, normalized_value
                FROM jsonb_to_recordset(
                  CAST(${JSON.stringify(input.identifiers.map((item) => ({ identifier_type: item.type, normalized_value: item.normalizedValue })))} AS jsonb)
                ) AS item(identifier_type text, normalized_value text)
              )
              SELECT
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
                entity.updated_at,
                identifier.confidence AS match_confidence,
                'identifier_exact'::text AS match_method,
                identifier.source_type AS match_source_type,
                identifier.source_id AS match_source_id,
                identifier.identifier_type AS match_identifier_type,
                identifier.identifier_value AS match_value
              FROM requested
              JOIN entity_identifiers AS identifier
                ON identifier.identifier_type = requested.identifier_type
               AND identifier.normalized_value = requested.normalized_value
               AND identifier.status = 'active'
               AND (
                 identifier.identity_scope = 'global_public'
                 OR identifier.tenant_id = ${tenantId}::uuid
               )
              JOIN canonical_entities AS entity
                ON entity.id = identifier.entity_id
               AND entity.status = 'active'
               AND (
                 entity.identity_scope = 'global_public'
                 OR entity.tenant_id = ${tenantId}::uuid
               )
              WHERE (
                ${input.entityTypeHint}::text IS NULL
                OR entity.entity_type = ${input.entityTypeHint}
              )
              ORDER BY identifier.confidence DESC, entity.id
              LIMIT ${input.maxCandidates}
            `;

      const nameRows = input.normalizedInput
        ? await tx.$queryRaw<CandidateRow[]>`
            WITH name_matches AS (
              SELECT
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
                entity.updated_at,
                CASE
                  WHEN entity.normalized_name = ${input.normalizedInput} THEN 0.9800
                  ELSE GREATEST(0.0000, LEAST(1.0000, alias.confidence * 0.9500))
                END AS match_confidence,
                CASE
                  WHEN entity.normalized_name = ${input.normalizedInput}
                    THEN 'canonical_name_exact'::text
                  ELSE 'alias_exact'::text
                END AS match_method,
                CASE
                  WHEN entity.normalized_name = ${input.normalizedInput}
                    THEN 'canonical_entity'
                  ELSE alias.source_type
                END AS match_source_type,
                CASE
                  WHEN entity.normalized_name = ${input.normalizedInput}
                    THEN entity.id::text
                  ELSE alias.source_id
                END AS match_source_id,
                NULL::text AS match_identifier_type,
                CASE
                  WHEN entity.normalized_name = ${input.normalizedInput}
                    THEN entity.canonical_name
                  ELSE alias.alias
                END AS match_value
              FROM canonical_entities AS entity
              LEFT JOIN entity_aliases AS alias
                ON alias.entity_id = entity.id
               AND alias.status = 'active'
               AND (
                 alias.identity_scope = 'global_public'
                 OR alias.tenant_id = ${tenantId}::uuid
               )
              WHERE entity.status = 'active'
                AND (
                  entity.identity_scope = 'global_public'
                  OR entity.tenant_id = ${tenantId}::uuid
                )
                AND (
                  ${input.entityTypeHint}::text IS NULL
                  OR entity.entity_type = ${input.entityTypeHint}
                )
                AND (
                  entity.normalized_name = ${input.normalizedInput}
                  OR alias.normalized_alias = ${input.normalizedInput}
                )
            )
            SELECT *
            FROM (
              SELECT DISTINCT ON (id) *
              FROM name_matches
              ORDER BY id, match_confidence DESC, match_method
            ) AS deduplicated
            ORDER BY match_confidence DESC, canonical_name, id
            LIMIT ${input.maxCandidates}
          `
        : [];

      const candidates = new Map<string, EntityResolutionCandidate>();
      for (const row of [...identifierRows, ...nameRows]) {
        const candidate = mapCandidate(row);
        const existing = candidates.get(candidate.entity.id);
        if (!existing) {
          candidates.set(candidate.entity.id, candidate);
          continue;
        }
        existing.reasons.push(...candidate.reasons);
        existing.provenance.push(...candidate.provenance);
        if (candidate.confidence > existing.confidence) {
          existing.confidence = candidate.confidence;
          existing.resolutionMethod = candidate.resolutionMethod;
        }
      }

      return [...candidates.values()]
        .sort(
          (left, right) =>
            right.confidence - left.confidence ||
            left.entity.canonicalName.localeCompare(right.entity.canonicalName),
        )
        .slice(0, input.maxCandidates);
    });
  }

  async findVisibleById(
    tenantId: string,
    entityId: string,
  ): Promise<CanonicalEntityRecord | null> {
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
      return rows[0] ? mapEntity(rows[0]) : null;
    });
  }

  async createTenantPrivateEntity(
    tenantId: string,
    input: RegisterTenantPrivateEntityInput,
  ): Promise<CanonicalEntityRecord> {
    return this.prisma.withTenant(tenantId, async (tx) => {
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
          ${tenantId}::uuid,
          'tenant_private',
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
        throw new InternalServerErrorException('Canonical entity insert did not return a row.');
      }

      for (const alias of input.aliases ?? []) {
        const normalizedAlias = normalizeEntityText(alias.value);
        if (!normalizedAlias) continue;
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
            ${entity.id}::uuid,
            ${tenantId}::uuid,
            'tenant_private',
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

      for (const identifier of input.identifiers ?? []) {
        const identifierType = normalizeIdentifierType(identifier.type);
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
            ${entity.id}::uuid,
            ${tenantId}::uuid,
            'tenant_private',
            ${identifierType},
            ${identifier.value.trim()},
            ${normalizeEntityIdentifier(identifierType, identifier.value)},
            ${normalizeIdentifierType(identifier.sourceType)},
            ${identifier.sourceId ?? null},
            ${clampResolutionConfidence(identifier.confidence, 1)},
            ${identifier.verifiedAt ?? null},
            'active'
          )
        `;
      }

      return mapEntity(entity);
    });
  }

  async appendResolution(
    tenantId: string,
    input: AppendResolutionInput,
  ): Promise<EntityResolutionRecord> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const inserted = await tx.$queryRaw<EntityResolutionRow[]>`
        INSERT INTO entity_resolutions (
          tenant_id,
          idempotency_key,
          actor_user_id,
          raw_input,
          normalized_input,
          entity_type_hint,
          candidate_entity_ids,
          selected_entity_id,
          status,
          confidence,
          resolution_method,
          provenance,
          correction_of_resolution_id
        )
        VALUES (
          ${tenantId}::uuid,
          ${input.idempotencyKey},
          ${input.actorUserId}::uuid,
          ${input.rawInput},
          ${input.normalizedInput},
          ${input.entityTypeHint},
          CAST(${JSON.stringify(input.candidateEntityIds)} AS jsonb),
          ${input.selectedEntityId}::uuid,
          ${input.status},
          ${input.confidence},
          ${input.resolutionMethod},
          CAST(${JSON.stringify(input.provenance)} AS jsonb),
          ${input.correctionOfResolutionId}::uuid
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING
          id,
          tenant_id,
          idempotency_key,
          actor_user_id,
          raw_input,
          normalized_input,
          entity_type_hint,
          candidate_entity_ids,
          selected_entity_id,
          status,
          confidence,
          resolution_method,
          provenance,
          correction_of_resolution_id,
          created_at
      `;
      if (inserted[0]) return mapResolution(inserted[0]);

      const existing = await tx.$queryRaw<EntityResolutionRow[]>`
        SELECT
          id,
          tenant_id,
          idempotency_key,
          actor_user_id,
          raw_input,
          normalized_input,
          entity_type_hint,
          candidate_entity_ids,
          selected_entity_id,
          status,
          confidence,
          resolution_method,
          provenance,
          correction_of_resolution_id,
          created_at
        FROM entity_resolutions
        WHERE tenant_id = ${tenantId}::uuid
          AND idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new InternalServerErrorException('Entity resolution append did not return a row.');
      }
      return mapResolution(existing[0]);
    });
  }

  async findResolutionById(
    tenantId: string,
    resolutionId: string,
  ): Promise<EntityResolutionRecord | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<EntityResolutionRow[]>`
        SELECT
          id,
          tenant_id,
          idempotency_key,
          actor_user_id,
          raw_input,
          normalized_input,
          entity_type_hint,
          candidate_entity_ids,
          selected_entity_id,
          status,
          confidence,
          resolution_method,
          provenance,
          correction_of_resolution_id,
          created_at
        FROM entity_resolutions
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${resolutionId}::uuid
        LIMIT 1
      `;
      return rows[0] ? mapResolution(rows[0]) : null;
    });
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

function mapCandidate(row: CandidateRow): EntityResolutionCandidate {
  const provenance: EntityResolutionProvenance = {
    sourceType: row.match_source_type ?? 'canonical_entity',
    sourceId: row.match_source_id,
    identifierType: row.match_identifier_type,
    matchValue: row.match_value,
  };
  return {
    entity: mapEntity(row),
    confidence: Number(row.match_confidence),
    resolutionMethod: row.match_method,
    reasons: [
      row.match_method === 'identifier_exact'
        ? `Exact ${row.match_identifier_type ?? 'identifier'} match`
        : row.match_method === 'canonical_name_exact'
          ? 'Exact canonical name match'
          : 'Exact alias match',
    ],
    provenance: [provenance],
  };
}

function mapResolution(row: EntityResolutionRow): EntityResolutionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    rawInput: row.raw_input,
    normalizedInput: row.normalized_input,
    entityTypeHint: row.entity_type_hint,
    candidateEntityIds: asStringArray(row.candidate_entity_ids),
    selectedEntityId: row.selected_entity_id,
    status: row.status,
    confidence: Number(row.confidence),
    resolutionMethod: row.resolution_method,
    provenance: asProvenance(row.provenance),
    correctionOfResolutionId: row.correction_of_resolution_id,
    createdAt: row.created_at,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asProvenance(value: unknown): EntityResolutionProvenance[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is EntityResolutionProvenance =>
      Boolean(item && typeof item === 'object' && typeof (item as { sourceType?: unknown }).sourceType === 'string'),
  );
}
