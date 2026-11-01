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
import { DraftAccessService } from '../src/tracker/delivery/draft-access.service.js';
import { RecipientsService } from '../src/tracker/delivery/recipients.service.js';
import { DeliveryService } from '../src/tracker/delivery/delivery.service.js';
import { KeywordRuleService } from '../src/tracker/keywords/keyword-rule.service.js';
import { ResearchService } from '../src/tracker/research/research.service.js';
import { RetainedSourceReaderService } from '../src/tracker/editorial/retained-source-reader.service.js';
import {
  loadPublisherIntakeReceipts,
  publisherIntakeEndpoints,
} from '../src/tracker/editorial/publisher-coverage.js';
import { Phase8EvidenceService } from '../src/tracker/editorial/evidence.service.js';
import { EditorialService } from '../src/tracker/editorial/editorial.service.js';
import { runEditorialWork } from '../src/tracker/editorial/editorial-runtime.js';
import { discoverEditorialWork } from '../src/tracker/editorial/editorial-discovery.js';
import { digest, object } from '../src/tracker/delivery/delivery-domain.js';
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
    reports = new DraftAccessService(folders, flags),
    recipients = new RecipientsService(reports);
  const keywords = new KeywordRuleService(reports, new KeywordSourceRepository(p)),
    research = new ResearchService(keywords),
    evidence = new Phase8EvidenceService(research),
    retained = new RetainedSourceReaderService(evidence);
  const delivery = new DeliveryService(reports, recipients, {
      sendReport: jest.fn(),
    } as never),
    editorial = new EditorialService(evidence, recipients, delivery);
  const drafts = new DraftsService(ws, new CollaboratorsService(ws, {} as never)),
    output = new EditorialDraftSourceController(drafts, ws),
    news = new NewsEvidenceService(api);
  const tenant = randomUUID(),
    actor = 'p8-' + randomUUID(),
    ctx = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' },
    session = 'p8-' + randomUUID().slice(0, 8),
    billId = randomUUID(),
    documentId = randomUUID(),
    revision = digest('research-source'),
    researchText = 'Section 1. A legislative proposal requires review.';
  let folderId = '',
    lost = false,
    article2: Record<string, unknown>;
  const beforeFetch = global.fetch,
    beforeEnv = { ...process.env };
  const scope = () => ({ jurisdiction: 'FL', sessionKey: session, clientId: null, folderId });
  it('reads current public bill status in a bounded batch without changing retained evidence', async () => {
    const id = `119-hr-${Date.now()}`;
    await api.$executeRaw`INSERT INTO congress_bill(id,congress,bill_type,bill_number,title,status,status_at,origin_chamber) VALUES(${id},119,'hr','99999','Synthetic current-status fixture','passed_chamber','2026-07-22'::timestamptz,'House')`;
    try {
      const rows = await new SourceDataRepository(p).getFeedBillStatuses([
        id,
        id,
        "'; DROP TABLE congress_bill; --",
        'fl-2026-h1211',
      ]);
      expect(rows).toEqual([
        {
          id,
          status: 'passed_chamber',
          statusAt: new Date('2026-07-22T00:00:00Z'),
          originChamber: 'House',
        },
      ]);
    } finally {
      await api.$executeRaw`DELETE FROM congress_bill WHERE id=${id}`;
    }
  });
  it('filters budget update events by the exact selected legislative session', async () => {
    const receiptId = randomUUID(),
      projectId = randomUUID(),
      wantedEvent = randomUUID(),
      otherEvent = randomUUID();
    await api.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,content_hash,scope,manifest,complete) VALUES(${receiptId},'test','https://example.invalid/session-test','test','{}','{}',true)`;
    await api.$executeRaw`INSERT INTO florida_budget_project(id,fiscal_year,title,identities,evidence) VALUES(${projectId},'2026-27','Session fixture','[]','{}')`;
    for (const [sessionKey, eventId] of [
      [session, wantedEvent],
      [session + '-other', otherEvent],
    ]) {
      const documentId = randomUUID();
      await api.$executeRaw`INSERT INTO florida_budget_document(id,publisher,source_url,content_hash,title,fiscal_year,session_key,chamber,stage,role,receipt_id,sections,complete) VALUES(${documentId},'Test',${'https://example.invalid/' + documentId},'test','Session budget','2026-27',${sessionKey},'House','chamber_proposal','comparison',${receiptId},'[]',true)`;
      await api.$executeRaw`INSERT INTO florida_budget_event(id,project_id,document_id,kind,payload) VALUES(${eventId},${projectId},${documentId},'new_document','{}')`;
    }
    const result = await evidence.budget(ctx, { ...scope(), fiscalYear: '2026-27', projectId });
    expect((result.events as Array<{ id: string }>).map((row) => row.id)).toEqual([wantedEvent]);
  });
  it('discovers current scheduled work past a full retired batch without bypassing owner RLS', async () => {
    const configId = randomUUID(),
      foreignId = randomUUID(),
      current = {
        policyVersion: 2,
        template: 'research_update',
        includedKinds: ['research'],
      },
      retiredConfigs = [
        { ...current, policyVersion: undefined },
        { ...current, policyVersion: 1 },
        { ...current, policyVersion: '2' },
        { ...current, template: 'morning_news_brief' },
        { ...current, template: ['research_update'] },
        { ...current, includedKinds: ['news'] },
        { ...current, includedKinds: ['research', 'news'] },
        { ...current, includedKinds: ['research', 'research'] },
        { ...current, reportId: null },
        { ...current, reportVersion: null },
        { ...current, monitorIds: [] },
        { ...current, categoryMapping: {} },
      ],
      retiredIds = retiredConfigs.map(() => randomUUID());
    try {
      for (const [index, retired] of retiredConfigs.entries()) {
        const id = retiredIds[index];
        await p.$executeRaw`INSERT INTO intel_legiwatch_editorial_config(id,tenant_id,owner_clerk_id,source_key,source,config,state) VALUES(${id},${tenant},${actor},${id},'{}',${JSON.stringify(retired)}::jsonb,'active')`;
      }
      // Retired rows have NULL attempts and would fill the batch before this current row.
      await p.$executeRaw`INSERT INTO intel_legiwatch_editorial_config(id,tenant_id,owner_clerk_id,source_key,source,config,state,last_attempt_at) VALUES(${configId},${tenant},${actor},${configId},'{}',${JSON.stringify(current)}::jsonb,'active',now()),(${foreignId},${randomUUID()},${actor},${foreignId},'{}',${JSON.stringify(current)}::jsonb,'active',NULL)`;
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
          >`SELECT id FROM intel_legiwatch_editorial_config WHERE id=${configId}`,
      );
      expect(invisible).toEqual([]);
      const found = await discoverEditorialWork(restricted, tenant);
      expect(found.configurations.map((c) => c.id)).toEqual([configId]);
      const retired = await p.$queryRaw<Array<{ id: string; state: string; config: unknown }>>`
        SELECT id,state,config FROM intel_legiwatch_editorial_config WHERE id=ANY(${retiredIds}::text[])
      `;
      expect(retired).toHaveLength(12);
      for (const [index, config] of retiredConfigs.entries())
        expect(retired.find((row) => row.id === retiredIds[index])).toEqual({
          id: retiredIds[index],
          state: 'active',
          config: JSON.parse(JSON.stringify(config)),
        });
      const unscoped = await restricted.withTenant(
        tenant,
        (tx) =>
          tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT id FROM intel_legiwatch_editorial_config WHERE id=${configId}`,
      );
      expect(unscoped).toEqual([]);
    } finally {
      await p.$executeRaw`DELETE FROM intel_legiwatch_editorial_config WHERE id=ANY(${[configId, foreignId, ...retiredIds]}::text[])`;
    }
  });

  it('reads latest exact publisher receipts under the real application role, preserving endpoint failures', async () => {
    const rollback = new Error('Rollback immutable receipt fixtures');
    const fixtureIds: string[] = [];
    try {
      await p.$transaction(async (tx) => {
        const hill = publisherIntakeEndpoints.find((e) => e.slug === 'the_hill')!;
        const politics = publisherIntakeEndpoints.find((e) => e.slug === 'politico')!;
        const congress = publisherIntakeEndpoints.find((e) => e.slug === 'politico_congress')!;
        const insert = async (
          slug: string,
          url: string,
          at: string,
          status: string,
          source = 'rss',
        ) => {
          const id = randomUUID();
          fixtureIds.push(id);
          const scope = JSON.stringify({ publisher: slug });
          const manifest = JSON.stringify({
            status,
            coverage: 'current_feed_only',
            retained: 0,
            rejected: 0,
            ...(status === 'failed' ? { reason: 'HTTP 403' } : {}),
          });
          await tx.$executeRaw`INSERT INTO legiwatch_source_receipt(id,source,source_url,observed_at,content_hash,scope,manifest,complete) VALUES(${id},${source},${url},${at}::timestamptz,'fixture',${scope}::jsonb,${manifest}::jsonb,false)`;
          return id;
        };
        const oldHill = await insert(hill.slug, hill.url, '2099-01-01T00:00:00Z', 'retained');
        const failedHill = await insert(hill.slug, hill.url, '2099-01-02T00:00:00Z', 'failed');
        const goodPolitics = await insert(
          politics.slug,
          politics.url,
          '2099-01-02T00:00:00Z',
          'retained',
        );
        const failedCongress = await insert(
          congress.slug,
          congress.url,
          '2099-01-02T00:00:00Z',
          'failed',
        );
        // Newer receipts for the wrong identity, endpoint or producer must not win.
        await insert('wrong-publisher', hill.url, '2099-01-03T00:00:00Z', 'retained');
        await insert(hill.slug, hill.url + '?different=1', '2099-01-03T00:00:00Z', 'retained');
        await insert(hill.slug, hill.url, '2099-01-03T00:00:00Z', 'retained', 'unverified');
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        const receipts = await loadPublisherIntakeReceipts(tx);
        expect(receipts.map((r) => r.id)).toEqual(
          expect.arrayContaining([failedHill, goodPolitics, failedCongress]),
        );
        expect(receipts.map((r) => r.id)).not.toContain(oldHill);
        expect(receipts.filter((r) => r.scope.publisher === hill.slug)).toHaveLength(1);
        const coverage = reconcilePublisherCoverage(
          [
            { publisher: 'The Hill', status: 'unavailable' },
            { publisher: 'Politico', status: 'unavailable' },
          ],
          [],
          receipts,
        );
        expect(coverage[0]).toMatchObject({ status: 'unavailable', intake: { status: 'failed' } });
        expect(coverage[1]).toMatchObject({ status: 'unavailable', intake: { status: 'partial' } });
        expect(coverage[1]!.intake.feeds.map((f) => f.status)).toEqual(['succeeded', 'failed']);
        // Receipts are immutable, including in the fully migrated test database.
        // Roll back the whole fixture transaction instead of deleting evidence.
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
    const remaining = await p.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT COUNT(*) AS count FROM legiwatch_source_receipt WHERE id=ANY(${fixtureIds}::text[])`;
    expect(remaining[0].count).toBe(0n);
  });

  it('reconciles publisher articles across pages without converting configured unavailability to health', async () => {
    const publisher = `coverage-${randomUUID()}.invalid`,
      coverageId = randomUUID();
    await api.$executeRaw`INSERT INTO legiwatch_source_coverage(id,publisher,source_group,source_url,status,evidence,owner) VALUES(${coverageId},${publisher},'regional',${`https://${publisher}/feed`},'unavailable','{}','test')`;
    for (let i = 0; i < 2; i++)
      await news.retain({
        provider: 'test',
        url: `https://${publisher}/${i}`,
        publisher,
        title: 'Retained reporting',
        publishedAt: new Date().toISOString(),
        rights: 'headline_link',
      });
    const result = await retained.news(ctx, { ...scope(), days: 1, limit: 1, publisher });
    expect(result.items).toHaveLength(1);
    expect(result.coverage.find((row) => row.id === coverageId)).toMatchObject({
      status: 'unavailable',
      retained: { articles: 2, fullTextArticles: 0 },
    });
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
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name,status) VALUES(${tenant}::uuid,${tenant},'Synthetic Phase 8','active')`;
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
      for (const feature of [
        'legiwatch_folder_tracker_v1',
        'legiwatch_news_v1',
        'legiwatch_research_v1',
        'legiwatch_florida_budget_v1',
        'legiwatch_editorial_v1',
      ])
        await tx.featureFlag.create({ data: { tenantId: tenant, feature, enabled: true } });
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES(${billId},'FL',${session},${session},'HB 8','HB8','Synthetic Phase 8')`;
    });
    const sourceEvidence = {
      documentKind: 'text',
      title: 'Synthetic selected research',
      url: 'https://www.flsenate.gov/',
      contentHash: revision,
      parserVersion: 'test-v1',
      extractionState: 'extracted',
      coverage: 'selected_passages',
      sections: [{ locator: 'page:1', text: researchText, hash: revision }],
    };
    await p.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence) VALUES(${documentId}::uuid,${billId},'document','source8',${revision},'2026-01-01',0,${JSON.stringify(sourceEvidence)}::jsonb)`;
    await p.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id) VALUES(${billId + ':source8'},${documentId}::uuid)`;
    folderId = (
      await folders.create(ctx, {
        name: 'Phase 8 private pilot',
        jurisdiction: 'FL',
        defaultSession: session,
      })
    ).id;
    await folders.withActor(ctx, (tx) =>
      tx.legiWatchFolderBill.create({
        data: {
          tenantId: tenant,
          folderId,
          billId,
          sessionKey: session,
          jurisdiction: 'FL',
          updatedBy: actor,
        },
      }),
    );
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
    });
    global.fetch = jest.fn(async (raw, init) => {
      const url = new URL(String(raw));
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
  const input = () => ({
    ...scope(),
    template: 'research_update',
    title: 'Private sample edition',
    analysis: 'Attributed reporting [1]. Review the proposal before taking action.',
    timezone: 'America/New_York',
    cutoff: new Date().toISOString(),
    requestKey: randomUUID(),
    sources: [{ kind: 'research', id: documentId, revision }],
    citations: [
      {
        kind: 'research',
        id: documentId,
        revision,
        locator: 'page:1',
        start: 0,
        end: researchText.length,
        quote: researchText,
      },
    ],
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
      audience: 'internal',
    });
    expect(object(preview.review.outputSnapshot).title).toBe('Human title');
    expect(preview.rendered.html).toContain('<h1>Human title</h1>');
    expect(preview.rendered.html).not.toContain('<pre');
    const run = await editorial.approve(ctx, {
      selectionId: recovered.selectionId,
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
    const configId = randomUUID(),
      config = {
        ...scope(),
        policyVersion: 2,
        template: 'research_update',
        includedKinds: ['research'],
        prepareEnabled: true,
        sendEnabled: false,
        dictionaryScopeAccepted: true,
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
    await folders.withActor(
      ctx,
      (tx) =>
        tx.$executeRaw`INSERT INTO intel_legiwatch_editorial_config(id,tenant_id,owner_clerk_id,source_key,source,config,state) VALUES(${configId},${tenant},${actor},${configId},'{}',${JSON.stringify(config)}::jsonb,'active')`,
    );
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
    expect(second.results.find((r) => r.configurationId === configId)).toMatchObject({
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
    await expect(retained.news(ctx, { clientId })).rejects.toThrow();
    const mapping = await api.clientMemoryAccess.create({
      data: { tenantId: tenant, clientId, userId: user.id },
    });
    expect((await dashboard.allowedNewsClients(tenant, actor)).map((x) => x.id)).toContain(
      clientId,
    );
    await retained.news(ctx, { clientId });
    await api.clientMemoryAccess.delete({ where: { id: mapping.id } });
    expect(await dashboard.allowedNewsClients(tenant, actor)).toEqual([]);
    await expect(retained.news(ctx, { clientId })).rejects.toThrow();
  });
  test('editorial delivery uses the existing queue, records one accepted attempt, and holds changed output', async () => {
    process.env.LEGIWATCH_EDITORIAL_SEND_ENABLED = 'true';
    const saved = await editorial.save(ctx, input()),
      review = {
        selectionId: saved.selectionId,
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
    expect(
      (await folders.withActor(ctx, (tx) => evidence.exact(tx, 'news', String(article2.id))))
        .revision,
    ).toBe(article2.revision);
    expect((await editorial.source(ctx, saved.selectionId)).stale).toBe(false);
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
