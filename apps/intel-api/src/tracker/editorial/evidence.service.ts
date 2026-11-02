import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PHASE8_FEATURES, compareBudgetAmounts, type BudgetAmount } from '@capiro/shared';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { ResearchService } from '../research/research.service.js';
import { object } from '../delivery/delivery-domain.js';

export type Phase8Scope = {
  jurisdiction: string;
  sessionKey: string;
  folderId: string | null;
  clientId: string | null;
};
export type SourceRow = Record<string, unknown> & {
  id: string;
  revision: string;
  title: string;
  sourceUrl: string;
  text: string;
  observedAt: string;
  complete: boolean;
  authority: string;
  rights: string;
};
export function phase8Scope(b: Record<string, unknown>): Phase8Scope {
  for (const k of ['folderId', 'clientId'])
    if (
      b[k] !== undefined &&
      b[k] !== null &&
      (typeof b[k] !== 'string' || String(b[k]).length > 100)
    )
      throw new BadRequestException('INVALID_PRIVATE_SCOPE');
  return {
    jurisdiction: 'FL',
    sessionKey: String(b.sessionKey ?? ''),
    folderId: b.folderId ? String(b.folderId) : null,
    clientId: b.clientId ? String(b.clientId) : null,
  };
}
@Injectable()
/** Retained exact citations and Florida read contracts; no monitor or intake workflow. */
export class Phase8EvidenceService {
  constructor(readonly research: ResearchService) {}
  get reports() {
    return this.research.keywords.reports;
  }
  async context(
    tx: Prisma.TransactionClient,
    ctx: WorkspaceTenantContext,
    scope: Phase8Scope,
    write = false,
  ) {
    if (scope.folderId) {
      const folder = await this.research.keywords.folder(tx, ctx, scope.folderId, write);
      if (scope.clientId && scope.clientId !== folder.clientId)
        throw new NotFoundException('FOLDER_CLIENT_SCOPE_MISMATCH');
      scope.clientId = folder.clientId ?? null;
    }
    await this.research.context(tx, ctx, scope, write);
  }
  async run<T>(
    ctx: WorkspaceTenantContext,
    input: unknown,
    lane: keyof typeof PHASE8_FEATURES,
    fn: (
      tx: Prisma.TransactionClient,
      b: Record<string, unknown>,
      scope: Phase8Scope,
    ) => Promise<T>,
  ) {
    await this.reports.authorize(ctx, PHASE8_FEATURES[lane]);
    const b = object(input),
      scope = phase8Scope(b);
    return this.reports.folders.withActor(
      ctx,
      async (tx) => {
        await this.context(tx, ctx, scope);
        return fn(tx, b, scope);
      },
      { timeoutMs: 45000 },
    );
  }
  async exact(tx: Prisma.TransactionClient, kind: string, id: string): Promise<SourceRow> {
    if (!id || id.length > 200) throw new BadRequestException('EXACT_SOURCE_REQUIRED');
    if (kind === 'news') {
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM legiwatch_news_source WHERE id=${id}`;
      const row = rows[0];
      if (!row) throw new NotFoundException('NEWS_SOURCE_NOT_FOUND');
      return {
        ...row,
        id,
        revision: String(row.revision),
        title: String(row.title),
        sourceUrl: String(row.source_url),
        text: [row.title, row.summary, row.body].filter(Boolean).join('\n'),
        observedAt: new Date(String(row.observed_at)).toISOString(),
        complete: row.body_complete === true,
        authority: 'Attributed publisher reporting',
        rights: String(row.rights),
      };
    }
    if (kind === 'budget') {
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM florida_budget_document WHERE id=${id}`;
      const row = rows[0];
      if (!row) throw new NotFoundException('BUDGET_SOURCE_NOT_FOUND');
      const sections = Array.isArray(row.sections) ? row.sections.map(object) : [];
      return {
        ...row,
        id,
        revision: String(row.content_hash),
        title: String(row.title),
        sourceUrl: String(row.source_url),
        text: sections.map((s) => String(s.text ?? '')).join('\n'),
        observedAt: new Date(String(row.observed_at)).toISOString(),
        complete: row.complete === true,
        authority: `Florida fiscal source: ${row.stage}`,
        rights: 'full_text',
      };
    }
    if (kind === 'personnel') {
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM florida_personnel_observation WHERE id=${id}`;
      const row = rows[0];
      if (!row) throw new NotFoundException('PERSONNEL_SOURCE_NOT_FOUND');
      return {
        ...row,
        id,
        revision: String(row.revision),
        title: String(row.name),
        sourceUrl: String(row.source_url),
        text: String(object(row.payload).sourceText ?? ''),
        observedAt: new Date(String(row.observed_at)).toISOString(),
        complete: true,
        authority: String(row.confirmation),
        rights: 'full_text',
      };
    }
    if (kind === 'research') {
      const d = await this.research.exact(tx, id, {
        jurisdiction: 'FL',
        sessionKey: '',
        folderId: null,
        clientId: null,
      });
      return {
        id,
        billId: d.billId,
        revision: d.revision,
        title: d.kind,
        sourceUrl: d.sourceUrl ?? '',
        text: d.sections.map((s) => s.text).join('\n'),
        sections: d.sections,
        observedAt: d.observedAt,
        complete: d.complete,
        authority: 'Published legislative record',
        rights: 'full_text',
      };
    }
    throw new BadRequestException('TYPED_EVIDENCE_REQUIRED');
  }
  async budget(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, 'budget', async (tx, b, scope) => {
      const query = String(b.q ?? '').slice(0, 200);
      const fiscalYear = String(b.fiscalYear ?? '2026-27'),
        id = String(b.projectId ?? ''),
        offset = Math.max(0, Number(b.offset) || 0);
      if (!/^20\d{2}-\d{2}$/.test(fiscalYear) || !Number.isInteger(offset) || offset > 10000)
        throw new BadRequestException('FISCAL_YEAR_REQUIRED');
      const projects = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT p.*,COALESCE(t.removed=false,false) AS saved,t.version AS tracking_version FROM florida_budget_project p LEFT JOIN intel_legiwatch_evidence_tracking t ON t.tenant_id=${ctx.tenantId} AND t.owner_clerk_id=${ctx.clerkUserId} AND t.kind='budget' AND t.source_id=p.id AND t.folder_id=${scope.folderId} WHERE p.fiscal_year=${fiscalYear} AND (${query}='' OR p.title ILIKE ${'%' + query + '%'} OR p.id ILIKE ${'%' + query + '%'}) AND (${id}='' OR p.id=${id}) ORDER BY p.title,p.id LIMIT 101 OFFSET ${offset}`;
      const documents =
        await tx.$queryRaw`SELECT id,publisher,source_url,content_hash,title,fiscal_year,session_key,chamber,stage,role,offer,publication_date,observed_at,complete,metadata FROM florida_budget_document WHERE fiscal_year=${fiscalYear} AND (${scope.sessionKey}='' OR session_key=${scope.sessionKey}) ORDER BY observed_at DESC,id LIMIT 101`;
      const projectIds = projects.slice(0, 100).map((project) => String(project.id));
      const amounts = id
        ? await tx.$queryRaw`SELECT id,observation FROM florida_budget_amount WHERE project_id=${id} ORDER BY observed_at,id LIMIT 501`
        : [];
      // One bounded lateral lookup per displayed project; preserve each source
      // observation rather than adding incompatible chamber proposals together.
      const projectAmounts = projectIds.length
        ? await tx.$queryRaw<Array<{ project_id: string; id: string; observation: unknown }>>`
            SELECT a.project_id,a.id,a.observation FROM unnest(${projectIds}::text[]) p(id)
            CROSS JOIN LATERAL (
              SELECT a.project_id,a.id,a.observation FROM florida_budget_amount a
              JOIN florida_budget_document d ON d.id=a.document_id
              WHERE a.project_id=p.id
                AND (${scope.sessionKey}='' OR d.session_key=${scope.sessionKey})
              ORDER BY a.observed_at DESC,a.id DESC LIMIT 4
            ) a`
        : [];
      const events =
        await tx.$queryRaw`SELECT e.*,d.title,d.source_url,d.stage,d.fiscal_year FROM florida_budget_event e JOIN florida_budget_document d ON d.id=e.document_id WHERE d.fiscal_year=${fiscalYear} AND (${scope.sessionKey}='' OR d.session_key=${scope.sessionKey}) AND (${id}='' OR e.project_id=${id}) ORDER BY e.observed_at DESC,e.id LIMIT 101`;
      return {
        scope,
        fiscalYear,
        projects: projects.slice(0, 100).map((project) => ({
          ...project,
          recentAmounts: projectAmounts.filter((amount) => amount.project_id === project.id),
        })),
        nextOffset: projects.length > 100 ? offset + 100 : null,
        documents,
        amounts,
        events,
        notice:
          'Selected publisher evidence. Requests and chamber alternatives are not awards. No statewide aggregate is inferred.',
      };
    });
  }
  /** Retained Meri comparison contract; no dedicated budget browser endpoint. */
  async compare(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, 'budget', async (tx, b) => {
      const ids = [String(b.leftId ?? ''), String(b.rightId ?? '')];
      const rows = await tx.$queryRaw<
        Array<{ id: string; observation: BudgetAmount }>
      >`SELECT id,observation FROM florida_budget_amount WHERE id=ANY(${ids}::text[])`;
      const left = rows.find((r) => r.id === ids[0])?.observation,
        right = rows.find((r) => r.id === ids[1])?.observation;
      if (!left || !right) throw new NotFoundException('AMOUNT_OBSERVATIONS_REQUIRED');
      if (left.sourceRevision !== b.leftRevision || right.sourceRevision !== b.rightRevision)
        throw new ConflictException('EXACT_BUDGET_REVISIONS_REQUIRED');
      return compareBudgetAmounts(left, right);
    });
  }
}
