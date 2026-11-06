import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  LegiWatchImpactAnalysis,
  LegiWatchImpactDetail,
  LegiWatchTrackerPage,
  TenantContext,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ImpactRepository,
  emptyImpact,
  presentImpactRow,
  safeSourceUrl,
  type ImpactStoredRow,
  type StoredImpactAnalysis,
} from './impact.repository.js';
import { ImpactEvidenceService } from './impact-evidence.service.js';
import { ImpactAnalysisService } from './impact-analysis.service.js';
import type { ImpactEvidenceSnapshot } from './impact-evidence.types.js';
import type { ImpactContextDto, ImpactTrackerQuery } from './impact.dto.js';

/** A changed source can also be a revoked private document. Never expose old prose/citations. */
export function currentImpact(
  analysis: StoredImpactAnalysis | null,
  snapshot: ImpactEvidenceSnapshot,
): LegiWatchImpactAnalysis {
  if (!analysis) return emptyImpact();
  // A failed refresh retains the previous valid assessment privately. Its sources
  // may have been revoked, even when the latest attempt's fingerprint is current.
  const { lastValidAnalysis: _lastValidAnalysis, ...current } = analysis;
  if (analysis.inputFingerprint === snapshot.fingerprint)
    return { ...current, stale: false, staleReason: null };
  return {
    ...emptyImpact('Bill text or client evidence changed. Refresh the impact analysis.'),
    analyzedAt: analysis.analyzedAt,
    stale: true,
    staleReason: 'The current evidence differs from the saved analysis.',
  };
}

@Injectable()
export class ImpactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: ImpactRepository,
    private readonly evidence: ImpactEvidenceService,
    private readonly analysis: ImpactAnalysisService,
  ) {}

  async list(ctx: TenantContext, query: ImpactTrackerQuery): Promise<LegiWatchTrackerPage> {
    return this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const page = await this.repository.list(tx, ctx, query);
        // Request-local source caches avoid repeatedly loading the same client
        // or bill while still checking current visibility before returning prose.
        const snapshots = await this.evidence.loadMany(tx, ctx, page.rows);
        const rows = page.rows.map((row, index) =>
          presentImpactRow(row, currentImpact(row.analysis, snapshots[index]!)),
        );
        return { ...page, rows, asOf: new Date().toISOString() };
      },
      { timeoutMs: 30_000 },
    );
  }

  private billId(billId: string) {
    if (!/^[a-z0-9-]{3,160}$/i.test(billId))
      throw new BadRequestException('Invalid bill identifier');
    return billId;
  }

  private async read(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string,
    billId: string,
  ) {
    const row = await this.repository.row(tx, ctx, clientId, this.billId(billId));
    const snapshot = await this.evidence.load(tx, ctx, clientId, billId);
    return { row, snapshot };
  }

  private async detailFrom(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    row: ImpactStoredRow,
    snapshot: ImpactEvidenceSnapshot,
  ): Promise<LegiWatchImpactDetail> {
    const actions = await this.repository.actions(tx, row.billId);
    const publicRow = presentImpactRow(row, currentImpact(row.analysis, snapshot));
    return {
      row: publicRow,
      actions: actions.map((action) => ({
        ...action,
        sourceUrl: safeSourceUrl(action.sourceUrl) ?? publicRow.sourceUrl,
      })),
      versions: snapshot.versions.map((v) => ({
        ...v,
        sourceUrl: safeSourceUrl(v.sourceUrl),
      })),
      clientFacts: snapshot.clientFacts,
      sourceCoverage: {
        billText: snapshot.provisions.length > 0,
        clientFacts: snapshot.clientFacts.length > 0,
        notes: snapshot.coverageNotes,
      },
      refresh: await this.repository.refresh(tx, ctx, row.clientId, row.billId),
    };
  }

  async detail(ctx: TenantContext, clientId: string, billId: string) {
    return this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const { row, snapshot } = await this.read(tx, ctx, clientId, billId);
        return this.detailFrom(tx, ctx, row, snapshot);
      },
      { timeoutMs: 20_000 },
    );
  }

  async analyze(
    ctx: TenantContext,
    clientId: string,
    billId: string,
    beforePersist?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    const start = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      (tx) => this.read(tx, ctx, clientId, billId),
      { timeoutMs: 20_000 },
    );
    if (
      start.row.analysis?.status === 'ready' &&
      start.row.analysis.inputFingerprint === start.snapshot.fingerprint
    )
      return this.detail(ctx, clientId, billId);
    // No transaction or client lock is held during model execution.
    const analysis = await this.analysis.analyze(start.snapshot);
    return this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const current = await this.read(tx, ctx, clientId, billId);
        if (
          current.snapshot.fingerprint !== start.snapshot.fingerprint ||
          current.row.trackerBackend !== start.row.trackerBackend
        )
          throw new ConflictException(
            'The bill or client evidence changed. Refresh and analyze again.',
          );
        await beforePersist?.(tx);
        // A concurrent successful run for the same evidence is already valid.
        // A slower failed attempt must not replace it with an unavailable result.
        if (
          current.row.analysis?.status === 'ready' &&
          current.row.analysis.inputFingerprint === current.snapshot.fingerprint
        )
          return this.detailFrom(tx, ctx, current.row, current.snapshot);
        const result = {
          ...analysis,
          inputFingerprint: current.snapshot.fingerprint,
          stale: false,
          staleReason: null,
        };
        const saved = await this.repository.save(tx, ctx, clientId, billId, result);
        return this.detailFrom(tx, ctx, { ...current.row, analysis: saved }, current.snapshot);
      },
      { timeoutMs: 20_000 },
    );
  }

  async updateContext(
    ctx: TenantContext,
    clientId: string,
    billId: string,
    body: ImpactContextDto,
  ) {
    return this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const { row } = await this.read(tx, ctx, clientId, billId);
        await this.repository.updateContext(tx, ctx, row, body);
        const current = await this.read(tx, ctx, clientId, billId);
        return this.detailFrom(tx, ctx, current.row, current.snapshot);
      },
      { timeoutMs: 20_000 },
    );
  }
}
