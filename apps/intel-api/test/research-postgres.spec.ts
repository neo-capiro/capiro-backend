import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PrismaService as WorkspacePrisma } from '../../workspace/src/prisma/prisma.service.js';
import { DraftsService } from '../../workspace/src/drafts/drafts.service.js';
import { CollaboratorsService } from '../../workspace/src/collaborators/collaborators.service.js';
import { ResearchDraftSourceController } from '../../workspace/src/drafts/research-source.controller.js';
import { ResearchReportService } from '../src/tracker/research/research-report.service.js';
import { ResearchDeadlineService } from '../src/tracker/research/research-deadline.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { KeywordSourceRepository } from '../src/sourcedata/keyword-source.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { KeywordRuleService } from '../src/tracker/keywords/keyword-rule.service.js';
import { ResearchService } from '../src/tracker/research/research.service.js';
import { ResearchImportService } from '../src/tracker/research/research-import.service.js';
import { StatuteMonitorService } from '../src/tracker/research/statute-monitor.service.js';
import { CalendarPreparationService } from '../src/tracker/calendar/calendar-preparation.service.js';
import { InternalWorkflowService } from '../src/tracker/keywords/internal-workflow.service.js';
import { hash } from '../src/tracker/folders/folder-tracker.service.js';
jest.setTimeout(60000);
describe('Phase 7 exact research, tenant boundaries and durable Workspace receipts', () => {
  const p = new PrismaService(),
    ws = new WorkspacePrisma();
  const folders = new FolderTrackerService(
    p,
    new FolderSourceDataRepository(p),
    new SourceDataRepository(p),
  );
  const flags = new FeatureFlagService(p, new ConfigService()),
    reports = new ReportService(folders, flags);
  const keywords = new KeywordRuleService(reports, new KeywordSourceRepository(p)),
    research = new ResearchService(keywords);
  const collaborators = new CollaboratorsService(ws, {} as never),
    drafts = new DraftsService(ws, collaborators),
    actions = new InternalWorkflowService(
      keywords,
      new CalendarPreparationService(folders, flags),
      undefined,
      research,
    );
  const tenant = randomUUID(),
    actor = 'p7-' + randomUUID(),
    bill = 'FL-test-' + randomUUID(),
    session = 'p7-' + randomUUID().slice(0, 8),
    ids = [randomUUID(), randomUUID()];
  const ctx = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  let folderId: string,
    fetchBefore = global.fetch,
    lost = false;
  const scope = () => ({ jurisdiction: 'FL', sessionKey: session, folderId, clientId: null });
  const revision = (i: number) => hash('research-' + i),
    text = (i: number) =>
      i
        ? 'Section 1. Section 395.003, Florida Statutes, is amended.'
        : 'Historical-only phrase\nSection 1. Section 395.003, Florida Statutes, is repealed.';
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE7_TEST_DATABASE !== 'disposable' ||
      !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
    )
      throw Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
    await p.$connect();
    await ws.$connect();
    await p.withSystem(async (tx) => {
      const user = randomUUID();
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${tenant},'Synthetic Phase 7 research')`;
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
      for (const feature of [
        'legiwatch_research_v1',
        'legiwatch_internal_workflows_v1',
        'legiwatch_reports_updates_v1',
        'legiwatch_state_calendar_v1',
      ])
        await tx.featureFlag.create({ data: { tenantId: tenant, feature, enabled: true } });
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title) VALUES(${bill},'FL',${session},${session},'HB 7','HB7','Synthetic research')`;
      for (const [i, id] of ids.entries()) {
        const evidence = {
          documentKind: 'text',
          title: 'Synthetic version ' + i,
          url: 'https://www.flsenate.gov/',
          contentHash: hash(text(i)),
          parserVersion: 'test-paragraph-v1',
          extractionState: 'extracted',
          coverage: 'complete_document',
          sections: [{ locator: 'page:1', text: text(i), hash: hash(text(i)) }],
        };
        await tx.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence) VALUES(${id}::uuid,${bill},'document','source7',${revision(i)},'2026-01-01',0,${JSON.stringify(evidence)}::jsonb)`;
        await tx.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id) VALUES(${bill + ':source7'},${id}::uuid)`;
      }
    });
    folderId = (
      await folders.create(ctx, {
        name: 'Synthetic research folder',
        jurisdiction: 'FL',
        defaultSession: session,
      })
    ).id;
    process.env.WORKSPACE_BASE_URL = 'https://workspace.example.invalid';
    process.env.INTEL_API_BASE_URL = 'https://intel.example.invalid';
    process.env.INTERNAL_SERVICE_SECRET = 'test-only';
    process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED = 'true';
    global.fetch = jest.fn(async (_url, init) => {
      const url = new URL(String(_url));
      if (url.pathname.endsWith('/access'))
        return {
          ok: true,
          json: async () =>
            research.researchAccess(
              {
                tenantId: url.searchParams.get('tenantId')!,
                clerkUserId: url.searchParams.get('ownerId')!,
                role: null,
              },
              url.pathname.split('/').at(-2)!,
            ),
        } as Response;
      if (url.pathname.endsWith('/output'))
        return {
          ok: true,
          json: async () =>
            new ResearchDraftSourceController(drafts, ws).output(
              url.pathname.split('/').at(-2)!,
              url.searchParams.get('tenantId')!,
              url.searchParams.get('ownerId')!,
            ),
        } as Response;
      const b = JSON.parse(String(init!.body));
      const source = await research.researchSource(ctx, b.actionId);
      const result = await drafts.createResearch(
        b.tenantId,
        b.ownerId,
        b.actionId,
        source.prefill as never,
      );
      if (lost) {
        lost = false;
        throw Error('Lost acknowledgement after commit');
      }
      return { ok: true, json: async () => result } as Response;
    });
  });
  afterAll(async () => {
    global.fetch = fetchBefore;
    delete process.env.WORKSPACE_BASE_URL;
    delete process.env.INTEL_API_BASE_URL;
    delete process.env.INTERNAL_SERVICE_SECRET;
    delete process.env.LEGIWATCH_INTERNAL_WORKFLOWS_ENABLED;
    await p.$disconnect();
    await ws.$disconnect();
  });
  test('retains superseded versions and never asserts complete negative coverage', async () => {
    const result = await research.search(ctx, { ...scope(), query: '"Historical-only phrase"' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe(ids[0]);
    expect(result.items[0]!.isCurrent).toBe(false);
    expect(result.coverage.complete).toBe(false);
    expect(
      (
        await research.search(ctx, {
          ...scope(),
          query: '"Historical-only phrase"',
          versionPolicy: 'current_extractions',
        })
      ).items,
    ).toHaveLength(0);
    expect((await research.versions(ctx, { ...scope(), billId: bill })).versions).toHaveLength(2);
  });
  test('exact pair revision checks and live feature authorization reject stale/direct IDs', async () => {
    const pair = {
      ...scope(),
      leftId: ids[0],
      rightId: ids[1],
      leftRevision: revision(0),
      rightRevision: revision(1),
    };
    expect((await research.compare(ctx, pair)).changes.some((c) => c.kind === 'removed')).toBe(
      true,
    );
    await expect(research.compare(ctx, { ...pair, rightRevision: 'not-current' })).rejects.toThrow(
      'EXACT_REVISION_REQUIRED',
    );
    await expect(
      research.compare({ ...ctx, clerkUserId: 'foreign-actor' }, pair),
    ).rejects.toThrow();
    await expect(research.compare({ ...ctx, tenantId: randomUUID() }, pair)).rejects.toThrow();
  });
  const saveInput = () => ({
    ...scope(),
    requestKey: randomUUID(),
    title: 'Synthetic research memo',
    analysis: 'Review this source change.',
    documents: [{ id: ids[1], revision: revision(1) }],
    citations: [
      {
        documentId: ids[1],
        revision: revision(1),
        locator: 'page:1',
        start: 0,
        end: 9,
        quote: text(1).slice(0, 9),
      },
    ],
  });
  test('validates quote offsets and source revision before creating private work', async () => {
    const b = saveInput();
    b.citations[0]!.quote = 'fabricated';
    await expect(research.saveResearch(ctx, b)).rejects.toThrow(
      'CITATION_DOES_NOT_MATCH_SELECTED_SOURCE',
    );
  });
  test('recovers remote success after lost acknowledgement without replacing human edits', async () => {
    const b = saveInput();
    lost = true;
    await expect(research.saveResearch(ctx, b)).rejects.toThrow('Lost acknowledgement');
    const [receipt] = await p.$queryRaw<
      Array<{ draft_id: string }>
    >`SELECT a.draft_id FROM ws_source_action a JOIN intel_legiwatch_research_selection s ON s.id=a.source_key WHERE s.tenant_id=${tenant} AND s.request_key=${b.requestKey}`;
    expect(receipt).toBeDefined();
    await ws.wsDraft.update({
      where: { id: receipt!.draft_id },
      data: { docTitle: 'Human edit retained' },
    });
    const recovered = await research.saveResearch(ctx, b);
    expect((recovered as any).draft.draftId).toBe(receipt!.draft_id);
    expect((recovered as any).draft.replayed).toBe(true);
    expect(
      (await ws.wsDraft.findUniqueOrThrow({ where: { id: receipt!.draft_id } })).docTitle,
    ).toBe('Human edit retained');
    await expect(
      research.saveResearch(ctx, { ...b, analysis: 'Different request' }),
    ).rejects.toThrow('RESEARCH_REQUEST_CHANGED');
    await expect(
      research.researchSource({ ...ctx, clerkUserId: 'foreign' }, recovered.selectionId),
    ).rejects.toThrow();
  });
  test('the leased legal adapter reuses the same research output', async () => {
    const saved = await research.saveResearch(ctx, saveInput());
    const preview = await actions.preview(ctx, {
      template: 'legal_research',
      selectionId: saved.selectionId,
      folderIds: [folderId],
      jurisdiction: 'FL',
      sessionKey: session,
    });
    const action = await actions.enqueue(ctx, {
      input: preview.input,
      inputHash: preview.inputHash,
      requestKey: randomUUID(),
    });
    const result = await actions.execute(ctx, action.id);
    expect(result.state).toBe('complete');
    expect(result.steps.draftId).toBe((saved as any).draft.draftId);
    expect((await actions.execute(ctx, action.id)).steps.draftId).toBe(result.steps.draftId);
  });
  test('legal import retries retain one source membership and preserve a manual removal', async () => {
    const importer = new ResearchImportService(research),
      referenceId = 'synthetic-reference-' + randomUUID(),
      revisionId = randomUUID(),
      sourceAccount = 'synthetic-p7-' + randomUUID();
    const raw = {
      folder_id: 'source-folder',
      statute_label: 'Sec. 395.003',
      title: 'Synthetic title',
      statute_url: '',
    };
    const staged = await p.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO legal_reference(id,jurisdiction,code_kind,reference_kind,chapter,section,identity) VALUES(${referenceId},'FL','statute','section','395','395.003','{"jurisdiction":"FL","code":"statute","kind":"section","chapter":"395","section":"395.003","subdivisions":[]}'::jsonb)`;
      await tx.$executeRaw`INSERT INTO legal_text_revision(id,reference_id,edition,source_url,content_hash,extraction_hash,parser_version,title,sections,complete,coverage) VALUES(${revisionId},${referenceId},'2026','https://www.flsenate.gov/','fixture','fixture','fixture','Synthetic fixture','[]'::jsonb,true,'{}'::jsonb)`;
      await tx.legiWatchSourceMapping.create({
        data: {
          tenantId: tenant,
          sourceAccount,
          kind: 'folder',
          sourceId: 'source-folder',
          targetId: folderId,
          sourceHash: 'fixture',
          targetVersion: 0,
          runId: randomUUID(),
        },
      });
      return tx.legiWatchStagedConfiguration.create({
        data: {
          tenantId: tenant,
          sourceAccount,
          kind: 'statute',
          sourceId: 'source-membership',
          payload: raw,
          provenance: { captureId: 'synthetic' },
        },
      });
    });
    const request = {
      ...scope(),
      stagedId: staged.id,
      sourceHash: hash(staged.payload),
      expectedVersion: staged.version,
      status: 'imported',
      reason: 'Synthetic explicit mapping',
      requestKey: randomUUID(),
      edition: '2026',
      referenceId,
      revisionId,
      resolutionBasis: 'Synthetic test fixture',
      expectedMembershipVersion: 0,
    };
    const first: any = await importer.decide(ctx, request);
    expect(first.status).toBe('imported');
    expect(first.targetVersion).toBe(1);
    expect(await importer.decide(ctx, request)).toEqual(first);
    await research.saveMembership(ctx, {
      ...scope(),
      referenceId,
      remove: true,
      expectedVersion: 1,
      requestKey: randomUUID(),
    });
    const retried: any = await importer.decide(ctx, {
      ...request,
      requestKey: randomUUID(),
      expectedMembershipVersion: 2,
    });
    expect(retried).toMatchObject({ status: 'unresolved', reason: 'MANUAL_REMOVAL_PRESERVED' });
    const [membership] = await p.$queryRaw<
      Array<{ removed: boolean; source_memberships: unknown[] }>
    >`SELECT removed,source_memberships FROM intel_legiwatch_legal_membership WHERE tenant_id=${tenant} AND folder_id=${folderId} AND reference_id=${referenceId}`;
    expect(membership!.removed).toBe(true);
    expect(membership!.source_memberships).toHaveLength(1);
  });
  test('report review pins edited Workspace output, detects changed text and recovers one immutable report', async () => {
    const saved: any = await research.saveResearch(ctx, saveInput()),
      service = new ResearchReportService(research);
    const base = await p.withSystem(async (tx) => {
      const report = await tx.legiWatchReport.create({
        data: {
          tenantId: tenant,
          ownerClerkId: actor,
          name: 'Synthetic research report',
          folderIds: [folderId],
          jurisdiction: 'FL',
          sessionKey: session,
          settings: {},
        },
      });
      return tx.legiWatchReportRun.create({
        data: {
          tenantId: tenant,
          reportId: report.id,
          definitionVersion: report.version,
          createdBy: actor,
          audience: 'internal',
          cutoff: '2026-09-13',
          snapshot: { rows: [] },
          rendered: { html: '<html><body>Base report</body></html>', text: 'Base report' },
          contentHash: hash('base'),
          complete: true,
        },
      });
    });
    const b = { selectionId: saved.selectionId, runId: base.id },
      first = await service.preview(ctx, b);
    await ws.wsDocument.updateMany({
      where: { tenantId: tenant, draftId: saved.draft.draftId },
      data: {
        body: {
          blocks: [{ title: 'Reviewed analysis', content: '<p>Human-reviewed research text.</p>' }],
        },
      },
    });
    await expect(service.approve(ctx, { ...b, approvalHash: first.approvalHash })).rejects.toThrow(
      'RESEARCH_OUTPUT_CHANGED',
    );
    const preview = await service.preview(ctx, b),
      approved = await service.approve(ctx, { ...b, approvalHash: preview.approvalHash });
    expect(preview.rendered.text).toContain('Human-reviewed research text.');
    await ws.wsDocument.updateMany({
      where: { tenantId: tenant, draftId: saved.draft.draftId },
      data: { body: { blocks: [{ content: '<p>Later draft edit.</p>' }] } },
    });
    expect(await service.approve(ctx, { ...b, approvalHash: preview.approvalHash })).toEqual({
      runId: approved.runId,
      replayed: true,
    });
    const retained = await reports.run(ctx, approved.runId);
    expect(retained.rendered.text).toContain('Human-reviewed research text.');
    expect(retained.rendered.text).not.toContain('Later draft edit.');
    await expect(reports.run({ ...ctx, clerkUserId: 'foreign' }, approved.runId)).rejects.toThrow();
    expect(await collaborators.sourceAccess(tenant, saved.draft.draftId, 'foreign')).toBe(false);
  });
  test('statute monitors require qualification, baseline history once, and hold changed membership', async () => {
    const service = new StatuteMonitorService(research),
      ruleId = randomUUID(),
      ref = 'FL:statute:section:395:395.003:',
      ruleFolder = (
        await folders.create(ctx, {
          name: 'Independent monitor test',
          jurisdiction: 'FL',
          defaultSession: session,
        })
      ).id;
    const config = {
      kind: 'statute_reference',
      folderIds: [ruleFolder],
      billIds: [bill],
      jurisdiction: 'FL',
      sessionKey: session,
      descendants: false,
      cadence: 'manual',
      recipients: [],
    };
    await p.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO legal_reference(id,jurisdiction,code_kind,reference_kind,chapter,section,identity) VALUES(${ref},'FL','statute','section','395','395.003','{"jurisdiction":"FL","code":"statute","kind":"section","chapter":"395","section":"395.003","subdivisions":[]}'::jsonb) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO intel_legiwatch_legal_membership(tenant_id,folder_id,reference_id,edition,version) VALUES(${tenant},${ruleFolder},${ref},'2026',1)`;
      await tx.$executeRaw`INSERT INTO intel_legiwatch_statute_rule(id,tenant_id,owner_clerk_id,config) VALUES(${ruleId},${tenant},${actor},${JSON.stringify(config)}::jsonb)`;
      await tx.$executeRaw`INSERT INTO legislative_legal_occurrence(id,document_id,bill_id,jurisdiction,session_key,document_revision,reference_id,locator,start_offset,end_offset,quote,relation,basis,parser_version) VALUES(${randomUUID()},${ids[1]},${bill},'FL',${session},${revision(1)},${ref},'page:1',19,26,'395.003','proposes_amend','synthetic exact heading','fl-citation-v3')`;
      const [fp] = await tx.$queryRaw<
        Array<{ value: string }>
      >`SELECT md5(coalesce(string_agg(document_id||revision_hash||is_current::text,'|' ORDER BY document_id COLLATE "C"),'')) AS value FROM legiwatch_research_document_source WHERE bill_id=${bill}`;
      const [inv] = await tx.$queryRaw<
        Array<{ value: string }>
      >`SELECT md5(id||coalesce(legiscan_change_hash,'')||coalesce(report_source_facts->'documentInventory','{}'::jsonb)::text) AS value FROM state_bill WHERE id=${bill}`;
      await tx.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES(${randomUUID()},'fl-legal-pilot',${JSON.stringify({ jurisdiction: 'FL', sessionKey: session, billIds: [bill] })}::jsonb,${JSON.stringify({ billDocumentCorpusComplete: true, sourceFingerprint: fp!.value, inventoryFingerprint: inv!.value, synthetic: true })}::jsonb,true)`;
    });
    const before = await service.preview(ctx, ruleId);
    expect(before.gaps).toContain('HELD_OUT_HUMAN_REVIEW_REQUIRED');
    await expect(
      service.activation(ctx, ruleId, {
        expectedVersion: 0,
        enabled: true,
        baseline: 'from_now',
        previewHash: before.previewHash,
      }),
    ).rejects.toThrow();
    await p.withSystem(
      (tx) =>
        tx.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES(${randomUUID()},'fl-citation-qualification','{"jurisdiction":"FL"}'::jsonb,'{"parserVersion":"fl-citation-v3","reviewedOccurrences":60,"reviewedRuleRecords":20,"humanReviewed":true,"synthetic":true}'::jsonb,true)`,
    );
    const preview = await service.preview(ctx, ruleId);
    expect(preview.gaps).toEqual([]);
    expect(
      await service.activation(ctx, ruleId, {
        expectedVersion: 0,
        enabled: true,
        baseline: 'from_now',
        previewHash: preview.previewHash,
      }),
    ).toMatchObject({ state: 'active', baselineMatches: 1, deliveryActive: false });
    expect(await service.scan(ctx, ruleId)).toMatchObject({
      state: 'complete',
      added: 0,
      delivery: 0,
    });
    expect(await service.scan(ctx, ruleId)).toMatchObject({ added: 0 });
    const events = (await service.events(ctx, ruleId)) as any[];
    expect(events).toHaveLength(1);
    expect(events[0].baseline).toBe(true);
    await expect(service.events({ ...ctx, clerkUserId: 'foreign' }, ruleId)).rejects.toThrow();
    await research.saveMembership(ctx, {
      ...scope(),
      folderId: ruleFolder,
      referenceId: ref,
      expectedVersion: 1,
      remove: true,
      requestKey: randomUUID(),
    });
    expect(await service.scan(ctx, ruleId)).toMatchObject({ state: 'held' });
  });
  test('published date revision holds pending leased follow-up and retains the existing editable draft', async () => {
    const noticeId = 'FL-' + String(Date.now()),
      noticeRevision = hash(noticeId),
      deadlineId = randomUUID();
    await p.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO state_rule(id,state,agency,title,rule_type,source_url,source_revision) VALUES(${noticeId},'FL','Synthetic agency','Synthetic notice','proposed','https://flrules.org/',${noticeRevision})`;
      await tx.$executeRaw`INSERT INTO rule_notice_revision(id,notice_id,source_url,content_hash,parser_version,payload,original_html) VALUES(${noticeRevision},${noticeId},'https://flrules.org/',${noticeRevision},'synthetic','{"linkedNotices":[]}'::jsonb,'synthetic')`;
      await tx.$executeRaw`INSERT INTO legal_published_date(id,notice_revision_id,kind,raw_wording,date_only,precision,basis,source_locator) VALUES(${deadlineId},${noticeRevision},'comment_end','Comments close September 20, 2026','2026-09-20','date','explicit','field:COMMENTS')`;
    });
    const saved: any = await new ResearchDeadlineService(research).save(ctx, {
      ...scope(),
      deadlineId,
      noticeRevision,
      analysis: 'Human follow-up instructions',
      requestKey: randomUUID(),
    });
    const preview = await actions.preview(ctx, {
      template: 'legal_deadline',
      selectionId: saved.selectionId,
      folderIds: [folderId],
      jurisdiction: 'FL',
      sessionKey: session,
    });
    const action = await actions.enqueue(ctx, {
      input: preview.input,
      inputHash: preview.inputHash,
      requestKey: randomUUID(),
    });
    await p.withSystem(
      (tx) => tx.$executeRaw`UPDATE state_rule SET source_revision='revised' WHERE id=${noticeId}`,
    );
    expect((await research.researchSource(ctx, saved.selectionId)).staleReasons).toContain(
      'PUBLISHED_DATE_REVISED_OR_WITHDRAWN',
    );
    expect((await actions.execute(ctx, action.id)).state).toBe('held');
    expect((await drafts.byId(tenant, saved.draft.draftId, actor)).docTitle).toContain(
      'Published date follow-up',
    );
  });
});
