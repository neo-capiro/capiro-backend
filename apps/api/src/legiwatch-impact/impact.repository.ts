import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  congressGovBillUrl,
  humanizeBillId,
  type LegiWatchImpactAnalysis,
  type LegiWatchTrackerRow,
  type TenantContext,
} from '@capiro/shared';
import { requireOwnerActor, requireOwnerClient } from '../clients/client-ordered-owner.access.js';
import type { ImpactContextDto, ImpactTrackerQuery } from './impact.dto.js';

export type TrackerBackend = 'core' | 'intelligence';
/** Private retention only; currentImpact removes this before any response. */
export type StoredImpactAnalysis = LegiWatchImpactAnalysis & {
  lastValidAnalysis?: LegiWatchImpactAnalysis;
};
export interface ImpactStoredRow extends Omit<
  LegiWatchTrackerRow,
  'impact' | 'displayNum' | 'stage' | 'passageProbability'
> {
  analysis: StoredImpactAnalysis | null;
  /** PostgreSQL microsecond precision, retained only for keyset pagination. */
  trackedAtExact: string;
}
type Cursor = {
  t: string;
  c: string;
  b: string;
  backend: TrackerBackend;
  clientId: string | null;
  q: string;
};
const WALL = `(NOT c.memory_wall OR EXISTS (SELECT 1 FROM client_memory_access a
  WHERE a.tenant_id=c.tenant_id AND a.client_id=c.id AND a.user_id=$2::uuid))`;
const CORE_TRACKED = `SELECT tenant_id::text,client_id::text,bill_id,created_at AS tracked_at,note,
  NULL::text AS position,NULL::text AS priority FROM tracked_bill WHERE tenant_id=$1::uuid`;
const INTEL_TRACKED = `SELECT tenant_id,client_id,bill_id,tracked_at,coalesce(analyst_note,note) AS note,
  position,priority FROM intel_tracked_bill WHERE tenant_id=$1`;

export function emptyImpact(
  reason = 'Analyze the current bill text against this client’s evidence.',
): LegiWatchImpactAnalysis {
  return {
    status: 'needs_evidence',
    summary: reason,
    direction: 'uncertain',
    confidence: 'low',
    findings: [],
    missingFacts: [],
    analyzedAt: null,
    inputFingerprint: null,
    stale: false,
    staleReason: null,
    model: null,
  };
}

export function presentImpactRow(
  row: ImpactStoredRow,
  impact: LegiWatchImpactAnalysis,
): LegiWatchTrackerRow {
  const { analysis: _analysis, trackedAtExact: _trackedAtExact, ...rest } = row;
  const status = row.status;
  const stage =
    status === 'enacted'
      ? 'enacted'
      : ['passed_chamber', 'resolving', 'to_president', 'passed'].includes(status ?? '')
        ? 'passed'
        : ['committee', 'reported', 'rule_pending', 'rule_failed', 'floor'].includes(status ?? '')
          ? 'committee'
          : status === 'introduced'
            ? 'introduced'
            : null;
  return {
    ...rest,
    sourceUrl: congressGovBillUrl(row.billId) ?? safeSourceUrl(rest.sourceUrl),
    displayNum: /^\d+-/.test(row.billId)
      ? humanizeBillId(row.billId)
      : (row.billId.split('-').at(-1)?.toUpperCase() ?? row.billId),
    stage,
    passageProbability: null,
    impact,
  };
}

export function safeSourceUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function decodeCursor(
  raw: string | undefined,
  backend: TrackerBackend,
  query: ImpactTrackerQuery,
): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (
      typeof c.t !== 'string' ||
      !Number.isFinite(Date.parse(c.t)) ||
      typeof c.c !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(c.c) ||
      typeof c.b !== 'string' ||
      c.b.length > 160 ||
      c.backend !== backend ||
      c.clientId !== (query.clientId ?? null) ||
      c.q !== (query.q?.trim() ?? '')
    )
      throw Error();
    return c;
  } catch {
    throw new BadRequestException('Invalid tracker cursor');
  }
}

@Injectable()
export class ImpactRepository {
  async authorize(tx: Prisma.TransactionClient, ctx: TenantContext, clientId?: string) {
    if (clientId) await requireOwnerClient(tx, ctx, clientId, false, false, 'share');
    else await requireOwnerActor(tx, ctx, false, true);
  }

  async backend(tx: Prisma.TransactionClient, ctx: TenantContext): Promise<TrackerBackend> {
    const tables = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(
      `SELECT to_regclass('public.intel_feature_flag') IS NOT NULL AND to_regclass('public.intel_tracked_bill') IS NOT NULL AS present`,
    );
    if (!tables[0]?.present) return 'core';
    const flags = await tx.$queryRawUnsafe<Array<{ enabled: boolean }>>(
      `SELECT enabled FROM intel_feature_flag WHERE tenant_id=$1 AND feature='tracker_owner_intel'`,
      ctx.tenantId,
    );
    return (flags[0]?.enabled ?? process.env.CAPIRO_INTERNAL_TENANT_ID === ctx.tenantId)
      ? 'intelligence'
      : 'core';
  }

  private source(backend: TrackerBackend) {
    return backend === 'intelligence' ? INTEL_TRACKED : CORE_TRACKED;
  }

  private select(backend: TrackerBackend) {
    return `SELECT c.id::text AS "clientId",c.name AS "clientName",t.bill_id AS "billId",
      coalesce(b.title,s.title,t.bill_id) AS title,coalesce(s.state,'US') AS jurisdiction,
      coalesce(b.status,s.status) AS status,coalesce(b.latest_action_text,s.latest_action_text) AS "latestActionText",
      coalesce(b.latest_action_date,s.latest_action_date)::text AS "latestActionDate",
      coalesce(b.url,s.state_url,s.url) AS "sourceUrl",t.tracked_at AS "trackedAt",t.tracked_at::text AS "trackedAtExact",
      t.note AS note,
      ${backend === 'core' ? 'i.position' : 't.position'} AS position,
      ${backend === 'core' ? 'i.priority' : 't.priority'} AS priority,
      '${backend}'::text AS "trackerBackend",i.analysis_jsonb AS analysis
      FROM tracked t JOIN clients c ON c.id::text=t.client_id AND c.tenant_id=$1::uuid
      LEFT JOIN congress_bill b ON b.id=t.bill_id LEFT JOIN state_bill s ON s.id=t.bill_id
      LEFT JOIN legiwatch_client_bill_analysis i ON i.tenant_id=c.tenant_id AND i.client_id=c.id AND i.bill_id=t.bill_id
      WHERE c.status<>'archived' AND ${WALL}`;
  }

  async list(tx: Prisma.TransactionClient, ctx: TenantContext, query: ImpactTrackerQuery) {
    await this.authorize(tx, ctx, query.clientId);
    const backend = await this.backend(tx, ctx),
      cursor = decodeCursor(query.cursor, backend, query);
    const limit = query.limit ?? 25;
    // Stabilize grants before enumerating names, counts or rows. Revocation
    // and wall changes then serialize with this read's current authority.
    await tx.$queryRawUnsafe(
      `SELECT user_id FROM client_memory_access WHERE tenant_id=$1::uuid AND user_id=$2::uuid FOR SHARE`,
      ctx.tenantId,
      ctx.userId,
    );
    const clients = await tx.$queryRawUnsafe<Array<{ id: string; name: string }>>(
      `SELECT c.id::text,c.name FROM clients c WHERE c.tenant_id=$1::uuid AND c.status<>'archived' AND ${WALL} ORDER BY c.name,c.id FOR SHARE OF c`,
      ctx.tenantId,
      ctx.userId,
    );
    const filter = ` AND ($3::uuid IS NULL OR c.id=$3::uuid)
      AND ($4='' OR strpos(lower(coalesce(b.title,s.title,'')||' '||t.bill_id||' '||c.name),lower($4))>0)`;
    const values = [ctx.tenantId, ctx.userId, query.clientId ?? null, query.q?.trim() ?? ''];
    const base = `WITH tracked AS (${this.source(backend)}) `;
    const rows = await tx.$queryRawUnsafe<ImpactStoredRow[]>(
      `${base}${this.select(backend)}${filter}
      AND ($5::timestamptz IS NULL OR (t.tracked_at,c.id::text,t.bill_id)<($5::timestamptz,$6,$7))
      ORDER BY t.tracked_at DESC,c.id::text DESC,t.bill_id DESC LIMIT $8`,
      ...values,
      cursor?.t ?? null,
      cursor?.c ?? null,
      cursor?.b ?? null,
      limit + 1,
    );
    const counts = await tx.$queryRawUnsafe<Array<{ count: string }>>(
      `${base}SELECT count(*)::text AS count FROM (${this.select(backend)}${filter}) allowed`,
      ...values,
    );
    const hasMore = rows.length > limit,
      page = rows.slice(0, limit),
      last = page.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              t: last.trackedAtExact,
              c: last.clientId,
              b: last.billId,
              backend,
              clientId: query.clientId ?? null,
              q: query.q?.trim() ?? '',
            } satisfies Cursor),
          ).toString('base64url')
        : null;
    return {
      trackerBackend: backend,
      rows: page.map((row) => ({ ...row, trackedAt: new Date(row.trackedAt).toISOString() })),
      total: Number(counts[0]?.count ?? 0),
      hasMore,
      nextCursor,
      clients,
    };
  }

  async row(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string, billId: string) {
    await this.authorize(tx, ctx, clientId);
    const backend = await this.backend(tx, ctx);
    const rows = await tx.$queryRawUnsafe<ImpactStoredRow[]>(
      `WITH tracked AS (${this.source(backend)})
      ${this.select(backend)} AND c.id=$3::uuid AND t.bill_id=$4`,
      ctx.tenantId,
      ctx.userId,
      clientId,
      billId,
    );
    if (!rows[0]) throw new NotFoundException('Tracked bill not found');
    return { ...rows[0], trackedAt: new Date(rows[0].trackedAt).toISOString() };
  }

  async actions(tx: Prisma.TransactionClient, billId: string) {
    return tx.$queryRawUnsafe<
      Array<{ date: string | null; text: string; sourceUrl: string | null }>
    >(
      `SELECT date::text AS date,text,NULL::text AS "sourceUrl" FROM congress_bill_action WHERE bill_id=$1
       UNION ALL SELECT date::text,text,NULL::text FROM state_bill_action WHERE bill_key=$1
       ORDER BY date DESC NULLS LAST LIMIT 100`,
      billId,
    );
  }

  async refresh(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    billId: string,
  ) {
    const rows = await tx.$queryRawUnsafe<
      Array<{
        state: 'queued' | 'running' | 'idle' | 'failed';
        requestedAt: Date | null;
        nextCheckAt: Date | null;
        errorCode: string | null;
      }>
    >(
      `SELECT state,requested_at AS "requestedAt",next_check_at AS "nextCheckAt",error_code AS "errorCode"
       FROM legiwatch_impact_refresh WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND bill_id=$3`,
      ctx.tenantId,
      clientId,
      billId,
    );
    const row = rows[0];
    return row
      ? {
          ...row,
          requestedAt: row.requestedAt ? new Date(row.requestedAt).toISOString() : null,
          nextCheckAt: row.nextCheckAt ? new Date(row.nextCheckAt).toISOString() : null,
        }
      : null;
  }

  async save(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    billId: string,
    analysis: LegiWatchImpactAnalysis,
  ) {
    const rows = await tx.$queryRawUnsafe<Array<{ analysis: StoredImpactAnalysis }>>(
      `INSERT INTO legiwatch_client_bill_analysis AS saved(tenant_id,client_id,bill_id,analysis_jsonb,analyzed_by,updated_at)
      VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid,now()) ON CONFLICT(tenant_id,client_id,bill_id)
      DO UPDATE SET analysis_jsonb=CASE
        WHEN saved.analysis_jsonb->>'status'='ready' AND saved.analysis_jsonb->>'inputFingerprint'=EXCLUDED.analysis_jsonb->>'inputFingerprint'
        THEN saved.analysis_jsonb
        WHEN EXCLUDED.analysis_jsonb->>'status'='ready' THEN EXCLUDED.analysis_jsonb
        WHEN saved.analysis_jsonb->>'status'='ready'
        THEN EXCLUDED.analysis_jsonb || jsonb_build_object('lastValidAnalysis',saved.analysis_jsonb-'lastValidAnalysis')
        WHEN jsonb_typeof(saved.analysis_jsonb->'lastValidAnalysis')='object'
        THEN EXCLUDED.analysis_jsonb || jsonb_build_object('lastValidAnalysis',saved.analysis_jsonb->'lastValidAnalysis')
        ELSE EXCLUDED.analysis_jsonb END,
        analyzed_by=CASE
        WHEN saved.analysis_jsonb->>'status'='ready' AND saved.analysis_jsonb->>'inputFingerprint'=EXCLUDED.analysis_jsonb->>'inputFingerprint'
        THEN saved.analyzed_by ELSE EXCLUDED.analyzed_by END,updated_at=now()
      RETURNING analysis_jsonb AS analysis`,
      ctx.tenantId,
      clientId,
      billId,
      JSON.stringify(analysis),
      ctx.userId,
    );
    return rows[0]!.analysis;
  }

  async updateContext(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    row: ImpactStoredRow,
    body: ImpactContextDto,
  ) {
    if (row.trackerBackend === 'intelligence') {
      await tx.$executeRawUnsafe(
        `UPDATE intel_tracked_bill SET position=CASE WHEN $4 THEN $5 ELSE position END,
        priority=CASE WHEN $6 THEN $7 ELSE priority END,analyst_note=CASE WHEN $8 THEN $9 ELSE analyst_note END,
        note=CASE WHEN $8 THEN $9 ELSE note END,updated_at=now()
        WHERE tenant_id=$1 AND client_id=$2 AND bill_id=$3`,
        ctx.tenantId,
        row.clientId,
        row.billId,
        body.position !== undefined,
        body.position ?? null,
        body.priority !== undefined,
        body.priority ?? null,
        body.analystNote !== undefined,
        body.analystNote ?? null,
      );
    } else {
      if (body.position !== undefined || body.priority !== undefined)
        await tx.$executeRawUnsafe(
          `INSERT INTO legiwatch_client_bill_analysis(tenant_id,client_id,bill_id,position,priority)
        VALUES($1::uuid,$2::uuid,$3,$5,$7) ON CONFLICT(tenant_id,client_id,bill_id) DO UPDATE
        SET position=CASE WHEN $4 THEN $5 ELSE legiwatch_client_bill_analysis.position END,
        priority=CASE WHEN $6 THEN $7 ELSE legiwatch_client_bill_analysis.priority END,updated_at=now()`,
          ctx.tenantId,
          row.clientId,
          row.billId,
          body.position !== undefined,
          body.position ?? null,
          body.priority !== undefined,
          body.priority ?? null,
        );
      if (body.analystNote !== undefined)
        await tx.$executeRawUnsafe(
          `UPDATE tracked_bill SET note=$4,updated_at=now() WHERE tenant_id=$1::uuid AND client_id=$2::uuid AND bill_id=$3`,
          ctx.tenantId,
          row.clientId,
          row.billId,
          body.analystNote,
        );
    }
  }
}
