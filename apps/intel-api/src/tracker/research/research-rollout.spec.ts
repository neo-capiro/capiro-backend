import { ForbiddenException } from '@nestjs/common';
import { DraftAccessService } from '../delivery/draft-access.service.js';
import { digest } from '../delivery/delivery-domain.js';
import { ResearchService } from './research.service.js';
import { ResearchReportService } from './research-report.service.js';

const ctx = { tenantId: 'tenant-a', clerkUserId: 'owner-a', role: null };
const scope = {
  folderId: 'folder-a',
  clientId: 'client-a',
  jurisdiction: 'FL',
  sessionKey: '2026',
};
const input = { selectionId: 'selection-a', runId: 'base-a' };
const previousEnv = { ...process.env };
beforeEach(() => {
  process.env.WORKSPACE_BASE_URL = 'https://workspace.example.invalid';
  process.env.INTERNAL_SERVICE_SECRET = 'synthetic-secret';
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...previousEnv };
});

function setup() {
  const access = {
    member: true,
    research: true,
    client: true,
    source: true,
    document: true,
    revokedFolder: '',
    folderClient: scope.clientId as string | null,
  };
  const payload = {
    scope: { ...scope, clientId: scope.clientId as string | null },
    contextVersion: 'context-one',
    title: 'Research',
    documents: [{ id: 'document-a', revision: 'revision-a' }],
  };
  const report = {
    id: 'report-a',
    tenantId: ctx.tenantId,
    ownerClerkId: ctx.clerkUserId,
    folderIds: [scope.folderId],
    jurisdiction: 'FL',
    sessionKey: '2026',
    version: 2,
    archived: false,
  };
  const base = {
    id: 'base-a',
    tenantId: ctx.tenantId,
    reportId: report.id,
    definitionVersion: 2,
    audience: 'internal',
    cutoff: '2026-10-01',
    contentHash: 'base-hash',
    complete: false,
    generatedAt: new Date('2026-10-02T00:00:00Z'),
    snapshot: {
      mode: 'bill_report',
      audience: 'internal',
      rows: [{ folderId: scope.folderId, internalComments: 'Frozen comment' }],
      complete: false,
    },
    rendered: { html: '<html><body><p>Frozen base</p></body></html>', text: 'Frozen base' },
  };
  let saved: Record<string, any> | null = null;
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?');
      if (sql.includes('FROM intel_legiwatch_research_selection')) {
        if (!access.source || !values.includes(ctx.tenantId) || !values.includes(ctx.clerkUserId))
          return [];
        if (sql.includes('SELECT id,input_hash,payload'))
          return [{ id: input.selectionId, input_hash: 'source-hash', payload }];
        return [{ folder_id: scope.folderId, client_id: payload.scope.clientId }];
      }
      if (sql.includes('FROM clients c JOIN tenant_memberships'))
        return access.client && access.member ? [{ id: scope.clientId }] : [];
      if (sql.includes('SELECT is_current')) return [{ is_current: access.document }];
      return [];
    }),
    legiWatchReport: {
      findFirst: jest.fn(async ({ where }) =>
        where.tenantId === report.tenantId && where.id === report.id ? report : null,
      ),
      create: jest.fn(),
    },
    legiWatchReportRun: {
      findMany: jest.fn(async () => [{ id: base.id }]),
      findFirst: jest.fn(async ({ where }) =>
        where.tenantId !== ctx.tenantId
          ? null
          : where.id === base.id
            ? base
            : saved?.id === where.id
              ? saved
              : null,
      ),
      findUnique: jest.fn(async () => saved),
      create: jest.fn(async ({ data }) => {
        saved = { ...data, id: 'reviewed-a' };
        return saved;
      }),
    },
  };
  const folders = {
    source: { activeMember: jest.fn(async () => access.member) },
    withActor: jest.fn(async (_ctx: unknown, fn: Function) => fn(tx)),
    folder: jest.fn(async (_tx: unknown, _ctx: unknown, id: string) => {
      if (id === access.revokedFolder) throw new ForbiddenException('FOLDER_REVOKED');
      return { id, clientId: access.folderClient, archived: false };
    }),
  };
  const flags = {
    isEnabled: jest.fn(async (feature: string) =>
      feature === 'legiwatch_editorial_v1'
        ? false
        : feature === 'legiwatch_research_v1'
          ? access.research
          : true,
    ),
  };
  const reports = new DraftAccessService(folders as never, flags as never);
  const research = new ResearchService({ reports, folder: folders.folder } as never);
  jest.spyOn(research, 'contextVersion').mockResolvedValue('context-one');
  const output = {
    selectionId: input.selectionId,
    outputHash: 'a'.repeat(64),
    text: 'Edited research <exact>',
    snapshot: { title: 'Research' },
    draftId: 'draft-a',
  };
  const fetcher = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue({ ok: true, json: async () => output } as Response);
  return {
    service: new ResearchReportService(research),
    tx,
    reports,
    folders,
    flags,
    access,
    payload,
    report,
    base,
    output,
    fetcher,
  };
}

test('history supplies the old metadata shape under research access without publishing frozen text', async () => {
  const { service, tx, flags, base } = setup();
  const rows = await service.history(ctx, {});
  expect(rows).toEqual([
    {
      id: base.id,
      reportId: base.reportId,
      definitionVersion: 2,
      audience: 'internal',
      cutoff: base.cutoff,
      contentHash: base.contentHash,
      complete: false,
      generatedAt: base.generatedAt,
    },
  ]);
  expect(rows[0]).not.toHaveProperty('rendered');
  expect(rows[0]).not.toHaveProperty('snapshot');
  expect(flags.isEnabled).not.toHaveBeenCalledWith('legiwatch_editorial_v1', ctx.tenantId);
  await service.history(ctx, { reportId: base.reportId, before: '2026-10-03T00:00:00Z' });
  expect(tx.legiWatchReportRun.findMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: {
        tenantId: ctx.tenantId,
        audience: 'internal',
        reportId: base.reportId,
        generatedAt: { lt: new Date('2026-10-03T00:00:00Z') },
      },
      take: 100,
    }),
  );
});

test('history suppresses another owner and a revoked frozen-row folder', async () => {
  const { service, report, base, access } = setup();
  report.ownerClerkId = 'other-owner';
  expect(await service.history(ctx, {})).toEqual([]);
  report.ownerClerkId = ctx.clerkUserId;
  base.snapshot.rows.push({ folderId: 'private-frozen-folder', internalComments: 'Private' });
  access.revokedFolder = 'private-frozen-folder';
  expect(await service.history(ctx, {})).toEqual([]);
});

test('legacy preview retains the exact 19cdf4b base composition and review hash shape', async () => {
  const { service, base, output, payload } = setup();
  const preview = await service.preview(ctx, input);
  // Old ResearchReportService.preview at 19cdf4b: append the edited research
  // to the frozen base and include base identity/hash in the approval digest.
  const review = {
    selectionId: input.selectionId,
    ownerId: ctx.clerkUserId,
    sourceHash: 'source-hash',
    contextVersion: payload.contextVersion,
    draftId: output.draftId,
    outputHash: output.outputHash,
    sourceVersions: payload.documents,
    outputSnapshot: output.snapshot,
    text: output.text,
    baseRunId: base.id,
    baseRunHash: base.contentHash,
  };
  const rendered = {
    html: '<html><body><p>Frozen base</p><section><h2>Reviewed Capiro research</h2><pre style="white-space:pre-wrap">Edited research &lt;exact&gt;</pre></section></body></html>',
    text: 'Frozen base\n\nREVIEWED CAPIRO RESEARCH\n\nEdited research <exact>',
  };
  expect(preview.review).toEqual(review);
  expect(preview.rendered).toEqual(rendered);
  expect(preview.approvalHash).toBe(digest({ review, rendered }));
  const standalone = await service.preview(ctx, { selectionId: input.selectionId });
  expect(standalone).not.toHaveProperty('run');
  expect(standalone.review).not.toHaveProperty('baseRunId');
  expect(standalone.rendered.text).toBe('REVIEWED CAPIRO RESEARCH\n\nEdited research <exact>');
  expect(standalone.approvalHash).toBe(
    digest({ review: standalone.review, rendered: standalone.rendered }),
  );
});

test('legacy approval preserves the frozen base and replays only the same selected base', async () => {
  const { service, tx, base, access } = setup();
  const preview = await service.preview(ctx, input);
  const approved = { ...input, approvalHash: preview.approvalHash };
  expect(await service.approve(ctx, approved)).toMatchObject({
    runId: 'reviewed-a',
    replayed: false,
  });
  expect(tx.legiWatchReport.create).not.toHaveBeenCalled();
  expect(tx.legiWatchReportRun.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      reportId: base.reportId,
      definitionVersion: 2,
      cutoff: base.cutoff,
      complete: false,
      rendered: preview.rendered,
      snapshot: expect.objectContaining({
        ...base.snapshot,
        researchReview: expect.objectContaining({
          baseRunId: base.id,
          baseRunHash: base.contentHash,
        }),
      }),
    }),
  });
  const locks = tx.$queryRaw.mock.calls.map(([parts]) => parts.join('?'));
  expect(locks).toEqual(
    expect.arrayContaining([
      expect.stringContaining('FROM intel_legiwatch_report_run WHERE'),
      expect.stringContaining('FROM intel_legiwatch_report WHERE'),
    ]),
  );
  const runLock = tx.$queryRaw.mock.calls.findIndex(([parts]) =>
    parts.join('?').includes('FROM intel_legiwatch_report_run WHERE'),
  );
  const definitionLock = tx.$queryRaw.mock.calls.findIndex(([parts]) =>
    parts.join('?').includes('FROM intel_legiwatch_report WHERE'),
  );
  expect(tx.$queryRaw.mock.invocationCallOrder[runLock]).toBeLessThan(
    tx.legiWatchReportRun.findFirst.mock.invocationCallOrder.at(-1)!,
  );
  expect(tx.$queryRaw.mock.invocationCallOrder[definitionLock]).toBeLessThan(
    tx.legiWatchReport.findFirst.mock.invocationCallOrder.at(-1)!,
  );
  access.document = false;
  expect(await service.approve(ctx, approved)).toEqual({ runId: 'reviewed-a', replayed: true });
  expect(tx.legiWatchReportRun.create).toHaveBeenCalledTimes(1);
  for (const runId of ['different-base', undefined])
    await expect(service.approve(ctx, { ...approved, runId })).rejects.toThrow(
      'RESEARCH_REVIEW_REQUEST_CHANGED',
    );
  access.revokedFolder = scope.folderId;
  await expect(service.approve(ctx, approved)).rejects.toThrow('FOLDER_REVOKED');
});

test.each(['version', 'hash', 'client', 'source'] as const)(
  'approval rechecks %s after the Workspace output request',
  async (change) => {
    const { service, report, base, access, fetcher, output, tx } = setup();
    const preview = await service.preview(ctx, input);
    fetcher.mockImplementationOnce(async () => {
      if (change === 'version') report.version++;
      if (change === 'hash') base.contentHash = 'changed-base-hash';
      if (change === 'client') access.client = false;
      if (change === 'source') access.source = false;
      return { ok: true, json: async () => output } as Response;
    });
    await expect(
      service.approve(ctx, { ...input, approvalHash: preview.approvalHash }),
    ).rejects.toThrow();
    expect(tx.legiWatchReportRun.create).not.toHaveBeenCalled();
  },
);

test.each(['owner', 'folder', 'client', 'session', 'external', 'derived'] as const)(
  'legacy preview rejects mismatched %s before reading edited output',
  async (change) => {
    const { service, report, base, payload, fetcher } = setup();
    if (change === 'owner') report.ownerClerkId = 'other-owner';
    if (change === 'folder') report.folderIds = ['other-folder'];
    if (change === 'client') payload.scope.clientId = 'other-client';
    if (change === 'session') report.sessionKey = '2025';
    if (change === 'external') base.audience = 'external';
    if (change === 'derived')
      Object.assign(base.snapshot, { researchReview: { selectionId: 'earlier' } });
    await expect(service.preview(ctx, input)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  },
);

test('disabled research, revoked membership, and another tenant never enter cached review', async () => {
  const { service, access, fetcher } = setup();
  access.research = false;
  await expect(service.history(ctx, {})).rejects.toThrow();
  await expect(service.preview(ctx, input)).rejects.toThrow();
  access.research = true;
  access.member = false;
  await expect(service.history(ctx, {})).rejects.toThrow('ACTIVE_MEMBERSHIP_REQUIRED');
  access.member = true;
  await expect(service.preview({ ...ctx, tenantId: 'other-tenant' }, input)).rejects.toThrow(
    'RESEARCH_SELECTION_NOT_FOUND',
  );
  expect(fetcher).not.toHaveBeenCalled();
});

test.each(['member', 'research'] as const)(
  'General-scope approval rechecks %s after Workspace returns',
  async (revoked) => {
    const { service, access, payload, fetcher, output, tx } = setup();
    access.folderClient = null;
    payload.scope.clientId = null;
    const preview = await service.preview(ctx, input);
    fetcher.mockImplementationOnce(async () => {
      access[revoked] = false;
      return { ok: true, json: async () => output } as Response;
    });
    await expect(
      service.approve(ctx, { ...input, approvalHash: preview.approvalHash }),
    ).rejects.toThrow();
    expect(tx.legiWatchReportRun.create).not.toHaveBeenCalled();
  },
);
