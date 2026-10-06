import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PrismaService as ApiPrisma } from '../../api/src/prisma/prisma.service.js';
import { PrismaService as WorkspacePrisma } from '../../workspace/src/prisma/prisma.service.js';
import { NewsEvidenceService } from '../../api/src/intelligence/news/news-evidence.service.js';
import { NewsCatcherDashboardService } from '../../api/src/intelligence/news/news-catcher-dashboard.service.js';
import { DraftsService } from '../../workspace/src/drafts/drafts.service.js';
import { CollaboratorsService } from '../../workspace/src/collaborators/collaborators.service.js';
import { EditorialDraftSourceController } from '../../workspace/src/drafts/editorial-source.controller.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { KeywordSourceRepository } from '../src/sourcedata/keyword-source.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { ReportRecipientsService } from '../src/tracker/reports/recipients.service.js';
import { ReportDeliveryService } from '../src/tracker/reports/report-delivery.service.js';
import { KeywordRuleService } from '../src/tracker/keywords/keyword-rule.service.js';
import { ResearchService } from '../src/tracker/research/research.service.js';
import { Phase8EvidenceService } from '../src/tracker/editorial/evidence.service.js';
import { EditorialService } from '../src/tracker/editorial/editorial.service.js';
import { runEditorialWork } from '../src/tracker/editorial/editorial-runtime.js';
import { discoverEditorialWork } from '../src/tracker/editorial/editorial-discovery.js';
import { digest, object } from '../src/tracker/reports/report-domain.js';
jest.setTimeout(120000);
describe('Phase 8 public observations, private selections and actual database retries', () => {
  const p = new PrismaService(),
    api = new ApiPrisma(),
    ws = new WorkspacePrisma();
  const folders = new FolderTrackerService(
    p,
    new FolderSourceDataRepository(p),
    new SourceDataRepository(p),
  );
  const flags = new FeatureFlagService(p, new ConfigService()),
    reports = new ReportService(folders, flags),
    recipients = new ReportRecipientsService(reports);
  const keywords = new KeywordRuleService(reports, new KeywordSourceRepository(p)),
    research = new ResearchService(keywords),
    evidence = new Phase8EvidenceService(research);
  const delivery = new ReportDeliveryService(reports, recipients, {
      sendReport: jest.fn(),
    } as never),
    editorial = new EditorialService(evidence, recipients, delivery);
  const drafts = new DraftsService(ws, new CollaboratorsService(ws, {} as never)),
    output = new EditorialDraftSourceController(drafts, ws),
    news = new NewsEvidenceService(api);
  const tenant = randomUUID(),
    actor = 'p8-' + randomUUID(),
    ctx = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' },
    session = 'p8-' + randomUUID().slice(0, 8);
  let folderId = '',
    reportId = '',
    lost = false,
    pageFailure = true,
    article: Record<string, unknown>,
    article2: Record<string, unknown>;
  const pages: number[] = [],
    beforeFetch = global.fetch,
    beforeEnv = { ...process.env };
  const scope = () => ({ jurisdiction: 'FL', sessionKey: session, clientId: null, folderId });
  it('reads current public bill status in a bounded batch without changing retained evidence', async () => {
    const id = `119-hr-${Date.now()}`;
    await api.$executeRaw`INSERT INTO congress_bill(id,congress,bill_type,bill_number,title,status,status_at,origin_chamber) VALUES(${id},119,'hr','99999','Synthetic current-status fixture','passed_chamber','2026-07-22'::timestamptz,'House')`;
    try {
      const rows = await new SourceDataRepository(p).getFeedBillStatuses([id, id, "'; DROP TABLE congress_bill; --", 'fl-2026-h1211']);
      expect(rows).toEqual([{ id, status: 'passed_chamber', statusAt: new Date('2026-07-22T00:00:00Z'), originChamber: 'House' }]);
    } finally { await api.$executeRaw`DELETE FROM congress_bill WHERE id=${id}`; }
  });
  it('reconciles publisher articles across pages without converting configured unavailability to health', async () => {
    const publisher = `coverage-${randomUUID()}.invalid`, coverageId = randomUUID();
    await api.$executeRaw`INSERT INTO legiwatch_source_coverage(id,publisher,source_group,source_url,status,evidence,owner) VALUES(${coverageId},${publisher},'regional',${`https://${publisher}/feed`},'unavailable','{}','test')`;
    for (let i = 0; i < 2; i++) await news.retain({ provider: 'test', url: `https://${publisher}/${i}`, publisher, title: 'Retained reporting', publishedAt: new Date().toISOString(), rights: 'headline_link' });
    const result = await evidence.news(ctx, { ...scope(), days: 1, limit: 1, publisher });
    expect(result.items).toHaveLength(1);
    expect(result.coverage.find((row) => row.id === coverageId)).toMatchObject({ status: 'unavailable', retained: { articles: 2, fullTextArticles: 0 } });
  });
  it('filters budget update events by the exact selected legislative session', async () => {
    const receiptId = randomUUID(), projectId = randomUUID(), wantedEvent = randomUUID(), otherEvent = randomUUID();
    await api.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete) VALUES(${receiptId},'test','https://example.invalid/session-test','test','{}','{}',true)`;
    await api.$executeRaw`INSERT INTO florida_budget_project(id,fiscal_year,title,identities,evidence) VALUES(${projectId},'2026-27','Session fixture','[]','{}')`;
    for (const [sessionKey, eventId] of [[session, wantedEvent], [session + '-other', otherEvent]]) {
      const documentId = randomUUID();
      await api.$executeRaw`INSERT INTO florida_budget_document(id,publisher,source_url,content_hash,title,fiscal_year,session_key,chamber,stage,role,receipt_id,sections,complete) VALUES(${documentId},'Test',${'https://example.invalid/' + documentId},'test','Session budget','2026-27',${sessionKey},'House','chamber_proposal','comparison',${receiptId},'[]',true)`;
      await api.$executeRaw`INSERT INTO florida_budget_event(id,project_id,document_id,kind,payload) VALUES(${eventId},${projectId},${documentId},'new_document','{}')`;
    }
    const result = await evidence.budget(ctx, { ...scope(), fiscalYear: '2026-27', projectId });
    expect((result.events as Array<{ id: string }>).map((row) => row.id)).toEqual([wantedEvent]);
  });
  it('discovers scheduled work under the real application role without bypassing owner RLS', async () => {
    const monitorId = randomUUID(),
      configId = randomUUID(),
      foreignId = randomUUID();
    await p.$executeRaw`INSERT INTO intel_legiwatch_news_monitor(id,tenant_id,owner_clerk_id,source_key,source,config,state) VALUES(${monitorId},${tenant},${actor},${monitorId},'{}','{}','active'),(${foreignId},${randomUUID()},${actor},${foreignId},'{}','{}','active')`;
    await p.$executeRaw`INSERT INTO intel_legiwatch_editorial_config(id,tenant_id,owner_clerk_id,source_key,source,config,state) VALUES(${configId},${tenant},${actor},${configId},'{}','{}','active')`;
    try {
      const restricted = {
        withSystem: (fn: Parameters<PrismaService['withSystem']>[0]) =>
          p.withSystem(async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
            await tx.$executeRaw`SELECT set_config('app.current_tenant','',true),set_config('app.folder_actor','',true)`;
            return fn(tx);
          }),
        withTenant: (id: string, fn: Parameters<PrismaService['withTenant']>[1]) =>
          p.withTenant(id, async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
            await tx.$executeRaw`SELECT set_config('app.bypass_rls','off',true),set_config('app.folder_actor','',true)`;
            return fn(tx);
          }),
      } as Pick<PrismaService, 'withSystem' | 'withTenant'>;
      const invisible = await restricted.withSystem(
        (tx) =>
          tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM intel_legiwatch_news_monitor WHERE id=${monitorId}`,
      );
      expect(invisible).toEqual([]);
      const found = await discoverEditorialWork(restricted, tenant);
      expect(found.monitors.map((m) => m.id)).toContain(monitorId);
      expect(found.configurations.map((c) => c.id)).toContain(configId);
      expect(found.monitors.map((m) => m.id)).not.toContain(foreignId);
      const unscoped = await restricted.withTenant(
        tenant,
        (tx) =>
          tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM intel_legiwatch_news_monitor WHERE id=${monitorId}`,
      );
      expect(unscoped).toEqual([]);
    } finally {
      await p.$executeRaw`DELETE FROM intel_legiwatch_news_monitor WHERE id=ANY(${[monitorId, foreignId]}::text[])`;
      await p.$executeRaw`DELETE FROM intel_legiwatch_editorial_config WHERE id=${configId}`;
    }
  });
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE8_TEST_DATABASE !== 'disposable' ||
      !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
    )
      throw Error('DISPOSABLE_DATABASE_REQUIRED');
    await Promise.all([p.$connect(), api.$connect(), ws.$connect()]);
    await p.withSystem(async (tx) => {
      const user = randomUUID();
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${tenant},'Synthetic Phase 8')`;
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
      for (const feature of [
        'legiwatch_news_v1',
        'legiwatch_florida_budget_v1',
        'legiwatch_editorial_v1',
        'legiwatch_reports_updates_v1',
        'legiwatch_report_delivery_v1',
      ])
        await tx.featureFlag.create({ data: { tenantId: tenant, feature, enabled: true } });
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES(${randomUUID()},'FL',${session},${session},'HB 8','HB8','Synthetic Phase 8')`;
    });
    folderId = (
      await folders.create(ctx, {
        name: 'Phase 8 private pilot',
        jurisdiction: 'FL',
        defaultSession: session,
      })
    ).id;
    reportId = (
      await reports.save(ctx, {
        name: 'Phase 8 editions',
        folderIds: [folderId],
        jurisdiction: 'FL',
        sessionKey: session,
      })
    ).id;
    article = await news.retain({
      provider: 'test',
      url: 'https://example.invalid/p8/' + randomUUID(),
      publisher: 'Official fixture',
      title: 'Water project proposed',
      publishedAt: '2026-09-01T00:00:00Z',
      rights: 'headline_link',
    });
    article2 = await news.retain({
      provider: 'test',
      url: 'https://example.invalid/p8/' + randomUUID(),
      publisher: 'Official fixture',
      title: 'Water project revised',
      publishedAt: '2026-09-02T00:00:00Z',
      rights: 'headline_link',
    });
    Object.assign(process.env, {
      WORKSPACE_BASE_URL: 'https://workspace.example.invalid',
      API_BASE_URL: 'https://api.example.invalid',
      INTEL_API_BASE_URL: 'https://intel.example.invalid',
      INTERNAL_SERVICE_SECRET: 'test-only',
      LEGIWATCH_NEWS_MONITOR_ENABLED: 'true',
    });
    global.fetch = jest.fn(async (raw, init) => {
      const url = new URL(String(raw));
      if (url.pathname.endsWith('/news/page')) {
        const b = JSON.parse(String(init!.body));
        pages.push(b.page);
        if (b.page === 2 && pageFailure)
          return {
            ok: true,
            json: async () => ({ complete: false, reason: 'provider_unavailable', page: 2 }),
          } as Response;
        return {
          ok: true,
          json: async () => ({
            articles: [b.page === 1 ? article : article2],
            page: b.page,
            totalPages: 2,
            totalHits: 2,
            complete: b.page === 2,
            reason: b.page === 1 ? 'more_pages' : null,
          }),
        } as Response;
      }
      if (url.pathname.endsWith('/access')) {
        await editorial.source(
          {
            tenantId: url.searchParams.get('tenantId')!,
            clerkUserId: url.searchParams.get('ownerId')!,
            role: null,
          },
          url.pathname.split('/').at(-2)!,
        );
        return {
          ok: true,
          json: async () => ({ allowed: true, selectionId: url.pathname.split('/').at(-2)! }),
        } as Response;
      }
      if (url.pathname.endsWith('/output'))
        return {
          ok: true,
          json: () =>
            output.output(
              url.pathname.split('/').at(-2)!,
              url.searchParams.get('tenantId')!,
              url.searchParams.get('ownerId')!,
            ),
        } as Response;
      if (url.pathname.endsWith('/editorial/lookup'))
        return { ok: true, json: () => output.lookup(JSON.parse(String(init!.body))) } as Response;
      const b = JSON.parse(String(init!.body)),
        source = await editorial.source(ctx, b.actionId),
        result = await drafts.createEditorial(
          b.tenantId,
          b.ownerId,
          b.actionId,
          source.prefill as never,
        );
      if (lost) {
        lost = false;
        throw Error('Lost acknowledgement after Workspace commit');
      }
      return { ok: true, json: async () => result } as Response;
    });
  });
  afterAll(async () => {
    global.fetch = beforeFetch;
    process.env = beforeEnv;
    await Promise.all([p.$disconnect(), api.$disconnect(), ws.$disconnect()]);
  });
  const capture = () => ({
    capture: 'synthetic-' + tenant,
    requestKey: randomUUID(),
    keywords: Array.from({ length: 38 }, (_, i) => ({
      keyword: i < 21 ? '"water project"' : 'water project',
      url: 'https://apps.lobbytools.com/?keyword=' + i,
    })),
    alerts: ['01', '02', '03', '39', '40'].map((n) => ({
      key: 'alert-' + n,
      nameFieldPresent: ['01', '02'].includes(n),
    })),
  });
  test('38 definitions and five families stage without activation; replays preserve manual configuration', async () => {
    const input = capture();
    expect((await evidence.importPreview(ctx, input)).activation).toBe(false);
    await evidence.importPreview(ctx, input, true);
    let monitors = (await evidence.monitors(ctx)).monitors as any[];
    expect(monitors).toHaveLength(38);
    expect(monitors.every((m) => m.state === 'needs_review')).toBe(true);
    const m = monitors[0];
    await evidence.configureMonitor(ctx, m.id, {
      expectedVersion: 0,
      config: {
        ...scope(),
        query: 'water',
        fields: 'title',
        sources: ['example.invalid'],
        scopeAccepted: true,
      },
      state: 'paused',
    });
    await evidence.importPreview(ctx, { ...input, requestKey: randomUUID() }, true);
    monitors = (await evidence.monitors(ctx)).monitors as any[];
    expect(monitors.find((x) => x.id === m.id).config.query).toBe('water');
    await expect(
      evidence.importPreview(
        ctx,
        {
          ...input,
          keywords: input.keywords.map((k, i) => (i ? k : { ...k, keyword: 'different' })),
        },
        true,
      ),
    ).rejects.toThrow('IMPORT_REQUEST_CHANGED');
    expect((await editorial.configurations(ctx)).configurations).toHaveLength(5);
  });
  test('unfinished provider window resumes at failed page; manual save/remove survives', async () => {
    const m = ((await evidence.monitors(ctx)).monitors as any[])[0];
    await evidence.configureMonitor(ctx, m.id, {
      expectedVersion: m.version,
      config: {
        ...scope(),
        query: 'water',
        fields: 'title',
        sources: ['example.invalid'],
        scopeAccepted: true,
      },
      state: 'active',
    });
    await folders.withActor(
      ctx,
      (tx) =>
        tx.$executeRaw`UPDATE intel_legiwatch_news_monitor SET baseline_at=now()-interval '3 hours' WHERE id=${m.id}`,
    );
    expect((await evidence.scan(ctx, m.id)).state).toBe('partial');
    pageFailure = false;
    expect((await evidence.scan(ctx, m.id)).state).toBe('complete');
    expect(pages).toEqual([1, 2, 2]);
    const matches = await folders.withActor(
      ctx,
      (tx) =>
        tx.$queryRaw<any[]>`SELECT * FROM intel_legiwatch_news_match WHERE monitor_id=${m.id}`,
    );
    expect(matches).toHaveLength(2);
    const saved = await evidence.track(ctx, {
      ...scope(),
      kind: 'news',
      sourceId: article.id,
      expectedVersion: 0,
      notes: 'Keep manual judgment',
    });
    expect(saved.version).toBe(0);
    await evidence.track(ctx, {
      ...scope(),
      kind: 'news',
      sourceId: article.id,
      expectedVersion: 0,
      removed: true,
      notes: 'Reviewed removal',
    });
    await expect(
      evidence.track(ctx, { ...scope(), kind: 'news', sourceId: article.id, expectedVersion: 0 }),
    ).rejects.toThrow('TRACKING_VERSION_CHANGED');
    await expect(
      evidence.track(ctx, { ...scope(), kind: 'news', sourceId: article2.id, expectedVersion: 4 }),
    ).rejects.toThrow('TRACKING_VERSION_CHANGED');
  });
  const input = () => ({
    ...scope(),
    template: 'morning_news_brief',
    title: 'Private sample edition',
    analysis: 'Attributed reporting [1]. Review the proposal before taking action.',
    timezone: 'America/New_York',
    cutoff: new Date().toISOString(),
    requestKey: randomUUID(),
    sources: [{ kind: 'news', id: article2.id, revision: article2.revision }],
    citations: [
      {
        kind: 'news',
        id: article2.id,
        revision: article2.revision,
        locator: 'available-text',
        start: 0,
        end: String(article2.title).length,
        quote: article2.title,
      },
    ],
  });
  test('RSS replay clears completed windows and advances without duplicate matches or provider calls', async () => {
    const monitor = ((await evidence.monitors(ctx)).monitors as any[]).find(
      (m) => m.state !== 'active',
    );
    await evidence.configureMonitor(ctx, monitor.id, {
      expectedVersion: monitor.version,
      state: 'active',
      config: {
        ...scope(),
        query: 'water',
        provider: 'rss',
        fields: 'title_summary',
        sources: ['example.invalid'],
        scopeAccepted: true,
      },
    });
    await news.retain({
      provider: 'rss',
      url: 'https://example.invalid/rss/' + randomUUID(),
      publisher: 'example.invalid',
      title: 'Water project local hearing',
      summary: 'Published RSS excerpt.',
      rights: 'excerpt',
    });
    await api.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete) VALUES(${randomUUID()},'rss','https://example.invalid/feed',${'a'.repeat(64)},${JSON.stringify({ domain: 'example.invalid' })}::jsonb,${JSON.stringify({ items: 1, retained: 1, history: 'unqualified' })}::jsonb,false)`;
    const before = (global.fetch as jest.Mock).mock.calls.length,
      actualNow = Date.now(),
      clock = jest.spyOn(Date, 'now').mockReturnValue(actualNow + 3600000);
    try {
      const first = await evidence.scan(ctx, monitor.id);
      expect(first).toMatchObject({ state: 'complete', matches: 1 });
      expect(await evidence.scan(ctx, monitor.id)).toEqual(first);
      const replayed = await folders.withActor(ctx, (tx) => evidence.monitor(tx, ctx, monitor.id));
      expect(replayed.pending_window).toBeNull();
      clock.mockReturnValue(actualNow + 2 * 3600000);
      const next = await evidence.scan(ctx, monitor.id);
      expect(next).toMatchObject({ state: 'complete', matches: 1 });
      expect(new Date(String(next.cutoff)).getTime()).toBeGreaterThan(
        new Date(String(first.cutoff)).getTime(),
      );
      const advanced = await folders.withActor(ctx, (tx) => evidence.monitor(tx, ctx, monitor.id));
      expect(advanced.pending_window).toBeNull();
      expect(advanced.checkpoint?.toISOString()).toBe(next.cutoff);
      const matches = await folders.withActor(
        ctx,
        (tx) =>
          tx.$queryRaw<
            any[]
          >`SELECT id FROM intel_legiwatch_news_match WHERE monitor_id=${monitor.id}`,
      );
      expect(matches).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(before);
    const runs = await folders.withActor(
      ctx,
      (tx) =>
        tx.$queryRaw<
          any[]
        >`SELECT receipt FROM intel_legiwatch_news_run WHERE monitor_id=${monitor.id}`,
    );
    expect(runs[0].receipt).toMatchObject({
      provider: 'rss',
      coverage: 'retained_current_feed_only',
      historicalCoverage: 'unqualified',
    });
    const current = await folders.withActor(ctx, (tx) => evidence.monitor(tx, ctx, monitor.id));
    await evidence.configureMonitor(ctx, monitor.id, {
      expectedVersion: current.version,
      state: 'paused',
      config: current.config,
    });
  });
  test('Workspace retries return one draft, preserve edits, and reject changed inputs and wrong actors', async () => {
    const b = input();
    lost = true;
    await expect(editorial.save(ctx, b)).rejects.toThrow('Lost acknowledgement');
    const receipts = await p.$queryRaw<
      any[]
    >`SELECT a.draft_id,s.id FROM ws_source_action a JOIN intel_legiwatch_editorial_selection s ON s.id=a.source_key WHERE s.tenant_id=${tenant} AND s.request_key=${b.requestKey}`;
    expect(receipts).toHaveLength(1);
    await ws.wsDraft.update({
      where: { id: receipts[0].draft_id },
      data: { docTitle: 'Human title' },
    });
    const recovered = (await editorial.save(ctx, b)) as any;
    expect(recovered.draft.draftId).toBe(receipts[0].draft_id);
    expect(recovered.draft.replayed).toBe(true);
    const history = await editorial.history(ctx, {
      clientId: b.clientId,
      folderId: b.folderId,
      limit: 1,
    });
    expect(history.items[0]).toMatchObject({
      selectionId: recovered.selectionId,
      draft: { draftId: recovered.draft.draftId, title: 'Human title' },
    });
    expect(history.draftLookupState).toBe('available');
    const scopedHistory = await editorial.history(ctx, {
      folderId: b.folderId,
      cursor: history.nextCursor ?? undefined,
    });
    expect(
      scopedHistory.items.every(
        (item) => item.selectionId !== recovered.selectionId || !history.nextCursor,
      ),
    ).toBe(true);
    await expect(
      editorial.history({ ...ctx, clerkUserId: 'foreign' }, { folderId: b.folderId }),
    ).rejects.toThrow();
    await expect(
      editorial.history({ ...ctx, tenantId: randomUUID() }, { folderId: b.folderId }),
    ).rejects.toThrow();
    await expect(editorial.save(ctx, { ...b, analysis: 'Changed' })).rejects.toThrow(
      'BRIEFING_REQUEST_CHANGED',
    );
    await expect(
      editorial.source({ ...ctx, clerkUserId: 'foreign' }, recovered.selectionId),
    ).rejects.toThrow();
    await expect(
      editorial.source({ ...ctx, tenantId: randomUUID() }, recovered.selectionId),
    ).rejects.toThrow();
    const preview = await editorial.preview(ctx, {
      selectionId: recovered.selectionId,
      reportId,
      audience: 'internal',
    });
    expect(object(preview.review.outputSnapshot).title).toBe('Human title');
    expect(preview.rendered.html).toContain('<h1>Human title</h1>');
    expect(preview.rendered.html).not.toContain('<pre');
    const run = await editorial.approve(ctx, {
      selectionId: recovered.selectionId,
      reportId,
      audience: 'internal',
      approvalHash: preview.approvalHash,
    });
    await expect(
      delivery.preview(ctx, run.runId, {
        subject: 'Test',
        selection: [{ kind: 'manual', email: 'nobody@example.invalid', role: 'to' }],
      }),
    ).rejects.toThrow('EXTERNAL_REPORT_REQUIRED');
  });
  test('external review requires explicit source-gap acceptance and detects an edited output before approval', async () => {
    const saved = await editorial.save(ctx, input()),
      b = {
        selectionId: saved.selectionId,
        reportId,
        audience: 'external',
        acceptSourceGaps: true,
      };
    await expect(editorial.preview(ctx, { ...b, acceptSourceGaps: false })).rejects.toThrow(
      'REVIEW_SOURCE_GAPS_FOR_DISTRIBUTION',
    );
    const preview = await editorial.preview(ctx, b),
      source = await output.output(saved.selectionId, tenant, actor);
    await ws.wsDraft.update({
      where: { id: source.draftId },
      data: { docTitle: 'Changed after preview' },
    });
    await expect(
      editorial.approve(ctx, { ...b, approvalHash: preview.approvalHash }),
    ).rejects.toThrow('BRIEFING_PREVIEW_CHANGED');
  });
  test('scheduled retry reuses generated claims after remote success; one local-day occurrence', async () => {
    process.env.LEGIWATCH_EDITORIAL_PREPARE_ENABLED = 'true';
    const configs = (await editorial.configurations(ctx)).configurations as any[],
      m = ((await evidence.monitors(ctx)).monitors as any[]).find((x) => x.state === 'active'),
      config = {
        ...scope(),
        template: 'morning_news_brief',
        reportId,
        reportVersion: 0,
        monitorIds: [m.id],
        includedKinds: ['news'],
        prepareEnabled: true,
        sendEnabled: false,
        dictionaryScopeAccepted: true,
        categoryMapping: {},
        schedule: {
          timezone: 'UTC',
          hour: 0,
          minute: 0,
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          noChange: 'skip',
          sourceGap: 'draft',
          mode: 'prepare',
        },
      };
    await folders.withActor(ctx, async (tx) => {
      await tx.$executeRaw`UPDATE intel_legiwatch_editorial_config SET config=${JSON.stringify(config)}::jsonb,state='active' WHERE id=${configs[3].id}`;
      await tx.$executeRaw`UPDATE intel_legiwatch_evidence_tracking SET removed=false,version=version+1 WHERE source_id=${String(article.id)}`;
    });
    const generator = {
      editorialBrief: jest.fn().mockResolvedValue({
        promptVersion: 'test-v1',
        claims: [{ kind: 'analysis', text: 'Review the proposed project.', references: [] }],
      }),
    };
    lost = true;
    const first = await runEditorialWork(editorial, tenant, new Date(Date.now() + 1000), generator);
    expect(first.results.some((r) => String(r.reason).includes('Lost acknowledgement'))).toBe(true);
    await folders.withActor(
      ctx,
      (tx) =>
        tx.$executeRaw`UPDATE intel_legiwatch_editorial_occurrence SET lease_until=now()-interval '1 minute' WHERE tenant_id=${tenant}`,
    );
    const second = await runEditorialWork(
      editorial,
      tenant,
      new Date(Date.now() + 2000),
      generator,
    );
    expect(second.results.find((r) => r.configurationId === configs[3].id)).toMatchObject({
      state: 'complete',
    });
    expect(generator.editorialBrief).toHaveBeenCalledTimes(1);
    await runEditorialWork(editorial, tenant, new Date(Date.now() + 3000), generator);
    expect(generator.editorialBrief).toHaveBeenCalledTimes(1);
    const rows = await folders.withActor(
      ctx,
      (tx) =>
        tx.$queryRaw<
          any[]
        >`SELECT * FROM intel_legiwatch_editorial_occurrence WHERE tenant_id=${tenant}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('complete');
    expect(rows[0].run_id).toBeNull();
  });
  test('scheduled budget generation receives project scope and holds removal during generation', async () => {
    const receiptId = randomUUID(),
      documentId = randomUUID(),
      projectId = randomUUID();
    const title = 'Selected water improvement project',
      revision = 'b'.repeat(64);
    const sections = [
      {
        locator: 'page:1',
        text: 'Selected water improvement project: 20000. Neighbor project: 90000.',
      },
    ];
    await api.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete) VALUES(${receiptId},'test','https://example.invalid/budget',${revision},'{}','{}',true)`;
    await api.$executeRaw`INSERT INTO florida_budget_document(id,publisher,source_url,content_hash,title,fiscal_year,session_key,chamber,stage,role,receipt_id,sections,complete) VALUES(${documentId},'Test legislature',${'https://example.invalid/' + documentId},${revision},'Test budget','2026-27',${session},'House','proposed','comparison',${receiptId},${JSON.stringify(sections)}::jsonb,true)`;
    await api.$executeRaw`INSERT INTO florida_budget_project(id,fiscal_year,title,identities,evidence) VALUES(${projectId},'2026-27',${title},'[]','{}')`;
    await api.$executeRaw`INSERT INTO florida_budget_amount(id,project_id,document_id,observation) VALUES(${randomUUID()},${projectId},${documentId},${JSON.stringify({ projectId, documentId, sourceRevision: revision, locator: 'page:1;project:1', measure: 'money', currency: 'USD', qualified: true, state: 'amount', minorUnits: '2000000', chamber: 'House', fund: 'General Revenue' })}::jsonb)`;
    const tracking = await evidence.track(ctx, {
      ...scope(),
      kind: 'budget',
      sourceId: projectId,
      expectedVersion: 0,
    });
    const configs = (await editorial.configurations(ctx)).configurations as any[],
      selected = configs[2];
    const config = {
      ...scope(),
      template: 'research_update',
      reportId,
      reportVersion: 0,
      monitorIds: [],
      includedKinds: ['budget'],
      prepareEnabled: true,
      sendEnabled: false,
      schedule: {
        timezone: 'UTC',
        hour: 0,
        minute: 0,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        noChange: 'skip',
        sourceGap: 'draft',
        mode: 'prepare',
      },
    };
    await folders.withActor(ctx, async (tx) => {
      await tx.$executeRaw`UPDATE intel_legiwatch_editorial_config SET state='paused' WHERE tenant_id=${tenant}`;
      await tx.$executeRaw`UPDATE intel_legiwatch_editorial_config SET state='active',config=${JSON.stringify(config)}::jsonb WHERE id=${selected.id}`;
    });
    const generator = {
      editorialBrief: jest.fn().mockImplementation(async (_tenant, _actor, inputs) => {
        expect(inputs.clientContext).toContain(projectId);
        expect(inputs.clientContext).toContain(title);
        expect(inputs.sources[0].text).toContain('USD 20,000.00');
        expect(inputs.sources[0].text).toContain('General Revenue');
        expect(inputs.sources[0].text).toContain(revision);
        expect(inputs.clientContext).not.toContain('Neighbor project');
        expect(inputs.sources[0].text).not.toContain('Neighbor project');
        await evidence.track(ctx, {
          ...scope(),
          kind: 'budget',
          sourceId: projectId,
          expectedVersion: tracking.version,
          removed: true,
        });
        return {
          promptVersion: 'test-v1',
          claims: [{ kind: 'analysis', text: 'Review this project.', references: [] }],
        };
      }),
    };
    const result = await runEditorialWork(
      editorial,
      tenant,
      new Date(Date.now() + 1000),
      generator,
    );
    expect(generator.editorialBrief).toHaveBeenCalledTimes(1);
    expect(result.results.find((r) => r.configurationId === selected.id)).toMatchObject({
      state: 'held',
      reason: 'SELECTED_PROJECT_TRACKING_CHANGED',
    });
    const selections = await folders.withActor(
      ctx,
      (tx) =>
        tx.$queryRaw<
          any[]
        >`SELECT s.id FROM intel_legiwatch_editorial_selection s JOIN intel_legiwatch_editorial_occurrence o ON o.id=s.request_key WHERE o.config_id=${selected.id}`,
    );
    expect(selections).toHaveLength(0);
  });
  test('current memory-wall membership gates dashboard context and scoped evidence', async () => {
    const clientId = randomUUID(),
      dashboard = new NewsCatcherDashboardService(api);
    const user = await api.user.findUniqueOrThrow({ where: { clerkUserId: actor } });
    await api.client.create({
      data: {
        id: clientId,
        tenantId: tenant,
        name: 'Private water project client',
        memoryWall: true,
      },
    });
    expect(await dashboard.allowedNewsClients(tenant, actor)).toEqual([]);
    await expect(evidence.news(ctx, { clientId })).rejects.toThrow();
    const mapping = await api.clientMemoryAccess.create({
      data: { tenantId: tenant, clientId, userId: user.id },
    });
    expect((await dashboard.allowedNewsClients(tenant, actor)).map((x) => x.id)).toContain(
      clientId,
    );
    await evidence.news(ctx, { clientId });
    await api.clientMemoryAccess.delete({ where: { id: mapping.id } });
    expect(await dashboard.allowedNewsClients(tenant, actor)).toEqual([]);
    await expect(evidence.news(ctx, { clientId })).rejects.toThrow();
  });
  test('editorial delivery uses the existing queue, records one accepted attempt, and holds changed output', async () => {
    process.env.LEGIWATCH_EDITORIAL_SEND_ENABLED = 'true';
    const saved = await editorial.save(ctx, input()),
      review = {
        selectionId: saved.selectionId,
        reportId,
        audience: 'external',
        acceptSourceGaps: true,
      };
    const preview = await editorial.preview(ctx, review),
      run = await editorial.approve(ctx, { ...review, approvalHash: preview.approvalHash });
    const body = {
      subject: 'Synthetic exact-edition test',
      selection: [{ kind: 'manual', email: 'nobody@example.invalid', role: 'bcc' }],
    };
    const composed = await delivery.preview(ctx, run.runId, body);
    const sender = delivery.email.sendReport as jest.Mock;
    sender.mockResolvedValue({ outcome: 'accepted', messageId: 'synthetic-provider-receipt' });
    const queued = await delivery.approve(ctx, run.runId, {
      ...body,
      approvalHash: composed.approvalHash,
    });
    await delivery.drain(tenant, 25, new Date(), 'editorial_brief');
    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender.mock.calls[0][0]).toBe('nobody@example.invalid');
    const receipt = await p.withTenant(tenant, (tx) =>
      tx.legiWatchDeliveryRecipient.findFirstOrThrow({ where: { deliveryId: queued.id } }),
    );
    expect(receipt.state).toBe('provider_accepted');
    expect(receipt.providerId).toBe('synthetic-provider-receipt');
    await delivery.drain(tenant, 25, new Date(), 'editorial_brief');
    expect(sender).toHaveBeenCalledTimes(1);
    const next = await delivery.enqueue(
      ctx,
      composed.composition,
      'synthetic-edited-output:' + randomUUID(),
    );
    const draft = await output.output(saved.selectionId, tenant, actor);
    await ws.wsDraft.update({
      where: { id: draft.draftId },
      data: { docTitle: 'Edited after queue approval' },
    });
    await delivery.drain(tenant, 25, new Date(), 'editorial_brief');
    const held = await p.withTenant(tenant, (tx) =>
      tx.legiWatchDeliveryRecipient.findFirstOrThrow({ where: { deliveryId: next.id } }),
    );
    expect(held.state).toBe('held');
    expect(held.error).toContain('EDITORIAL_OUTPUT_CHANGED');
    expect(sender).toHaveBeenCalledTimes(1);
    delete process.env.LEGIWATCH_EDITORIAL_SEND_ENABLED;
  });
  test('article correction retains the old source and retry cannot roll current evidence backward', async () => {
    const saved = await editorial.save(ctx, input());
    const corrected = await news.retain({
      provider: 'test',
      url: String(article2.original_url),
      publisher: String(article2.publisher),
      title: 'Corrected proposal title',
      publishedAt: '2026-09-02T00:00:00Z',
      rights: 'headline_link',
    });
    expect(corrected.article_id).toBe(article2.article_id);
    expect(corrected.id).not.toBe(article2.id);
    expect((await editorial.source(ctx, saved.selectionId)).stale).toBe(true);
    await news.retain({
      provider: 'test',
      url: String(article2.original_url),
      publisher: String(article2.publisher),
      title: String(article2.title),
      publishedAt: '2026-09-02T00:00:00Z',
      rights: 'headline_link',
    });
    const rows = await p.$queryRaw<
      any[]
    >`SELECT * FROM legiwatch_news_source WHERE article_id=${String(article2.article_id)}`;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.is_current).id).toBe(corrected.id);
    await expect(
      p.$executeRaw`UPDATE legiwatch_news_observation SET title='rewritten' WHERE id=${String(article2.id)}`,
    ).rejects.toThrow();
  });
});
