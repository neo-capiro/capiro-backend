import { Prisma } from '@prisma/client';
import {
  filterGovernedMemory,
  MEMORY_CLASSES,
  type GovernedMemoryRecord,
} from '@capiro/meriv2-core';
import { governedRecallEligibilitySql } from '../../memory/memory-recall-suppression.helpers.js';

export interface CanonicalMemoryEligibilityInput {
  tenantId: string;
  userId: string;
  allowedClientIds: string[];
  memoryItemId?: string;
}

/** The canonical memory_items WHERE predicate used by governed retrieval. */
export function canonicalMemoryEligibilitySql({
  tenantId,
  userId,
  allowedClientIds,
  memoryItemId,
}: CanonicalMemoryEligibilityInput): Prisma.Sql {
  return Prisma.sql`
    mi.tenant_id = ${tenantId}::uuid
    AND (mi.visibility = 'tenant' OR mi.owner_user_id = ${userId}::uuid)
    AND mi.status = 'active'
    ${memoryItemId ? Prisma.sql`AND mi.id = ${memoryItemId}::uuid` : Prisma.empty}
    AND mi.memory_class IN ('institutional_authoritative', 'client_steering', 'user_preference', 'episodic_working')
    AND (mi.memory_scope <> 'user_private' OR mi.owner_user_id = ${userId}::uuid)
    AND (mi.memory_scope <> 'client' OR mi.client_id = ANY(${allowedClientIds}::uuid[]))
    AND (
      mi.memory_class NOT IN ('institutional_authoritative', 'client_steering')
      OR mi.approved_by_user_id IS NOT NULL
    )
    AND (
      mi.source_type <> 'unknown'
      OR mi.source_ref IS NOT NULL
      OR mi.source_id IS NOT NULL
    )
    AND (
      mi.memory_class <> 'episodic_working'
      OR mi.expires_at IS NOT NULL
      OR mi.valid_until IS NOT NULL
    )
    AND COALESCE(mi.sensitivity, 'normal') = 'normal'
    AND (mi.expires_at IS NULL OR mi.expires_at > now())
    AND (mi.valid_until IS NULL OR mi.valid_until > now())
    AND (mi.effective_from IS NULL OR mi.effective_from <= now())
    AND (mi.client_id IS NULL OR mi.client_id = ANY(${allowedClientIds}::uuid[]))
    AND ${Prisma.raw(governedRecallEligibilitySql('mi'))}
  `;
}

export interface CanonicalGovernedMemoryRow extends GovernedMemoryRecord {
  visibility: string;
  legacyStatus: string;
  clientId: string | null;
}

export interface CanonicalGovernedMemoryAccess {
  tenantId: string;
  userId: string;
  allowedClientIds: string[];
}

/** Mirrors the adapter's post-SQL defense-in-depth filter and its evaluation order. */
export function includeCanonicalGovernedMemoryRow(
  row: CanonicalGovernedMemoryRow,
  { tenantId, userId, allowedClientIds }: CanonicalGovernedMemoryAccess,
): boolean {
  return (
    MEMORY_CLASSES.includes(row.memoryClass) &&
    row.legacyStatus === 'active' &&
    (row.visibility === 'tenant' || row.ownerUserId === userId) &&
    (!row.clientId || allowedClientIds.includes(row.clientId)) &&
    (!row.effectiveFrom || new Date(row.effectiveFrom).getTime() <= Date.now()) &&
    filterGovernedMemory(row, {
      tenantId,
      userId,
      clientId: row.clientId,
      ethicalWallAllowed: !!row.clientId && allowedClientIds.includes(row.clientId),
    }).include
  );
}
