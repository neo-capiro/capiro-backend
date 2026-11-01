import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { PHASE8_FEATURES } from '@capiro/shared';
import { Phase8Controller } from './editorial.controller.js';
import { Phase8EvidenceService } from './evidence.service.js';
import { EditorialService } from './editorial.service.js';
import { currentEditorialConfiguration } from './editorial-domain.js';
import { runEditorialWork } from './editorial-runtime.js';
import { hash } from '../folders/folder-tracker.service.js';
import { digest } from '../delivery/delivery-domain.js';

const ctx = { tenantId: 'synthetic-tenant', clerkUserId: 'synthetic-owner', role: null };
const folder = { id: 'synthetic-folder', clientId: null, archived: false };
const scope = { jurisdiction: 'FL', sessionKey: '2026', folderId: folder.id, clientId: null };
const config = {
  ...scope,
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

function harness() {
  const payload = {
    scope,
    title: 'Reviewed research',
    template: 'research_update',
    cutoff: '2026-10-31T00:00:00Z',
    contextVersion: hash({ folder, clientId: null, clientRevision: null }),
    sources: [{ kind: 'research', id: 'source-one', revision: 'revision-one' }],
    gaps: [],
  };
  let prior: { id: string } | null = null;
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join('?');
      if (sql.includes('SELECT folder_id,client_id,input_hash,payload'))
        return [{ folder_id: folder.id, client_id: null, input_hash: 'source-hash', payload }];
      if (sql.includes('SELECT revision_hash FROM legiwatch_research_document_source'))
        return [{ revision_hash: 'revision-one' }];
      return [];
    }),
    legiWatchReport: { create: jest.fn(async () => ({ id: 'scope-record', version: 0 })) },
    legiWatchReportRun: {
      findUnique: jest.fn(async () => prior),
      create: jest.fn(async () => {
        prior = { id: 'immutable-run' };
        return prior;
      }),
    },
  };
  const reports = {
    get: jest.fn(async () => ({
      id: 'legacy-report',
      version: 2,
      folderIds: [folder.id],
      archived: false,
    })),
    authorize: jest.fn(),
    folders: {
      withActor: jest.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(tx)),
      folder: jest.fn(async () => folder),
    },
    flags: { isEnabled: jest.fn(async () => true) },
  };
  const evidence = {
    reports,
    context: jest.fn(),
    run: jest.fn(async (_ctx: unknown, input: unknown, _lane: string, fn: Function) =>
      fn(tx, input, scope),
    ),
  };
  const service = new EditorialService(
    evidence as never,
    { resolve: jest.fn(async () => []), recheck: jest.fn() } as never,
    {} as never,
  );
  jest.spyOn(service, 'source').mockResolvedValue({
    actionId: 'selection-one',
    stale: false,
    prefill: {
      draft: { docTitle: payload.title },
      context: { ...payload, contentHash: 'source-hash' },
      sources: payload.sources,
    },
  });
  const output = {
    selectionId: 'selection-one',
    draftId: 'draft-one',
    snapshot: { title: payload.title },
    text: 'Exact edited output',
    html: '<p>Exact edited output</p>',
    rendererVersion: 'workspace-editorial-html-v1',
    outputHash: 'a'.repeat(64),
  };
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => output } as Response);
  return { service, evidence, reports, tx, payload, output };
}

const beforeEnv = { ...process.env };
beforeEach(() => {
  process.env.WORKSPACE_BASE_URL = 'https://workspace.example.invalid';
  process.env.INTERNAL_SERVICE_SECRET = 'synthetic-secret';
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...beforeEnv };
});

test('retired evidence, import and monitor routes are absent; exact history and briefings remain', () => {
  const routes = Object.getOwnPropertyNames(Phase8Controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) =>
      Reflect.getMetadata(
        PATH_METADATA,
        Phase8Controller.prototype[name as keyof Phase8Controller],
      ),
    );
  expect(routes).toEqual([
    'source/:kind/:id',
    'briefings/drafts',
    'briefings/drafts',
    'briefings/configurations/:id/occurrences',
    'briefings/preview',
    'briefings/approve',
    'briefings/configurations',
    'briefings/configurations/:id',
    'briefings/configurations/:id/activation',
  ]);
  for (const name of [
    'news',
    'personnel',
    'track',
    'monitor',
    'monitors',
    'configureMonitor',
    'scan',
    'importPreview',
  ])
    expect(name in Phase8EvidenceService.prototype).toBe(false);
});

test('retained readers preserve live feature authorization before tenant transaction execution', async () => {
  const reports = {
    authorize: jest.fn().mockRejectedValue(new ForbiddenException()),
    folders: { withActor: jest.fn() },
  };
  const evidence = new Phase8EvidenceService({ keywords: { reports } } as never);
  await expect(evidence.budget(ctx, {})).rejects.toThrow(ForbiddenException);
  expect(reports.authorize).toHaveBeenCalledWith(ctx, PHASE8_FEATURES.budget);
  expect(reports.folders.withActor).not.toHaveBeenCalled();
});

test('retained exact news citations remain addressable without the removed news browser', async () => {
  const evidence = new Phase8EvidenceService({} as never);
  const query = jest.fn(async () => [
    {
      revision: 'old-revision',
      title: 'Old source',
      source_url: 'https://source.example.invalid',
      observed_at: '2026-10-01T00:00:00Z',
      body_complete: false,
      rights: 'headline_link',
    },
  ]);
  expect(
    await evidence.exact({ $queryRaw: query } as never, 'news', 'historical-source'),
  ).toMatchObject({ id: 'historical-source', revision: 'old-revision', complete: false });
});

test('standalone preview uses exact selected output without report-library authority', async () => {
  const { service, evidence } = harness();
  const preview = await service.preview(ctx, {
    selectionId: 'selection-one',
    audience: 'internal',
  });
  expect(preview).not.toHaveProperty('reportId');
  expect(preview).not.toHaveProperty('definitionVersion');
  expect(preview.rendered.text).toBe('Exact edited output');
  expect(evidence.context).toHaveBeenCalledWith(expect.anything(), ctx, scope, true);
  expect(preview.approvalHash).toBe(
    digest({ audience: preview.audience, review: preview.review, rendered: preview.rendered }),
  );
});

test('cached briefing preview preserves the old hash and freezes/replays its validated definition', async () => {
  const { service, reports, tx } = harness();
  const input = { selectionId: 'selection-one', audience: 'internal', reportId: 'legacy-report' };
  const preview = await service.preview(ctx, input);
  expect(preview).toMatchObject({ reportId: 'legacy-report', definitionVersion: 2 });
  expect(preview.approvalHash).toBe(
    digest({
      reportId: preview.reportId,
      version: 2,
      audience: preview.audience,
      review: preview.review,
      rendered: preview.rendered,
    }),
  );
  const approved = { ...input, approvalHash: preview.approvalHash };
  expect(await service.approve(ctx, approved)).toMatchObject({
    runId: 'immutable-run',
    replayed: false,
  });
  expect(await service.approve(ctx, approved)).toMatchObject({
    runId: 'immutable-run',
    replayed: true,
  });
  expect(reports.get).toHaveBeenCalledWith(tx, ctx, 'legacy-report', true);
  expect(tx.legiWatchReport.create).not.toHaveBeenCalled();
  expect(tx.legiWatchReportRun.create).toHaveBeenCalledTimes(1);
  const lockIndex = tx.$queryRaw.mock.calls.findIndex(
    ([sql]) =>
      sql.join('?').includes('FROM intel_legiwatch_report WHERE') &&
      sql.join('?').includes('FOR SHARE'),
  );
  expect(lockIndex).toBeGreaterThanOrEqual(0);
  expect(tx.$queryRaw.mock.calls[lockIndex]).toEqual(
    expect.arrayContaining([ctx.tenantId, 'legacy-report']),
  );
  expect(tx.$queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
    reports.get.mock.invocationCallOrder[2]!,
  );
  expect(reports.get.mock.invocationCallOrder[2]).toBeLessThan(
    tx.legiWatchReportRun.create.mock.invocationCallOrder[0]!,
  );
  expect(tx.legiWatchReportRun.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ reportId: 'legacy-report', definitionVersion: 2 }),
  });
});

test('cached approval rejects definition changes before and within approval', async () => {
  const { service, reports, tx } = harness();
  const input = { selectionId: 'selection-one', audience: 'internal', reportId: 'legacy-report' };
  const preview = await service.preview(ctx, input);
  const changed = { id: 'legacy-report', version: 3, folderIds: [folder.id], archived: false };
  reports.get.mockResolvedValueOnce(changed);
  await expect(
    service.approve(ctx, { ...input, approvalHash: preview.approvalHash }),
  ).rejects.toThrow('BRIEFING_PREVIEW_CHANGED');
  reports.get.mockResolvedValueOnce({ ...changed, version: 2 }).mockResolvedValueOnce(changed);
  await expect(
    service.approve(ctx, { ...input, approvalHash: preview.approvalHash }),
  ).rejects.toThrow('REPORT_CHANGED');
  expect(tx.legiWatchReportRun.create).not.toHaveBeenCalled();
});

test('cached briefing definition cannot bypass folder, owner, or source-family checks', async () => {
  const { service, reports, payload, tx } = harness();
  const input = { selectionId: 'selection-one', audience: 'internal', reportId: 'legacy-report' };
  reports.get.mockResolvedValueOnce({
    id: 'legacy-report',
    version: 2,
    folderIds: ['other-folder'],
    archived: false,
  });
  await expect(service.preview(ctx, input)).rejects.toThrow(
    'EXPLICIT_BRIEFING_REPORT_SCOPE_REQUIRED',
  );
  reports.get.mockRejectedValueOnce(new ForbiddenException('REPORT_OWNER_REQUIRED'));
  await expect(service.preview(ctx, input)).rejects.toThrow('REPORT_OWNER_REQUIRED');
  payload.sources[0]!.kind = 'news';
  await expect(service.preview(ctx, input)).rejects.toThrow('RESEARCH_SOURCES_REQUIRED');
  expect(tx.legiWatchReportRun.create).not.toHaveBeenCalled();
});

test('cached research-only configuration validates the old definition and discards retired metadata', async () => {
  const { service, tx, reports } = harness();
  tx.$queryRaw
    .mockResolvedValueOnce([{ config: {}, version: 0 }] as never)
    .mockResolvedValueOnce([{ id: 'configuration' }] as never);
  await service.configure(ctx, 'configuration', {
    expectedVersion: 0,
    config: {
      ...config,
      reportId: 'legacy-report',
      reportVersion: 2,
      monitorIds: [],
      categoryMapping: {},
    },
  });
  expect(reports.get).toHaveBeenCalledWith(tx, ctx, 'legacy-report', true);
  const update = tx.$queryRaw.mock.calls[1] as unknown[];
  const saved = JSON.parse(
    String(
      update.find((value) => typeof value === 'string' && value.includes('"policyVersion":2')),
    ),
  );
  expect(currentEditorialConfiguration(saved)).toBe(true);
  expect(saved).not.toHaveProperty('reportId');
});

test.each([[['news']], [['research', 'budget']]])(
  'cached configuration rejects retired source kinds %j',
  async (includedKinds) => {
    const { service, tx } = harness();
    tx.$queryRaw.mockResolvedValueOnce([{ config: {}, version: 0 }] as never);
    await expect(
      service.configure(ctx, 'configuration', {
        expectedVersion: 0,
        config: { ...config, reportId: 'legacy-report', includedKinds },
      }),
    ).rejects.toThrow('RESEARCH_ONLY_CONFIGURATION_REQUIRED');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  },
);

test('approval rechecks original access and creates one immutable scope/run for exact output', async () => {
  const { service, tx } = harness();
  const input = { selectionId: 'selection-one', audience: 'internal' };
  const preview = await service.preview(ctx, input);
  expect(
    await service.approve(ctx, { ...input, approvalHash: preview.approvalHash }),
  ).toMatchObject({ runId: 'immutable-run', replayed: false });
  expect(
    await service.approve(ctx, { ...input, approvalHash: preview.approvalHash }),
  ).toMatchObject({ runId: 'immutable-run', replayed: true });
  expect(tx.legiWatchReport.create).toHaveBeenCalledTimes(1);
  expect(tx.legiWatchReport.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      tenantId: ctx.tenantId,
      ownerClerkId: ctx.clerkUserId,
      folderIds: [folder.id],
      settings: {},
    }),
  });
  expect(tx.legiWatchReportRun.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      reportId: 'scope-record',
      createdBy: ctx.clerkUserId,
      snapshot: expect.objectContaining({
        mode: 'editorial_brief',
        editorialReview: expect.objectContaining({
          ownerId: ctx.clerkUserId,
          sourceHash: 'source-hash',
        }),
      }),
    }),
  });
});

test('changed output and revoked folder access cannot create immutable runs', async () => {
  const { service, output, evidence, tx } = harness();
  const input = { selectionId: 'selection-one', audience: 'internal' };
  const preview = await service.preview(ctx, input);
  output.outputHash = 'b'.repeat(64);
  await expect(
    service.approve(ctx, { ...input, approvalHash: preview.approvalHash }),
  ).rejects.toThrow('BRIEFING_PREVIEW_CHANGED');
  evidence.context.mockRejectedValue(new ForbiddenException());
  await expect(service.preview(ctx, input)).rejects.toThrow(ForbiddenException);
  expect(tx.legiWatchReport.create).not.toHaveBeenCalled();
});

test('external review still requires explicit acceptance of retained source gaps', async () => {
  const { service, payload } = harness();
  (payload.gaps as unknown[]).push({ id: 'source-one', reason: 'Incomplete source extraction' });
  const input = { selectionId: 'selection-one', audience: 'external' };
  await expect(service.preview(ctx, input)).rejects.toThrow('REVIEW_SOURCE_GAPS_FOR_DISTRIBUTION');
  expect(await service.preview(ctx, { ...input, acceptSourceGaps: true })).toMatchObject({
    deliveryState: 'requires_distribution_approval',
  });
});

test('new selections reject removed news and budget preparation sources', async () => {
  const { service } = harness();
  for (const kind of ['news', 'budget', 'personnel']) {
    await expect(
      service.save(ctx, {
        ...scope,
        template: 'research_update',
        title: 'Synthetic draft',
        analysis: '',
        cutoff: '2026-10-01T00:00:00Z',
        timezone: 'UTC',
        requestKey: 'synthetic-request',
        sources: [{ kind, id: 'source-one', revision: 'revision-one' }],
        citations: [{}],
      }),
    ).rejects.toThrow('RESEARCH_SOURCES_REQUIRED');
  }
});

test('a cross-owner selected source cannot be approved', async () => {
  const { service, tx } = harness();
  const input = { selectionId: 'selection-one', audience: 'internal' };
  const preview = await service.preview(ctx, input);
  await expect(
    service.approve(
      { ...ctx, clerkUserId: 'other-owner' },
      { ...input, approvalHash: preview.approvalHash },
    ),
  ).rejects.toThrow();
  expect(tx.legiWatchReport.create).not.toHaveBeenCalled();
});

test('old report/news configurations cannot activate or silently generate a research edition', async () => {
  const { service, evidence, tx, reports } = harness();
  const legacy = {
    ...config,
    policyVersion: undefined,
    reportId: 'old-report',
    includedKinds: ['news'],
  };
  tx.$queryRaw.mockResolvedValue([{ config: legacy, version: 0 }] as never);
  await expect(
    service.activation(ctx, 'configuration', { enabled: true, expectedVersion: 0 }),
  ).rejects.toThrow('EDITORIAL_CONFIGURATION_REVIEW_REQUIRED');
  expect(currentEditorialConfiguration(config)).toBe(true);
  expect(currentEditorialConfiguration(legacy)).toBe(false);
  process.env.LEGIWATCH_EDITORIAL_PREPARE_ENABLED = 'true';
  Object.assign(reports.folders, {
    prisma: {
      withSystem: async () => [{ owner_clerk_id: ctx.clerkUserId }],
      withTenant: async (_tenant: string, fn: Function) =>
        fn({
          $executeRaw: jest.fn(),
          $queryRaw: async () => [
            {
              id: 'configuration',
              owner_clerk_id: ctx.clerkUserId,
              version: 0,
              config: legacy,
              standing_approval: null,
              last_attempt_at: null,
            },
          ],
        }),
    },
  });
  evidence.run.mockClear();
  const generator = { editorialBrief: jest.fn() };
  expect(
    (await runEditorialWork(service, ctx.tenantId, new Date(), generator as never)).results,
  ).toEqual([
    {
      configurationId: 'configuration',
      state: 'held',
      reason: 'EDITORIAL_CONFIGURATION_REVIEW_REQUIRED',
    },
  ]);
  expect(generator.editorialBrief).not.toHaveBeenCalled();
  expect(evidence.run).not.toHaveBeenCalled();
});

test.each([
  { policyVersion: undefined },
  { policyVersion: 1 },
  { policyVersion: '2' },
  { template: 'morning_news_brief' },
  { template: ['research_update'] },
  { includedKinds: ['news'] },
  { includedKinds: ['research', 'news'] },
  { includedKinds: ['research', 'research'] },
  { reportId: null },
  { reportVersion: null },
  { monitorIds: [] },
  { categoryMapping: {} },
])('rejects configuration policy changes before runtime scheduling: %j', (change) => {
  expect(currentEditorialConfiguration({ ...config, ...change })).toBe(false);
});

test('saving a standalone configuration pins research-only policy and clears prior approval', async () => {
  const { service, tx } = harness();
  tx.$queryRaw
    .mockResolvedValueOnce([{ config: {}, version: 0 }] as never)
    .mockResolvedValueOnce([{ id: 'configuration' }] as never);
  await service.configure(ctx, 'configuration', { expectedVersion: 0, config });
  const update = tx.$queryRaw.mock.calls[1] as unknown[];
  const normalized = JSON.parse(
    String(
      update.find((value) => typeof value === 'string' && value.includes('"policyVersion":2')),
    ),
  );
  expect(currentEditorialConfiguration(normalized)).toBe(true);
  expect(normalized).not.toHaveProperty('reportId');
  expect(normalized).not.toHaveProperty('monitorIds');
  expect((update[0] as string[]).join('')).toContain("state='paused',standing_approval=NULL");
});

test('old stored configuration is projected as requiring review without rewriting its history', async () => {
  const { service, tx } = harness();
  const legacy = {
    template: 'morning_news_brief',
    includedKinds: ['news'],
    reportId: 'old-record',
    monitorIds: ['old-monitor'],
  };
  tx.$queryRaw
    .mockResolvedValueOnce([{ id: 'configuration', state: 'active', config: legacy }] as never)
    .mockResolvedValueOnce([]);
  const result = await service.configurations(ctx);
  expect(result.configurations[0]).toMatchObject({
    state: 'paused',
    config: {},
    last_held_reason: expect.stringContaining('research-only'),
  });
  expect(legacy.template).toBe('morning_news_brief');
  expect(tx.$executeRaw).not.toHaveBeenCalled();
});
