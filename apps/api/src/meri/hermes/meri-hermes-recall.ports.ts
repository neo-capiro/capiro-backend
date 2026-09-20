/**
 * Institutional-memory recall ports for the Hermes broker.
 *
 * Institutional memory stays AUTHORITATIVE in Meri. The Hermes memory provider
 * plugin never reads the database; it calls the broker, which re-enters Meri's
 * own governed recall on the actor's behalf. Two implementations:
 *
 *  - `ContextPlaneRecallPort` — production path. Re-uses the exact canonical
 *    boundary `search_memory` uses today (`searchCapiroData` →
 *    `MeriContextPlaneService.searchToolData` → institutional_knowledge rail),
 *    so ethical-wall, visibility, governed-status and coverage semantics are
 *    inherited, not re-implemented.
 *  - `DirectMemoryItemsRecallPort` — Phase 0 HARNESS path for the standalone
 *    broker server (no Context Plane module loaded). Runs the same authorization
 *    predicates the memory store applies (withTenantUser RLS GUCs, owner
 *    visibility, ethical wall, governed suppression, expiry) with a plain
 *    text filter. It is labelled `direct_memory_items_prototype` in every
 *    result so evidence can never be mistaken for the production path.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { fetchDeniedClientIds, wallExclusionSql } from '../../memory/memory-wall.helpers.js';
import {
  governedRecallSuppressionEnabled,
  governedRecallSuppressionSql,
} from '../../memory/memory-recall-suppression.helpers.js';
import { MeriContextPlaneService } from '../meri-context-plane.service.js';
import { searchCapiroData } from '../meri-data-search.helpers.js';

export const MERI_HERMES_RECALL_PORT = Symbol('MERI_HERMES_RECALL_PORT');

export interface MeriHermesRecallInput {
  query: string;
  clientId?: string | null;
  limit: number;
  /** Server-derived run-envelope ceiling; every recall implementation must enforce it. */
  authorizedClientIds: string[];
}

export interface MeriHermesRecallItem {
  sourceId: string;
  domain: string;
  title: string;
  scope: 'personal' | 'client' | 'firm' | 'unknown';
  clientId: string | null;
  excerpt: string;
  updatedAt: string | null;
  provenance: Record<string, unknown> | null;
}

export interface MeriHermesRecallResult {
  path: 'context_plane' | 'direct_memory_items_prototype';
  items: MeriHermesRecallItem[];
  coverage: {
    requested: number;
    returned: number;
    total: number | null;
    sourceStatus: string;
    complete: boolean;
    detail: string | null;
  };
}

export interface MeriHermesRecallPort {
  recall(ctx: TenantContext, input: MeriHermesRecallInput): Promise<MeriHermesRecallResult>;
}

function excerptOf(value: unknown, max = 600): string {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function scopeOf(value: unknown): MeriHermesRecallItem['scope'] {
  return value === 'personal' || value === 'client' || value === 'firm' ? value : 'unknown';
}

@Injectable()
export class ContextPlaneRecallPort implements MeriHermesRecallPort {
  constructor(private readonly contextPlane: MeriContextPlaneService) {}

  async recall(ctx: TenantContext, input: MeriHermesRecallInput): Promise<MeriHermesRecallResult> {
    const authorized = new Set(input.authorizedClientIds);
    if (input.clientId && !authorized.has(input.clientId)) {
      // Match the controller/broker ownership precedent: do not reveal whether
      // a client exists when it is outside this run's frozen authorization.
      throw new NotFoundException('Client not found');
    }
    const result = (await searchCapiroData(
      ctx,
      {
        query: input.query,
        domains: ['institutional_knowledge'],
        pageSize: Math.max(1, Math.min(100, input.limit)),
        ...(input.clientId ? { clientId: input.clientId } : {}),
      },
      this.contextPlane,
    )) as {
      records?: Array<{
        domain: string;
        recordId: string;
        payload: Record<string, unknown>;
        provenance?: Record<string, unknown>;
        updatedAt?: Date | null;
      }>;
      coverage?: {
        recordsReturned?: number;
        recordsEvaluated?: number;
        complete?: boolean;
        sources?: Array<{ sourceStatus?: string; total?: number; stopReason?: string }>;
      };
    };
    const records = (result.records ?? []).filter((record) => {
      const clientId = record.payload.clientId;
      if (typeof clientId === 'string') return authorized.has(clientId);
      // A malformed client-scoped record is not safe to reinterpret as firm
      // scope merely because its client id is missing or has the wrong type.
      return clientId == null && record.payload.scope !== 'client';
    });
    const source = result.coverage?.sources?.[0];
    return {
      path: 'context_plane',
      items: records.map((record) => ({
        sourceId: record.recordId,
        domain: record.domain,
        title: String(record.payload.key ?? record.payload.title ?? record.recordId),
        scope: scopeOf(record.payload.scope),
        clientId: typeof record.payload.clientId === 'string' ? record.payload.clientId : null,
        excerpt: excerptOf(record.payload.value ?? record.payload.sections),
        updatedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : null,
        provenance: record.provenance ?? null,
      })),
      coverage: {
        requested: input.limit,
        returned: records.length,
        // Context Plane's total may include rows removed by the envelope. Only
        // expose a scoped total when its source scan was complete.
        total: result.coverage?.complete === true ? records.length : null,
        sourceStatus: source?.sourceStatus ?? 'unknown',
        complete: result.coverage?.complete === true,
        detail: source?.stopReason ?? null,
      },
    };
  }
}

interface MemoryItemRow {
  id: string;
  type: string;
  slug: string;
  title: string;
  visibility: string;
  owner_user_id: string | null;
  client_id: string | null;
  sections_jsonb: unknown;
  source: string;
  source_ref: string | null;
  updated_at: Date;
  total: bigint | number;
}

@Injectable()
export class DirectMemoryItemsRecallPort implements MeriHermesRecallPort {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async recall(ctx: TenantContext, input: MeriHermesRecallInput): Promise<MeriHermesRecallResult> {
    const limit = Math.max(1, Math.min(50, input.limit));
    const like = `%${input.query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const authorized = input.authorizedClientIds;
    if (input.clientId && !authorized.includes(input.clientId)) {
      // Same fail-closed shape as the Context Plane: an unauthorized client is "not found".
      return {
        path: 'direct_memory_items_prototype',
        items: [],
        coverage: { requested: limit, returned: 0, total: 0, sourceStatus: 'unauthorized', complete: false, detail: 'client_not_authorized' },
      };
    }
    const rows = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      return tx.$queryRaw<MemoryItemRow[]>`
        SELECT id::text AS id, type, slug, title, visibility, owner_user_id::text AS owner_user_id,
               client_id::text AS client_id, sections_jsonb, source, source_ref, updated_at,
               count(*) OVER () AS total
        FROM memory_items
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND (visibility = 'tenant' OR owner_user_id = ${ctx.userId}::uuid)
          AND status != 'revoked'
          AND (expires_at IS NULL OR expires_at > now())
          AND (client_id IS NULL OR client_id = ANY(${authorized}::uuid[]))
          ${input.clientId ? Prisma.sql`AND client_id = ${input.clientId}::uuid` : Prisma.empty}
          ${Prisma.raw(wallExclusionSql(denied, 'client_id'))}
          ${Prisma.raw(governedRecallSuppressionSql(governedRecallSuppressionEnabled()))}
          AND (title ILIKE ${like} OR slug ILIKE ${like} OR sections_jsonb::text ILIKE ${like})
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    });
    const total = rows.length ? Number(rows[0]!.total) : 0;
    return {
      path: 'direct_memory_items_prototype',
      items: rows.map((row) => ({
        sourceId: row.id,
        domain: 'institutional_knowledge',
        title: row.title,
        scope: row.owner_user_id ? 'personal' : row.client_id ? 'client' : 'firm',
        clientId: row.client_id,
        excerpt: excerptOf(row.sections_jsonb),
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        provenance: { source: row.source, sourceRef: row.source_ref, type: row.type, slug: row.slug },
      })),
      coverage: {
        requested: limit,
        returned: rows.length,
        total,
        sourceStatus: 'healthy',
        complete: rows.length >= total,
        detail: 'ilike_text_filter_prototype',
      },
    };
  }
}
