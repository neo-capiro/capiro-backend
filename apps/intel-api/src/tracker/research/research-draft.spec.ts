import { ResearchReportService } from './research-report.service.js';

jest.mock('./research.service.js', () => ({ ResearchService: class {} }));

describe('standalone research review', () => {
  const ctx = { tenantId: 'tenant-a', clerkUserId: 'owner-a', role: null };
  const priorFetch = global.fetch;
  const priorBase = process.env.WORKSPACE_BASE_URL;
  const priorSecret = process.env.INTERNAL_SERVICE_SECRET;
  beforeEach(() => {
    process.env.WORKSPACE_BASE_URL = 'https://workspace.example.invalid';
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-test-only';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        selectionId: 'selection-a',
        outputHash: 'a'.repeat(64),
        text: 'Reviewed research',
        snapshot: {},
        draftId: 'draft-a',
      }),
    });
  });
  afterEach(() => {
    global.fetch = priorFetch;
    if (priorBase === undefined) delete process.env.WORKSPACE_BASE_URL;
    else process.env.WORKSPACE_BASE_URL = priorBase;
    if (priorSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = priorSecret;
  });
  function setup() {
    const tx = {
      $executeRaw: jest.fn(),
      legiWatchReport: { create: jest.fn().mockResolvedValue({ id: 'scope-a', version: 0 }) },
      legiWatchReportRun: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'run-a' }),
      },
    };
    const folders = {
      withActor: jest.fn(async (_ctx, fn) => fn(tx)),
      folder: jest
        .fn()
        .mockResolvedValue({ id: 'folder-a', clientId: 'client-a', archived: false }),
    };
    const research = {
      authorize: jest.fn(),
      researchSource: jest.fn().mockResolvedValue({
        stale: false,
        prefill: {
          context: {
            scope: {
              folderId: 'folder-a',
              clientId: 'client-a',
              jurisdiction: 'FL',
              sessionKey: '2026',
            },
            contentHash: 'source-a',
            contextVersion: 1,
          },
          sources: [],
        },
      }),
      keywords: { reports: { folders } },
    };
    return { service: new ResearchReportService(research as never), tx, folders };
  }
  it('reviews the exact selection without a saved-report definition and stores an internal immutable draft', async () => {
    const { service, tx } = setup();
    const preview = await service.preview(ctx, { selectionId: 'selection-a' });
    expect(preview.rendered.text).toContain('Reviewed research');
    expect(
      await service.approve(ctx, {
        selectionId: 'selection-a',
        approvalHash: preview.approvalHash,
      }),
    ).toEqual({ runId: 'run-a', replayed: false, deliveryState: 'internal_review_only' });
    expect(tx.legiWatchReportRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        audience: 'internal',
        reportId: 'scope-a',
        snapshot: expect.objectContaining({
          mode: 'research_draft',
          researchReview: expect.objectContaining({ selectionId: 'selection-a' }),
        }),
      }),
    });
  });
  it('rejects changed folder scope before creating an immutable record', async () => {
    const { service, tx, folders } = setup();
    const preview = await service.preview(ctx, { selectionId: 'selection-a' });
    folders.folder.mockResolvedValue({ id: 'folder-a', clientId: 'other-client', archived: false });
    await expect(
      service.approve(ctx, { selectionId: 'selection-a', approvalHash: preview.approvalHash }),
    ).rejects.toThrow('RESEARCH_SCOPE_CHANGED');
    expect(tx.legiWatchReport.create).not.toHaveBeenCalled();
  });
});
