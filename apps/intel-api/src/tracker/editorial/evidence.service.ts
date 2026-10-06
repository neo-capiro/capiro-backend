import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { evidenceDigest } from './editorial-domain.js';
import {
  PHASE8_FEATURES,
  PHASE8_ALERT_FAMILIES,
  compileNewsQuery,
  matchNews,
  compareBudgetAmounts,
  type BudgetAmount,
  type NewsFields,
} from '@capiro/shared';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { ResearchService } from '../research/research.service.js';
import { object } from '../reports/report-domain.js';
import { hash, isFolderAdmin } from '../folders/folder-tracker.service.js';
import { requestKey, checkedVersion } from '../keywords/keyword-rule.service.js';
import { reconcilePublisherCoverage, type PublisherObservation } from './publisher-coverage.js';

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
  async news(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, 'news', async (tx, b, scope) => {
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(b.limit) || 50))),
        offset = Math.max(0, Number(b.offset) || 0),
        days = Number(b.days ?? 7);
      if (![1, 3, 7, 14].includes(days) || !Number.isInteger(offset) || offset > 10000)
        throw new BadRequestException('INVALID_NEWS_WINDOW');
      const monitor = b.monitorId ? await this.monitor(tx, ctx, String(b.monitorId)) : null;
      if (monitor) await this.context(tx, ctx, phase8Scope(object(monitor.config)));
      const q = String(b.q ?? '').slice(0, 500),
        publisher = String(b.publisher ?? ''),
        since = new Date(Date.now() - days * 86400000);
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT o.*, EXISTS(SELECT 1 FROM intel_legiwatch_evidence_tracking t WHERE t.tenant_id=${ctx.tenantId} AND t.owner_clerk_id=${ctx.clerkUserId} AND t.kind='news' AND t.source_id=o.id AND t.folder_id=${scope.folderId} AND NOT t.removed) AS saved, (SELECT t.version FROM intel_legiwatch_evidence_tracking t WHERE t.tenant_id=${ctx.tenantId} AND t.owner_clerk_id=${ctx.clerkUserId} AND t.kind='news' AND t.source_id=o.id AND t.folder_id=${scope.folderId}) AS tracking_version FROM legiwatch_news_source o WHERE o.is_current AND COALESCE(o.published_at,o.observed_at)>=${since} AND (${publisher}='' OR o.publisher=${publisher}) AND (${q}='' OR o.title ILIKE ${'%' + q + '%'} OR o.summary ILIKE ${'%' + q + '%'}) AND (${monitor?.id ?? ''}='' OR EXISTS(SELECT 1 FROM intel_legiwatch_news_match m WHERE m.tenant_id=${ctx.tenantId} AND m.owner_clerk_id=${ctx.clerkUserId} AND m.monitor_id=${monitor?.id ?? ''} AND m.observation_id=o.id AND m.definition_version=${monitor?.version ?? 0})) ORDER BY COALESCE(o.published_at,o.observed_at) DESC,o.id LIMIT ${limit + 1} OFFSET ${offset}`;
      const coverage =
        await tx.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM legiwatch_source_coverage ORDER BY source_group,publisher`;
      // Public publisher inventory across the selected window, independent of
      // pagination and private monitor matches. This does not certify feed health.
      const retained = await tx.$queryRaw<PublisherObservation[]>`SELECT publisher,count(*)::int AS articles,
        count(*) FILTER (WHERE body_complete)::int AS full_text_articles,
        max(published_at) AS latest_published_at,max(observed_at) AS latest_observed_at
        FROM legiwatch_news_source WHERE is_current AND COALESCE(published_at,observed_at)>=${since}
        GROUP BY publisher`;
      return {
        scope,
        matchDefinition: monitor
          ? {
              id: monitor.id,
              version: monitor.version,
              query: monitor.config.query,
              fields: monitor.config.fields,
              interpretation: compileNewsQuery(String(monitor.config.query)).interpretation,
            }
          : null,
        items: rows.slice(0, limit),
        nextOffset: rows.length > limit ? offset + limit : null,
        coverage: reconcilePublisherCoverage(coverage, retained),
        window: { since: since.toISOString(), days },
        coverageMessage:
          'Results reflect retained sources. Missing article bodies and unavailable providers limit coverage.',
      };
    });
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
  async personnel(ctx: WorkspaceTenantContext, input: unknown) {
    return this.run(ctx, input, 'news', async (tx, b, scope) => {
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
  async track(ctx: WorkspaceTenantContext, input: unknown) {
    const b = object(input);
    return this.run(
      ctx,
      input,
      b.kind === 'budget' ? 'budget' : 'news',
      async (tx, body, scope) => {
        if (!scope.folderId) throw new BadRequestException('FOLDER_REQUIRED');
        await this.context(tx, ctx, scope, true);
        const kind = String(body.kind),
          sourceId = String(body.sourceId),
          notes = String(body.notes ?? '').slice(0, 5000);
        if (!['news', 'budget', 'personnel'].includes(kind))
          throw new BadRequestException('INVALID_TRACKING_KIND');
        if (kind === 'budget') {
          const projects = await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM florida_budget_project WHERE id=${sourceId}`;
          if (!projects.length) throw new NotFoundException('PROJECT_NOT_FOUND');
        } else await this.exact(tx, kind, sourceId);
        const version = checkedVersion(body.expectedVersion);
        const lockKey = [ctx.tenantId, ctx.clerkUserId, scope.folderId, kind, sourceId].join(':');
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey},0))`;
        const existing = await tx.$queryRaw<
          Array<{ version: number }>
        >`SELECT version FROM intel_legiwatch_evidence_tracking WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND folder_id=${scope.folderId} AND kind=${kind} AND source_id=${sourceId}`;
        if ((existing[0]?.version ?? 0) !== version)
          throw new ConflictException('TRACKING_VERSION_CHANGED');
        const rows = await tx.$queryRaw<
          Array<Record<string, unknown>>
        >`INSERT INTO intel_legiwatch_evidence_tracking(id,tenant_id,owner_clerk_id,folder_id,client_id,kind,source_id,removed,notes) VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${scope.folderId},${scope.clientId},${kind},${sourceId},${body.removed === true},${notes}) ON CONFLICT(tenant_id,owner_clerk_id,folder_id,kind,source_id) DO UPDATE SET removed=EXCLUDED.removed,notes=EXCLUDED.notes,version=intel_legiwatch_evidence_tracking.version+1 WHERE intel_legiwatch_evidence_tracking.version=${version} RETURNING *`;
        if (!rows.length) throw new ConflictException('TRACKING_VERSION_CHANGED');
        return rows[0];
      },
    );
  }
  async monitor(tx: Prisma.TransactionClient, ctx: WorkspaceTenantContext, id: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        source: Record<string, unknown>;
        config: Record<string, unknown>;
        version: number;
        state: string;
        baseline_at: Date | null;
        checkpoint: Date | null;
        pending_window: Record<string, unknown> | null;
      }>
    >`SELECT * FROM intel_legiwatch_news_monitor WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND id=${id}`;
    if (!rows[0]) throw new NotFoundException('NEWS_MONITOR_NOT_FOUND');
    return rows[0];
  }
  async monitors(ctx: WorkspaceTenantContext) {
    return this.run(ctx, {}, 'news', async (tx) => {
      const rows = await tx.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM intel_legiwatch_news_monitor WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} ORDER BY source_key`;
      const visible = [];
      for (const row of rows) {
        try {
          await this.context(tx, ctx, phase8Scope(object(row.config)));
          visible.push({
            ...row,
            interpretation: compileNewsQuery(
              String(object(row.config).query ?? object(row.source).raw ?? ''),
            ),
          });
        } catch (e) {
          if (!(e instanceof NotFoundException || e instanceof ForbiddenException)) throw e;
        }
      }
      return { monitors: visible };
    });
  }
  async configureMonitor(ctx: WorkspaceTenantContext, id: string, input: unknown) {
    return this.run(ctx, input, 'news', async (tx, b) => {
      const prior = await this.monitor(tx, ctx, id);
      await this.context(tx, ctx, phase8Scope(prior.config), true);
      const config = object(b.config),
        scope = phase8Scope(config);
      await this.context(tx, ctx, scope, true);
      const query = String(config.query ?? ''),
        provider = String(config.provider ?? 'newscatcher'),
        fields = String(config.fields ?? 'available_text'),
        state = String(b.state ?? 'paused');
      if (
        !['newscatcher', 'rss'].includes(provider) ||
        !compileNewsQuery(query).providerQuery ||
        !['title', 'title_summary', 'available_text'].includes(fields) ||
        !['active', 'paused', 'excluded'].includes(state) ||
        !Array.isArray(config.sources) ||
        config.sources.length > 74 ||
        config.sources.some((s) => typeof s !== 'string' || !/^[a-z0-9.-]+$/i.test(s))
      )
        throw new BadRequestException('REVIEW_NEWS_QUERY_AND_SOURCES');
      if (state === 'active' && config.scopeAccepted !== true)
        throw new BadRequestException('ACCEPT_MONITOR_SCOPE_FIRST');
      const next = {
        ...scope,
        provider,
        query,
        fields,
        sources: config.sources,
        name: String(config.name ?? query).slice(0, 200),
        scopeAccepted: config.scopeAccepted === true,
        language: 'en',
        geographyPolicy: 'Selected publishers; article geography unverified',
      };
      const rows =
        await tx.$queryRaw`UPDATE intel_legiwatch_news_monitor SET config=${JSON.stringify(next)}::jsonb,state=${state},version=version+1,baseline_at=CASE WHEN ${state}='active' THEN now() ELSE NULL END,checkpoint=NULL,pending_window=NULL,last_error=NULL WHERE id=${id} AND tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND version=${checkedVersion(b.expectedVersion)} RETURNING *`;
      if (!(rows as unknown[]).length) throw new ConflictException('MONITOR_VERSION_CHANGED');
      return rows;
    });
  }
  async importPreview(ctx: WorkspaceTenantContext, input: unknown, apply = false) {
    return this.run(ctx, input, 'news', async (tx, b) => {
      if (!isFolderAdmin(ctx)) throw new ForbiddenException('IMPORT_ADMIN_REQUIRED');
      const capture = String(b.capture ?? ''),
        sourceAccount = String(b.sourceAccount ?? capture),
        keywords = Array.isArray(b.keywords) ? b.keywords.map(object) : [],
        alerts = Array.isArray(b.alerts) ? b.alerts.map(object) : [];
      if (
        !/^[\w.-]{1,100}$/.test(capture) ||
        !/^[\w.:-]{1,100}$/.test(sourceAccount) ||
        keywords.length !== 38 ||
        alerts.length !== 5
      )
        throw new BadRequestException('EXACT_PHASE8_CAPTURE_REQUIRED');
      const seen = new Set<string>();
      const definitions = keywords.map((k) => {
        const url = new URL(String(k.url)),
          sourceId = url.searchParams.get('keyword');
        if (
          url.hostname !== 'apps.lobbytools.com' ||
          !sourceId ||
          seen.has(sourceId) ||
          typeof k.keyword !== 'string'
        )
          throw new BadRequestException('INVALID_NEWS_SOURCE_ID');
        seen.add(sourceId);
        const compiled = compileNewsQuery(k.keyword);
        return {
          sourceKey: `${sourceAccount}:news:${sourceId}`,
          raw: k.keyword,
          url: k.url,
          sourceId,
          sourceAccount,
          capture,
          evidencePath: String(
            b.evidencePath ?? 'client-discovery/inventories/news-keywords-38.json',
          ),
          compiled,
        };
      });
      const families = alerts.map((a) => {
        const key = String(a.key) as keyof typeof PHASE8_ALERT_FAMILIES;
        if (!PHASE8_ALERT_FAMILIES[key]) throw new BadRequestException('INVALID_PHASE8_ALERT');
        return {
          ...a,
          key,
          sourceName: a.nameFieldPresent === true ? a.name : null,
          family: PHASE8_ALERT_FAMILIES[key],
          cadence: null,
          recipientsResolved: false,
          dictionaryScope: null,
          prepareEnabled: false,
          sendEnabled: false,
        };
      });
      if (new Set(families.map((f) => f.key)).size !== 5)
        throw new BadRequestException('FIVE_DISTINCT_ALERT_FAMILIES_REQUIRED');
      const current = await tx.$queryRaw<
        Array<{ source_key: string; source: Record<string, unknown>; version: number }>
      >`SELECT source_key,source,version FROM intel_legiwatch_news_monitor WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND source_key=ANY(${definitions.map((d) => d.sourceKey)}::text[])`;
      const decisions = definitions.map((d) => {
        const prior = current.find((p) => p.source_key === d.sourceKey);
        return {
          sourceKey: d.sourceKey,
          raw: d.raw,
          decision: !prior
            ? 'stage'
            : prior.source.raw === d.raw
              ? 'preserve_existing'
              : 'source_changed_requires_review',
          localVersion: prior?.version ?? null,
        };
      });
      if (!apply) return { definitions, families, decisions, staged: 0, activation: false };
      const key = requestKey(b.requestKey),
        inputHash = evidenceDigest({ sourceAccount, capture, keywords, alerts });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':phase8-import:' + key},0))`;
      const prior = await tx.$queryRaw<
        Array<{ input_hash: string; outcome: unknown }>
      >`SELECT input_hash,outcome FROM intel_legiwatch_phase8_decision WHERE tenant_id=${ctx.tenantId} AND owner_clerk_id=${ctx.clerkUserId} AND request_key=${key}`;
      if (prior[0]) {
        if (prior[0].input_hash !== inputHash)
          throw new ConflictException('IMPORT_REQUEST_CHANGED');
        return prior[0].outcome;
      }
      let insertedDefinitions = 0,
        insertedFamilies = 0;
      for (const d of definitions)
        insertedDefinitions +=
          await tx.$executeRaw`INSERT INTO intel_legiwatch_news_monitor(id,tenant_id,owner_clerk_id,source_key,source,config) VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${d.sourceKey},${JSON.stringify(d)}::jsonb,${JSON.stringify({ query: d.raw, fields: 'available_text', sources: [], scopeAccepted: false })}::jsonb) ON CONFLICT(tenant_id,source_key) DO NOTHING`;
      for (const a of families)
        insertedFamilies +=
          await tx.$executeRaw`INSERT INTO intel_legiwatch_editorial_config(id,tenant_id,owner_clerk_id,source_key,source,config) VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${sourceAccount + ':' + a.key},${JSON.stringify(a)}::jsonb,'{"prepareEnabled":false,"sendEnabled":false}') ON CONFLICT(tenant_id,source_key) DO NOTHING`;
      const outcome = {
        definitions: 38,
        families: 5,
        insertedDefinitions,
        insertedFamilies,
        decisions,
        familyDecisions: families.map((f) => ({
          key: f.key,
          state: 'requires_current_configuration',
          source: f,
        })),
        state: 'staged',
        activation: false,
        localEdits: 'preserved',
      };
      await tx.$executeRaw`INSERT INTO intel_legiwatch_phase8_decision(id,tenant_id,owner_clerk_id,request_key,input_hash,outcome) VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${key},${inputHash},${JSON.stringify(outcome)}::jsonb)`;
      return outcome;
    });
  }
  async scan(ctx: WorkspaceTenantContext, id: string) {
    if (process.env.LEGIWATCH_NEWS_MONITOR_ENABLED !== 'true')
      throw new ForbiddenException('NEWS_MATCHING_PAUSED');
    const start = await this.run(ctx, {}, 'news', async (tx) => {
      await tx.$queryRaw`SELECT id FROM intel_legiwatch_news_monitor WHERE id=${id} FOR UPDATE`;
      const m = await this.monitor(tx, ctx, id);
      await this.context(tx, ctx, phase8Scope(m.config));
      if (m.state !== 'active' || !m.baseline_at) throw new ConflictException('MONITOR_PAUSED');
      const end = new Date(Math.floor(Date.now() / 3600000) * 3600000),
        from = new Date(
          Math.max(
            m.baseline_at.getTime(),
            (m.checkpoint?.getTime() ?? end.getTime()) - 48 * 3600000,
          ),
        );
      const window = m.pending_window ?? { from: from.toISOString(), to: end.toISOString() };
      if (from < end || m.pending_window)
        await tx.$executeRaw`UPDATE intel_legiwatch_news_monitor SET pending_window=${JSON.stringify(window)}::jsonb,last_attempt_at=now() WHERE id=${id}`;
      return { ...m, pending_window: window };
    });
    const end = new Date(String(start.pending_window.to)),
      from = new Date(String(start.pending_window.from));
    if (from >= end) return { state: 'waiting_for_first_window', matches: 0 };
    let total = 0;
    for (let page = 1; page <= 10; page++) {
      const result = await this.run(ctx, start.config, 'news', async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id + ':scan'},0))`;
        const m = await this.monitor(tx, ctx, id);
        if (m.state !== 'active' || m.version !== start.version)
          throw new ConflictException('MONITOR_CHANGED');
        const completeWindow = () =>
          tx.$executeRaw`UPDATE intel_legiwatch_news_monitor SET checkpoint=GREATEST(checkpoint,${end}),pending_window=NULL,last_error=NULL WHERE id=${id} AND version=${m.version} AND state='active' AND pending_window=${JSON.stringify(start.pending_window)}::jsonb`;
        const previous = await tx.$queryRaw<
          Array<{ receipt: Record<string, unknown> }>
        >`SELECT receipt FROM intel_legiwatch_news_run WHERE monitor_id=${id} AND tenant_id=${ctx.tenantId} AND definition_version=${m.version} AND window_start=${from} AND window_end=${end} AND page=${page} AND successful ORDER BY created_at DESC LIMIT 1`;
        if (previous[0]) {
          // A replay starts a pending window too. Clear it when its retained
          // receipt is complete so the next hour can advance normally.
          if (previous[0].receipt.complete === true) await completeWindow();
          return previous[0].receipt;
        }
        const base = process.env.API_BASE_URL,
          secret = process.env.INTERNAL_SERVICE_SECRET;
        let receipt: Record<string, unknown> = {
          complete: false,
          reason: 'source_owner_not_configured',
        };
        if (m.config.provider === 'rss') {
          const domains = Array.isArray(m.config.sources) ? m.config.sources.map(String) : [];
          const retained = await tx.$queryRaw<
            Array<Record<string, unknown>>
          >`SELECT o.* FROM legiwatch_news_source o WHERE o.provider='rss' AND o.is_current AND o.observed_at>${from} AND o.observed_at<=${end} AND (cardinality(${domains}::text[])=0 OR o.publisher=ANY(${domains}::text[])) ORDER BY o.observed_at,o.id LIMIT 101 OFFSET ${(page - 1) * 100}`;
          const feedRuns = await tx.$queryRaw<
            Array<{
              source_url: string;
              observed_at: Date;
              scope: Record<string, unknown>;
              manifest: Record<string, unknown>;
            }>
          >`SELECT DISTINCT ON (source_url) source_url,observed_at,scope,manifest FROM legiwatch_source_receipt WHERE source='rss' AND (cardinality(${domains}::text[])=0 OR scope->>'domain'=ANY(${domains}::text[])) ORDER BY source_url,observed_at DESC,id DESC`;
          const missing = domains.some(
            (domain) => !feedRuns.some((run) => run.scope.domain === domain),
          );
          const unavailable =
            missing ||
            !feedRuns.length ||
            feedRuns.some(
              (run) =>
                run.manifest.status === 'failed' ||
                Date.now() - run.observed_at.getTime() > 26 * 3600000,
            );
          receipt = {
            articles: retained.slice(0, 100),
            page,
            observedCount: retained.slice(0, 100).length,
            complete: retained.length <= 100 && !unavailable,
            reason:
              retained.length > 100
                ? 'more_pages'
                : unavailable
                  ? 'rss_feed_unavailable_or_stale'
                  : null,
            provider: 'rss',
            coverage: 'retained_current_feed_only',
            historicalCoverage: 'unqualified',
            feedReceipts: feedRuns.map((run) => ({
              url: run.source_url,
              observedAt: run.observed_at,
              ...run.manifest,
            })),
            parserVersion: 'rss-retained-v1',
          };
        } else if (base && secret)
          try {
            const response = await fetch(
              base.replace(/\/+$/, '') + '/api/internal/legiwatch/news/page',
              {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-internal-service-secret': secret,
                },
                body: JSON.stringify({
                  tenantId: ctx.tenantId,
                  ownerId: ctx.clerkUserId,
                  query: m.config.query,
                  sources: m.config.sources,
                  from: from.toISOString(),
                  to: end.toISOString(),
                  page,
                }),
                signal: AbortSignal.timeout(30000),
                redirect: 'error',
              },
            );
            receipt = response.ok
              ? object(await response.json())
              : { complete: false, reason: `source_http_${response.status}` };
          } catch {
            receipt = { complete: false, reason: 'source_request_failed' };
          }
        const articles = Array.isArray(receipt.articles) ? receipt.articles.map(object) : [];
        // Current access is checked again after the provider response, before matches escape.
        await this.context(tx, ctx, phase8Scope(m.config));
        let matches = 0;
        for (const a of articles) {
          const match = matchNews(
            String(m.config.query),
            {
              title: String(a.title ?? ''),
              summary: typeof a.summary === 'string' ? a.summary : null,
              body: typeof a.body === 'string' ? a.body : null,
              bodyComplete: a.body_complete === true,
            },
            m.config.fields as NewsFields,
          );
          if (match.outcome !== 'match') continue;
          const matchId = hash([id, m.version, a.id]);
          await tx.$executeRaw`INSERT INTO intel_legiwatch_news_match(id,tenant_id,owner_clerk_id,monitor_id,definition_version,observation_id,baseline,evidence) VALUES(${matchId},${ctx.tenantId},${ctx.clerkUserId},${id},${m.version},${String(a.id)},false,${JSON.stringify(match)}::jsonb) ON CONFLICT DO NOTHING`;
          matches++;
        }
        const stored: Record<string, unknown> = {
          ...receipt,
          articles: undefined,
          matches,
          observationIds: articles.map((a) => a.id),
        };
        // Only successful pages are checkpointed; failures can retry this exact window.
        await tx.$executeRaw`INSERT INTO intel_legiwatch_news_run(id,tenant_id,owner_clerk_id,monitor_id,definition_version,window_start,window_end,page,receipt,complete,successful) VALUES(${randomUUID()},${ctx.tenantId},${ctx.clerkUserId},${id},${m.version},${from},${end},${page},${JSON.stringify(stored)}::jsonb,${receipt.complete === true},${receipt.complete === true || receipt.reason === 'more_pages'}) ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`UPDATE intel_legiwatch_news_monitor SET last_error=${receipt.complete === true ? null : String(receipt.reason ?? 'partial')} WHERE id=${id}`;
        if (receipt.complete === true) await completeWindow();
        return stored;
      });
      total += Number(result.matches ?? 0);
      if (result.complete === true)
        return { state: 'complete', matches: total, cutoff: end.toISOString() };
      if (result.reason !== 'more_pages')
        return { state: 'partial', matches: total, reason: result.reason };
    }
    return { state: 'partial', matches: total, reason: 'page_cap' };
  }
}
