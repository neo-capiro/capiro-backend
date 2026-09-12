import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
/**
 * LegiWatch V2 Wave 3 — Digest (LEGIWATCH-V2-HANDOFF §5.8, §7 "digest
 * generation, history, scheduling and PDF" BACKEND REQUIRED item).
 *
 * Composes the brief from data that already exists — real `intel_alert` rows
 * (the same unified signal Feed reads; intel-api and apps/api share one
 * physical database, so this is a plain cross-schema join, the same pattern
 * `hearing-intelligence.worker.ts` already uses in the opposite direction),
 * real upcoming hearings, and real bill-stage movement. Nothing here is a
 * template with placeholder prose, and no digest is generated for external
 * send — §1.5 keeps that behind the Stage H security review; this module
 * only persists what "Generate now" produced so History can show it again.
 */
import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { bandForScore } from './legiwatch-wave1-relevance.js';

const SOURCE_FAMILY_LABEL: Record<string, string> = {
  bill: 'Congress.gov',
  hearing: 'Committee pages',
  combined: 'Congress.gov + Committee pages',
  state_bill: 'State legislatures',
  regulation: 'Federal Register',
  program_element: 'Program element service',
};

interface AlertRow {
  id: string;
  clientId: string;
  sourceType: string;
  severity: string;
  urgency: string | null;
  score: number;
  title: string;
  whyItMatters: string | null;
  recommendedAction: string | null;
  createdAt: Date;
}

export interface DigestContent {
  scopeLabel: string;
  generatedAt: string;
  clientsInScope: number;
  headline: string;
  whatChanged: Array<{
    id: string;
    title: string;
    band: string;
    sourceLabel: string;
    clientName: string | null;
    ageHours: number;
  }>;
  decisionsRequired: Array<{ id: string; title: string; recommendedAction: string | null }>;
  upcomingHearings: Array<{
    id: string;
    title: string;
    date: string;
    committeeName: string | null;
  }>;
  billMovement: Array<{
    id: string;
    display: string;
    status: string | null;
    statusAt: string | null;
  }>;
  clientImplications: Array<{ clientId: string; clientName: string; band: string }>;
  recommendedActions: string[];
  provenance: {
    sourceFamilies: string[];
    officialRecordCount: number;
    captureCount: number;
  };
}

@Injectable()
export class LegiWatchDigestService {
  constructor(private readonly prisma: PrismaService) {}

  /** Typed Digest adapter: report definitions, occurrences and immutable runs
   * remain owned by Intel. Forward the original credentials, never a tenant
   * supplied in a request body or a service-level authorization bypass. */
  async billReport(
    operation: 'generate' | 'history' | 'run' | 'subscriptions' | 'saveSubscription',
    authorization?: string,
    impersonation?: string,
    input?: unknown,
    id?: string,
  ) {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException();
    const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const reportId = typeof body.reportId === 'string' ? body.reportId : '';
    if ((operation === 'generate' && !reportId) || (operation === 'run' && !id))
      throw new BadRequestException('REPORT_ID_REQUIRED');
    const route =
      operation === 'generate'
        ? `/${encodeURIComponent(reportId)}/generate`
        : operation === 'run'
          ? `/runs/${encodeURIComponent(id!)}`
          : operation === 'history'
            ? '/history'
            : '/subscriptions';
    const response = await fetch(
      `${(process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai').replace(/\/+$/, '')}/intel-api/legiwatch/reports${route}`,
      {
        method: operation === 'generate' || operation === 'saveSubscription' ? 'POST' : 'GET',
        headers: {
          authorization,
          'content-type': 'application/json',
          ...(impersonation ? { 'x-capiro-impersonate-tenant': impersonation } : {}),
        },
        ...(operation === 'generate' || operation === 'saveSubscription'
          ? { body: JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => null);
      throw new HttpException(
        error && typeof error === 'object'
          ? (error as Record<string, unknown>)
          : 'BILL_REPORT_SERVICE_UNAVAILABLE',
        response.status,
      );
    }
    return { mode: 'bill_report' as const, data: (await response.json()) as unknown };
  }

  async generate(
    ctx: TenantContext,
    clientId: string | null,
  ): Promise<{ id: string } & DigestContent> {
    const windowStart = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // intel_alert.tenant_id/client_id are TEXT (intel-api's own tenant
      // convention), NOT uuid like apps/api's tables — no ::uuid cast here.
      const alertRows = clientId
        ? await tx.$queryRaw<AlertRow[]>`
            SELECT id, client_id AS "clientId", source_type AS "sourceType", severity, urgency, score, title,
                   why_it_matters AS "whyItMatters", recommended_action AS "recommendedAction", created_at AS "createdAt"
            FROM intel_alert
            WHERE status IN ('new', 'reviewed', 'sent') AND tenant_id = ${ctx.tenantId} AND created_at >= ${windowStart} AND client_id = ${clientId}
            ORDER BY score DESC, created_at DESC
            LIMIT 200
          `
        : await tx.$queryRaw<AlertRow[]>`
            SELECT id, client_id AS "clientId", source_type AS "sourceType", severity, urgency, score, title,
                   why_it_matters AS "whyItMatters", recommended_action AS "recommendedAction", created_at AS "createdAt"
            FROM intel_alert
            WHERE status IN ('new', 'reviewed', 'sent') AND tenant_id = ${ctx.tenantId} AND created_at >= ${windowStart}
            ORDER BY score DESC, created_at DESC
            LIMIT 200
          `;

      const clients = await tx.client.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(clientId ? { id: clientId } : { status: { not: 'archived' } }),
        },
        select: { id: true, name: true },
      });
      if (clientId && clients.length === 0) throw new NotFoundException('Client not found');
      const clientNameById = new Map(clients.map((c) => [c.id, c.name]));

      const upcomingRaw = await tx.committeeHearing.findMany({
        where: federalHearingWhere({ visibility: 'public', date: { gte: now, lte: weekAhead } }),
        orderBy: [{ date: 'asc' }],
        take: 20,
        select: { id: true, title: true, date: true, committeeName: true },
      });

      const billsMoved = await tx.$queryRaw<
        Array<{ id: string; display: string; status: string | null; statusAt: Date | null }>
      >`
        WITH tracked AS (
          SELECT DISTINCT bill_id FROM intel_tracked_bill
          WHERE tenant_id = ${ctx.tenantId}
            AND (${clientId}::text IS NULL OR client_id = ${clientId})
        ), movement AS (
          SELECT cb.id,
                 upper(cb.bill_type) || '.' || cb.bill_number::text || ' (' || cb.congress::text || 'th)' AS display,
                 cb.status, cb.status_at AS "statusAt"
          FROM tracked t JOIN congress_bill cb ON cb.id = t.bill_id
          WHERE cb.status_at BETWEEN ${windowStart} AND ${now}
          UNION ALL
          SELECT sb.id, upper(sb.state) || ' ' || sb.identifier AS display, sb.status, sb.status_at AS "statusAt"
          FROM tracked t JOIN state_bill sb ON sb.id = t.bill_id
          WHERE sb.status_at BETWEEN ${windowStart} AND ${now}
        )
        SELECT * FROM movement ORDER BY "statusAt" DESC, id LIMIT 10
      `;

      const whatChanged = alertRows.slice(0, 8).map((r) => ({
        id: r.id,
        title: r.title,
        band: bandForScore(r.score),
        sourceLabel: SOURCE_FAMILY_LABEL[r.sourceType] ?? r.sourceType,
        clientName: clientNameById.get(r.clientId) ?? null,
        ageHours: Math.max(0, Math.round((now.getTime() - r.createdAt.getTime()) / 3_600_000)),
      }));

      const decisionsRequired = alertRows
        .filter((r) => r.severity === 'critical' || r.urgency === 'high')
        .slice(0, 6)
        .map((r) => ({ id: r.id, title: r.title, recommendedAction: r.recommendedAction }));

      // Client implications: the best (max) score per client this window,
      // banded the same way Client Relevance does — never a second scale.
      const bestScoreByClient = new Map<string, number>();
      for (const r of alertRows) {
        const cur = bestScoreByClient.get(r.clientId);
        if (cur === undefined || r.score > cur) bestScoreByClient.set(r.clientId, r.score);
      }
      const clientImplications = clients
        .map((c) => ({
          clientId: c.id,
          clientName: c.name,
          band: bandForScore(bestScoreByClient.get(c.id) ?? null),
        }))
        .sort((a, b) => a.clientName.localeCompare(b.clientName));

      const recommendedActions = [
        ...new Set(
          alertRows
            .map((r) => r.recommendedAction)
            .filter((a): a is string => Boolean(a && a.trim())),
        ),
      ].slice(0, 6);

      const sourceFamilies = [
        ...new Set(alertRows.map((r) => SOURCE_FAMILY_LABEL[r.sourceType] ?? r.sourceType)),
      ];
      const captureCount = new Set(
        alertRows
          .filter((r) => r.sourceType === 'hearing' || r.sourceType === 'combined')
          .map((r) => r.id),
      ).size;

      const content: DigestContent = {
        scopeLabel: clientId ? (clientNameById.get(clientId) ?? 'Client scope') : 'All clients',
        generatedAt: now.toISOString(),
        clientsInScope: clientId ? 1 : clients.length,
        headline:
          whatChanged.length === 0
            ? 'No matching developments were recorded in the last 48 hours.'
            : `${whatChanged.length} development${whatChanged.length === 1 ? '' : 's'} recorded in the last 48 hours — ${decisionsRequired.length} flagged for priority review.`,
        whatChanged,
        decisionsRequired,
        upcomingHearings: upcomingRaw.map((h) => ({
          id: h.id,
          title: h.title,
          date: h.date.toISOString().slice(0, 10),
          committeeName: h.committeeName,
        })),
        billMovement: billsMoved.map((b) => ({
          id: b.id,
          display: b.display,
          status: b.status,
          statusAt: b.statusAt?.toISOString() ?? null,
        })),
        clientImplications,
        recommendedActions,
        provenance: {
          sourceFamilies,
          officialRecordCount: alertRows.length,
          captureCount,
        },
      };

      const run = await tx.legiWatchDigestRun.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          generatedBy: ctx.userId,
          itemCount: whatChanged.length,
          decisionCount: decisionsRequired.length,
          sourceFamilies,
          content: content as unknown as Prisma.InputJsonValue,
        },
      });

      return { id: run.id, ...content };
    });
  }

  async history(
    ctx: TenantContext,
    clientId: string | null,
    limit = 20,
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    if (!Number.isInteger(limit) || limit < 1)
      throw new BadRequestException('limit must be a positive integer');
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchDigestRun.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: [{ generatedAt: 'desc' }],
        take: Math.min(Math.max(limit, 1), 100),
        select: {
          id: true,
          generatedAt: true,
          itemCount: true,
          decisionCount: true,
          sourceFamilies: true,
        },
      }),
    );
    return {
      rows: rows.map((r) => ({
        id: r.id,
        generatedAt: r.generatedAt.toISOString(),
        itemCount: r.itemCount,
        decisionCount: r.decisionCount,
        sourceFamilies: r.sourceFamilies,
      })),
    };
  }

  async getRun(ctx: TenantContext, id: string): Promise<Record<string, unknown>> {
    const run = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchDigestRun.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
    if (!run) throw new NotFoundException(`digest run ${id} not found`);
    return { id: run.id, generatedAt: run.generatedAt.toISOString(), ...(run.content as object) };
  }

  async getSchedule(ctx: TenantContext, clientId: string | null): Promise<Record<string, unknown>> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchDigestSchedule.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, clientId },
      }),
    );
    return row
      ? {
          cadence: row.cadence,
          hourUtc: row.hourUtc,
          emailEnabled: row.emailEnabled,
          updatedAt: row.updatedAt.toISOString(),
        }
      : { cadence: 'off', hourUtc: 11, emailEnabled: true, updatedAt: null };
  }

  async putSchedule(
    ctx: TenantContext,
    clientId: string | null,
    input: { cadence: 'daily' | 'weekly' | 'off'; hourUtc: number; emailEnabled: boolean },
  ): Promise<Record<string, unknown>> {
    if (
      !input ||
      !['daily', 'weekly', 'off'].includes(input.cadence) ||
      !Number.isInteger(input.hourUtc) ||
      input.hourUtc < 0 ||
      input.hourUtc > 23 ||
      typeof input.emailEnabled !== 'boolean'
    ) {
      throw new BadRequestException(
        'cadence must be daily, weekly or off; hourUtc must be an integer between 0 and 23; emailEnabled must be boolean',
      );
    }
    const saved = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (clientId) {
        const client = await tx.client.findFirst({
          where: { tenantId: ctx.tenantId, id: clientId },
          select: { id: true },
        });
        if (!client) throw new NotFoundException('Client not found');
      }
      // The nullable all-clients scope has no unique constraint. Serialize
      // competing saves before checking for an existing row; the transaction
      // releases this scope-specific lock on commit or rollback.
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `legiwatch_digest_schedule:${JSON.stringify([ctx.tenantId, ctx.userId, clientId])}`,
      );
      const existing = await tx.legiWatchDigestSchedule.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, clientId },
      });
      if (existing) {
        return tx.legiWatchDigestSchedule.update({
          where: { id: existing.id },
          data: {
            cadence: input.cadence,
            hourUtc: input.hourUtc,
            emailEnabled: input.emailEnabled,
          },
        });
      }
      return tx.legiWatchDigestSchedule.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId,
          cadence: input.cadence,
          hourUtc: input.hourUtc,
          emailEnabled: input.emailEnabled,
        },
      });
    });
    return {
      cadence: saved.cadence,
      hourUtc: saved.hourUtc,
      emailEnabled: saved.emailEnabled,
      updatedAt: saved.updatedAt.toISOString(),
    };
  }
}
