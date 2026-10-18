import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';
import { governedRecallEligibilitySql } from './memory-recall-suppression.helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MICROSECOND = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/;

interface OwnerItemRow {
  id: string;
  title: string;
  clientId: string | null;
  sections: unknown;
  updatedAt: string;
}

export interface OwnerMemoryItem {
  id: string;
  title: string;
  value: string;
  scope: 'user_private';
  clientId: string | null;
  /** Exact PostgreSQL UTC microsecond token for a subsequent correction pin. */
  updatedAt: string;
}

export interface OwnerMemoryItemsPage {
  schemaVersion: 1;
  items: OwnerMemoryItem[];
  nextCursor: string | null;
}

interface Cursor {
  updatedAt: string;
  id: string;
}

/**
 * A small, personal-only picker for the immutable correction route. The current
 * ownership, scope, client-wall, lifecycle, legal-hold, and controlling-version
 * predicates run before LIMIT; a filtered row can never consume a page slot. It is not a
 * second memory store and grants no authority to correct a row: the version
 * service locks and authorizes the exact item again on POST.
 */
@Injectable()
export class MemoryOwnerItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    ctx: TenantContext,
    input: { cursor?: unknown; limit?: unknown; visibleClientIds?: readonly string[] } = {},
  ): Promise<OwnerMemoryItemsPage> {
    const limit = parseLimit(input.limit);
    const cursor = decodeCursor(input.cursor, cursorBinding(ctx));
    if (!governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE)) {
      throw new ServiceUnavailableException('Governed memory owner items are unavailable.');
    }
    const previewRoster = input.visibleClientIds === undefined ? null : JSON.stringify(input.visibleClientIds);

    const rows = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.$queryRaw<OwnerItemRow[]>(Prisma.sql`
        SELECT mi.id::text AS id, mi.title, mi.client_id::text AS "clientId",
               mi.sections_jsonb AS sections,
               to_char(mi.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
        FROM memory_items mi
        LEFT JOIN clients c ON c.tenant_id = mi.tenant_id AND c.id = mi.client_id
        WHERE mi.tenant_id = ${ctx.tenantId}::uuid
          AND mi.owner_user_id = ${ctx.userId}::uuid
          AND mi.memory_scope = 'user_private'
          AND mi.visibility = 'user'
          AND (${previewRoster}::jsonb IS NULL OR mi.client_id IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${previewRoster}::jsonb) AS preview_client(id)
            WHERE preview_client.id = mi.client_id::text
          ))
          AND (
            mi.client_id IS NULL OR (
              c.id IS NOT NULL AND c.status::text = 'active'
              AND (NOT c.memory_wall OR EXISTS (
                SELECT 1 FROM client_memory_access wall_grant
                WHERE wall_grant.tenant_id = c.tenant_id
                  AND wall_grant.client_id = c.id
                  AND wall_grant.user_id = ${ctx.userId}::uuid
              ))
            )
          )
          AND mi.legal_hold IS FALSE
          AND (mi.controlling_item_id IS NULL OR mi.controlling_item_id = mi.id)
          AND ${Prisma.raw(governedRecallEligibilitySql('mi'))}
          ${
            cursor
              ? Prisma.sql`AND (mi.updated_at, mi.id) < (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)`
              : Prisma.empty
          }
        ORDER BY mi.updated_at DESC, mi.id DESC
        LIMIT ${limit + 1}
      `),
    );

    const visible = rows.slice(0, limit);
    const items = visible.map((row): OwnerMemoryItem => ({
      id: row.id,
      title: row.title,
      value: sectionsText(row.sections),
      scope: 'user_private',
      clientId: row.clientId,
      updatedAt: row.updatedAt,
    }));
    const last = visible.at(-1);
    return {
      schemaVersion: 1,
      items,
      nextCursor: rows.length > limit && last ? encodeCursor(last, cursorBinding(ctx)) : null,
    };
  }
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return 25;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new BadRequestException('limit must be an integer from 1 to 100.');
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new BadRequestException('limit must be an integer from 1 to 100.');
  }
  return value;
}

function cursorBinding(ctx: Pick<TenantContext, 'tenantId' | 'userId'>): string {
  return createHash('sha256').update(`${ctx.tenantId}:${ctx.userId}`).digest('hex');
}

function encodeCursor(row: Cursor, binding: string): string {
  return Buffer.from(
    JSON.stringify({ v: 1, updatedAt: row.updatedAt, id: row.id, binding }),
  ).toString('base64url');
}

function decodeCursor(raw: unknown, binding: string): Cursor | null {
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== 'string' ||
    raw.length < 1 ||
    raw.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) {
    throw new BadRequestException('cursor is invalid.');
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('cursor object');
    const cursor = value as Record<string, unknown>;
    if (
      cursor.v !== 1 ||
      cursor.binding !== binding ||
      typeof cursor.id !== 'string' ||
      !UUID.test(cursor.id) ||
      typeof cursor.updatedAt !== 'string' ||
      !validMicrosecondUtc(cursor.updatedAt)
    )
      throw new Error('cursor fields');
    return { updatedAt: cursor.updatedAt, id: cursor.id };
  } catch {
    throw new BadRequestException('cursor is invalid.');
  }
}

function validMicrosecondUtc(value: string): boolean {
  const match = UTC_MICROSECOND.exec(value);
  if (!match) return false;
  const milliseconds = `${match[1]}.${match[2]?.slice(0, 3)}Z`;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds;
}

function sectionsText(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new ServiceUnavailableException('Memory item content is unavailable.');
  }
  const bodies = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ServiceUnavailableException('Memory item content is unavailable.');
    }
    const body = (entry as Record<string, unknown>).body;
    if (typeof body !== 'string') {
      throw new ServiceUnavailableException('Memory item content is unavailable.');
    }
    return body.trim();
  });
  return bodies.filter(Boolean).join('\n\n');
}
