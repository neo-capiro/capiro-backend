import { Injectable, BadRequestException } from '@nestjs/common';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { Phase8EvidenceService } from './evidence.service.js';
import {
  loadPublisherIntakeReceipts,
  reconcilePublisherCoverage,
  type PublisherObservation,
} from './publisher-coverage.js';

/** Read-only source contracts used by Meri; no dedicated evidence page or monitor workflow. */
@Injectable()
export class RetainedSourceReaderService {
  constructor(readonly evidence: Phase8EvidenceService) {}
  async news(ctx: WorkspaceTenantContext, input: unknown) {
    return this.evidence.run(ctx, input, 'news', async (tx, b, scope) => {
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(b.limit) || 50))),
        offset = Math.max(0, Number(b.offset) || 0),
        days = Number(b.days ?? 7);
      if (![1, 3, 7, 14].includes(days) || !Number.isInteger(offset) || offset > 10000)
        throw new BadRequestException('INVALID_NEWS_WINDOW');
      if (b.monitorId !== undefined) throw new BadRequestException('NEWS_MONITOR_FILTER_RETIRED');
      const q = String(b.q ?? '').slice(0, 500),
        publisher = String(b.publisher ?? ''),
        since = new Date(Date.now() - days * 86400000);
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT o.*, EXISTS(SELECT 1 FROM intel_legiwatch_evidence_tracking t WHERE t.tenant_id=${ctx.tenantId} AND t.owner_clerk_id=${ctx.clerkUserId} AND t.kind='news' AND t.source_id=o.id AND t.folder_id=${scope.folderId} AND NOT t.removed) AS saved, (SELECT t.version FROM intel_legiwatch_evidence_tracking t WHERE t.tenant_id=${ctx.tenantId} AND t.owner_clerk_id=${ctx.clerkUserId} AND t.kind='news' AND t.source_id=o.id AND t.folder_id=${scope.folderId}) AS tracking_version FROM legiwatch_news_source o WHERE o.is_current AND COALESCE(o.published_at,o.observed_at)>=${since} AND (${publisher}='' OR o.publisher=${publisher}) AND (${q}='' OR o.title ILIKE ${'%' + q + '%'} OR o.summary ILIKE ${'%' + q + '%'}) ORDER BY COALESCE(o.published_at,o.observed_at) DESC,o.id LIMIT ${limit + 1} OFFSET ${offset}`;
      const coverage = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM legiwatch_source_coverage ORDER BY source_group,publisher`;
      // Public publisher inventory across the selected window, independent of
      // pagination. This does not certify feed health.
      const retained = await tx.$queryRaw<
        PublisherObservation[]
      >`SELECT publisher,count(*)::int AS articles,
        count(*) FILTER (WHERE body_complete)::int AS full_text_articles,
        max(published_at) AS latest_published_at,max(observed_at) AS latest_observed_at
        FROM legiwatch_news_source WHERE is_current AND COALESCE(published_at,observed_at)>=${since}
        GROUP BY publisher`;
      return {
        scope,
        matchDefinition: null,
        items: rows.slice(0, limit),
        nextOffset: rows.length > limit ? offset + limit : null,
        coverage: reconcilePublisherCoverage(
          coverage,
          retained,
          await loadPublisherIntakeReceipts(tx),
        ),
        window: { since: since.toISOString(), days },
        coverageMessage:
          'Results reflect retained sources. Missing article bodies and unavailable providers limit coverage.',
      };
    });
  }
  async personnel(ctx: WorkspaceTenantContext, input: unknown) {
    return this.evidence.run(ctx, input, 'news', async (tx, b, scope) => {
      const year = Number(b.year ?? new Date().getFullYear()),
        kind = String(b.kind ?? 'change'),
        offset = Math.max(0, Math.trunc(Number(b.offset) || 0)),
        branch = String(b.branch ?? ''),
        q = String(b.q ?? '').slice(0, 200);
      if (
        !['change', 'registration'].includes(kind) ||
        !Number.isInteger(year) ||
        offset > 10000 ||
        !['', 'legislative', 'executive'].includes(branch)
      )
        throw new BadRequestException('INVALID_PERSONNEL_SCOPE');
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT p.*,COALESCE(t.removed=false,false) AS saved,t.version AS tracking_version FROM florida_personnel_observation p LEFT JOIN intel_legiwatch_evidence_tracking t ON t.tenant_id=${ctx.tenantId} AND t.owner_clerk_id=${ctx.clerkUserId} AND t.kind='personnel' AND t.source_id=p.id AND t.folder_id=${scope.folderId} WHERE p.kind=${kind} AND (registration_year=${year} OR registration_year IS NULL) AND (${branch}='' OR branch=${branch}) AND (${q}='' OR name ILIKE ${'%' + q + '%'} OR firm ILIKE ${'%' + q + '%'} OR principal ILIKE ${'%' + q + '%'}) AND NOT EXISTS(SELECT 1 FROM florida_personnel_observation newer WHERE newer.source_key=p.source_key AND (newer.observed_at,newer.id)>(p.observed_at,p.id)) ORDER BY p.name,p.branch,p.principal,p.id LIMIT 101 OFFSET ${offset}`;
      return {
        items: rows.slice(0, 100),
        nextOffset: rows.length > 100 ? offset + 100 : null,
        year,
        notice:
          'Source-linked observations; withdrawal does not establish employment termination. Unresolved identities remain unmerged.',
      };
    });
  }
}
