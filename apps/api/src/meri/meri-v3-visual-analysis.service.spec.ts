import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

const VISUAL_ID = 'a1111111-1111-4111-8111-111111111111';
const OTHER_ID = 'b2222222-2222-4222-8222-222222222222';

function make(options?: {
  conversation?: { id: string; clientId: string | null } | null;
  analysis?: Record<string, unknown>;
  storedMetadata?: Record<string, unknown> | null;
  artifactCandidates?: Array<{ id: string; metadata: Record<string, unknown> }>;
  deleteCount?: number;
  memoryWall?: boolean;
  wallGranted?: boolean;
  clientActive?: boolean;
  onAnalysis?: () => void;
}) {
  const conversation =
    options && 'conversation' in options
      ? options.conversation
      : { id: 'conversation-1', clientId: 'client-1' };
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: VISUAL_ID,
    title: data.title,
  }));
  const findArtifact = jest.fn(async () =>
    options?.storedMetadata
      ? {
          id: VISUAL_ID,
          title: 'Stored visual',
          contentType: 'image/png',
          metadata: options.storedMetadata,
          createdAt: new Date('2026-08-08T10:00:00.000Z'),
          clientId: conversation?.clientId ?? null,
          conversation: { clientId: conversation?.clientId ?? null },
        }
      : null,
  );
  const findMany = jest.fn(async () => options?.artifactCandidates ?? []);
  const deleteMany = jest.fn(async () => ({ count: options?.deleteCount ?? 0 }));
  const wall = {
    memoryWall: options?.memoryWall ?? false,
    granted: options?.wallGranted ?? false,
    active: options?.clientActive ?? true,
  };
  const queryRaw = jest.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('');
    if (sql.includes('FROM clio_conversations')) return conversation ? [{ client_id: conversation.clientId }] : [];
    if (sql.includes('FROM clients')) return wall.active ? [{ memory_wall: wall.memoryWall }] : [];
    if (sql.includes('FROM client_memory_access')) return wall.granted ? [{ id: 'grant-1' }] : [];
    throw new Error('Unexpected visual-analysis scope query');
  });
  const tx = {
    clioConversation: { findFirst: jest.fn(async () => conversation) },
    clioArtifact: { create, findFirst: findArtifact, findMany, deleteMany },
    $queryRaw: queryRaw,
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const tools = {
    analysisSandboxEnabled: jest.fn(async () => true),
    executeFromAuthenticatedUser: jest.fn(
      async () => {
        options?.onAnalysis?.();
        return options?.analysis ?? {
          tool: 'run_analysis',
          ok: true,
          results: { findings: { delta: -22.7 }, table: [{ stage: 'HAC-D', amount: 169.5 }] },
          artifacts: [],
          warnings: [],
        };
      },
    ),
  };
  return {
    service: new MeriV3VisualAnalysisService(prisma as never, tools as never),
    prisma,
    tools,
    tx,
    create,
    findArtifact,
    findMany,
    deleteMany,
    wall,
    queryRaw,
  };
}

const lineVisual = {
  chartType: 'line',
  title: 'HAC-D sits $22.7M below the FY27 request',
  insight: 'The Senate position remains at request while HAC-D is lower.',
  xKey: 'stage',
  series: [{ dataKey: 'amount', label: 'Funding', valueFormat: 'currency' }],
  data: [
    { stage: 'Request', amount: 192.2 },
    { stage: 'HAC-D', amount: 169.5 },
  ],
};

describe('MeriV3VisualAnalysisService', () => {
  const originalRetention = process.env.MERIV3_ANALYSIS_ORPHAN_RETENTION_HOURS;
  const originalSweep = process.env.MERIV3_ANALYSIS_ORPHAN_SWEEP_MINUTES;

  afterEach(() => {
    if (originalRetention === undefined) delete process.env.MERIV3_ANALYSIS_ORPHAN_RETENTION_HOURS;
    else process.env.MERIV3_ANALYSIS_ORPHAN_RETENTION_HOURS = originalRetention;
    if (originalSweep === undefined) delete process.env.MERIV3_ANALYSIS_ORPHAN_SWEEP_MINUTES;
    else process.env.MERIV3_ANALYSIS_ORPHAN_SWEEP_MINUTES = originalSweep;
    jest.restoreAllMocks();
  });

  test('persists canonical provenance, interactive spec + PNG, and strips large visual rows', async () => {
    const { service, tools, create } = make({
      analysis: {
        tool: 'run_analysis',
        ok: true,
        durationMs: 120,
        results: {
          findings: { delta: -22.7 },
          table: [{ stage: 'HAC-D', amount: 169.5 }],
          visuals: [lineVisual],
        },
        artifacts: [
          {
            title: 'Analysis chart 1',
            kind: 'analysis_chart',
            metadata: {
              imageBase64: 'aGVsbG8=',
              filename: 'fig_1.png',
              codeSha256: 'abc123',
            },
          },
        ],
        warnings: [],
      },
    });

    const result = (await service.run(ctx, {
      conversationId: 'conversation-1',
      clientId: 'client-1',
      code: 'print(1)',
      datasets: [{ name: 'Capiro PE funding', rows: [{ amount: 1 }] }],
      purpose: 'Compare FY27 stages',
    })) as Record<string, unknown>;

    expect(tools.executeFromAuthenticatedUser).toHaveBeenCalledWith(ctx, 'run_analysis', {
      code: 'print(1)',
      datasets: [{ name: 'Capiro PE funding', rows: [{ amount: 1 }] }],
      purpose: 'Compare FY27 stages',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          userId: 'user-1',
          clientId: 'client-1',
          conversationId: 'conversation-1',
          title: 'HAC-D sits $22.7M below the FY27 request',
          kind: 'analysis_chart',
          contentType: 'image/png',
          metadata: expect.objectContaining({
            source: 'meri_v3_visual_analysis',
            evidence: 'derived',
            imageBase64: 'aGVsbG8=',
            datasets: [{ name: 'Capiro PE funding', rowCount: 1 }],
            resultSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            visualizationSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            visualization: expect.objectContaining({
              chartType: 'line',
              version: 1,
              insight: lineVisual.insight,
            }),
          }),
        }),
      }),
    );
    expect(result.results).toEqual({
      findings: { delta: -22.7 },
      table: [{ stage: 'HAC-D', amount: 169.5 }],
    });
    expect(result.artifacts).toEqual([
      expect.objectContaining({ id: VISUAL_ID, kind: 'analysis_chart', persisted: true }),
    ]);
    expect(JSON.stringify(result)).not.toContain('aGVsbG8=');
  });

  test('keeps a static PNG fallback and reports an invalid interactive spec honestly', async () => {
    const { service, create } = make({
      analysis: {
        tool: 'run_analysis',
        ok: true,
        results: {
          findings: { answer: 1 },
          visuals: [
            {
              chartType: 'bar',
              title: 'Invalid prose values',
              xKey: 'name',
              series: [{ dataKey: 'amount' }],
              data: [{ name: 'A', amount: '$10M' }],
            },
          ],
        },
        artifacts: [{ metadata: { imageBase64: 'cG5n' } }],
      },
    });
    const result = (await service.run(ctx, {
      conversationId: 'conversation-1',
      code: 'print(1)',
    })) as Record<string, unknown>;

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentType: 'image/png',
          metadata: expect.not.objectContaining({ visualization: expect.anything() }),
        }),
      }),
    );
    expect(result.visualWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Visualization 1 was rejected'),
        expect.stringContaining('static fallback'),
      ]),
    );
  });

  test('requires an owned conversation and refuses a mismatched client label', async () => {
    const missing = make({ conversation: null });
    await expect(
      missing.service.run(ctx, { conversationId: 'missing', code: 'print(1)' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const scoped = make();
    await expect(
      scoped.service.run(ctx, {
        conversationId: 'conversation-1',
        clientId: 'client-2',
        code: 'print(1)',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(scoped.tools.executeFromAuthenticatedUser).not.toHaveBeenCalled();
  });

  test('allows an unwalled client and a currently granted walled client', async () => {
    for (const options of [{ memoryWall: false }, { memoryWall: true, wallGranted: true }]) {
      const h = make({ ...options, analysis: {
        tool: 'run_analysis', ok: true, results: {},
        artifacts: [{ metadata: { imageBase64: 'cG5n' } }],
      } });
      await expect(h.service.run(ctx, { conversationId: 'conversation-1', code: 'print(1)' }))
        .resolves.toMatchObject({ chartCount: 1 });
      expect(h.create).toHaveBeenCalledTimes(1);
      expect(h.prisma.withTenantUser).toHaveBeenCalledWith('tenant-1', 'user-1', expect.any(Function));
      const queries = h.queryRaw.mock.calls.map(([strings]) => strings.join(''));
      expect(queries.filter((sql) => sql.includes('FROM clients') && sql.includes('FOR SHARE'))).toHaveLength(4);
      expect(queries.some((sql) => sql.includes('FROM clio_conversations') && sql.includes('FOR SHARE'))).toBe(true);
      expect(queries.filter((sql) => sql.includes('FROM client_memory_access') && sql.includes('FOR SHARE')))
        .toHaveLength(4);
    }
  });

  test('denies a walled or archived client before sandbox computation, including an ungranted admin', async () => {
    for (const options of [{ memoryWall: true }, { clientActive: false }]) {
      const h = make(options);
      await expect(h.service.run(ctx, { conversationId: 'conversation-1', code: 'print(1)' }))
        .rejects.toBeInstanceOf(NotFoundException);
      expect(h.tools.executeFromAuthenticatedUser).not.toHaveBeenCalled();
    }
    const admin = make({ memoryWall: true });
    await expect(admin.service.run({ ...ctx, role: 'user_admin' } as TenantContext,
      { conversationId: 'conversation-1', code: 'print(1)' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(admin.tools.executeFromAuthenticatedUser).not.toHaveBeenCalled();
  });

  test('rejects a grant revoked during computation before persisting a visual', async () => {
    const h = make({ memoryWall: true, wallGranted: true, analysis: {
      tool: 'run_analysis', ok: true, results: {},
      artifacts: [{ metadata: { imageBase64: 'cG5n' } }],
    } });
    h.tools.executeFromAuthenticatedUser.mockImplementation(async () => {
      h.wall.granted = false;
      return { tool: 'run_analysis', ok: true, results: {},
        artifacts: [{ metadata: { imageBase64: 'cG5n' } }] };
    });
    await expect(h.service.run(ctx, { conversationId: 'conversation-1', code: 'print(1)' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.create).not.toHaveBeenCalled();
  });

  test('rejects a wall erected during computation without a current grant', async () => {
    const h = make({ analysis: { tool: 'run_analysis', ok: true, results: {},
      artifacts: [{ metadata: { imageBase64: 'cG5n' } }] } });
    h.tools.executeFromAuthenticatedUser.mockImplementation(async () => {
      h.wall.memoryWall = true;
      return { tool: 'run_analysis', ok: true, results: {},
        artifacts: [{ metadata: { imageBase64: 'cG5n' } }] };
    });
    await expect(h.service.run(ctx, { conversationId: 'conversation-1', code: 'print(1)' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.create).not.toHaveBeenCalled();
  });

  test.each([
    ['failed sandbox result', { tool: 'run_analysis', ok: false, error: 'sandbox unavailable' }],
    ['text-only result', { tool: 'run_analysis', ok: true, results: { answer: 1 } }],
    ['raw null result', null],
  ])('suppresses %s after a grant is revoked during computation', async (_label, raw) => {
    const h = make({ memoryWall: true, wallGranted: true });
    h.tools.executeFromAuthenticatedUser.mockImplementation(async () => {
      h.wall.granted = false;
      return raw as never;
    });
    await expect(h.service.run(ctx, { conversationId: 'conversation-1', code: 'print(1)' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.create).not.toHaveBeenCalled();
  });

  test('suppresses artifact references if access changes immediately after persistence', async () => {
    const h = make({ memoryWall: true, wallGranted: true, analysis: {
      tool: 'run_analysis', ok: true, results: {},
      artifacts: [{ metadata: { imageBase64: 'cG5n' } }],
    } });
    h.create.mockImplementation(async ({ data }) => {
      h.wall.granted = false;
      return { id: VISUAL_ID, title: data.title };
    });
    await expect(h.service.run(ctx, { conversationId: 'conversation-1', code: 'print(1)' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  test('preserves analysis without a selected client', async () => {
    const h = make({ conversation: { id: 'conversation-1', clientId: null }, analysis: {
      tool: 'run_analysis', ok: true, results: {},
      artifacts: [{ metadata: { imageBase64: 'cG5n' } }],
    } });
    await expect(h.service.run(ctx, { conversationId: 'conversation-1', code: 'print(1)' }))
      .resolves.toMatchObject({ chartCount: 1 });
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ clientId: null }),
    }));
    expect(h.queryRaw.mock.calls.map(([strings]) => strings.join(''))
      .some((sql) => sql.includes('FROM clients') || sql.includes('FROM client_memory_access'))).toBe(false);
  });

  test('returns a bounded design-system provenance strip for the current user’s chart', async () => {
    const { service, findArtifact } = make({
      storedMetadata: {
        visualization: lineVisual,
        imageBase64: 'cG5n',
        datasets: [
          { name: 'Capiro PE funding', rowCount: 14 },
          { name: 'SASC mark', rowCount: 4 },
          { name: { nested: 'ignored' }, rowCount: 99 },
        ],
      },
    });
    await expect(service.getArtifact(ctx, VISUAL_ID)).resolves.toEqual({
      id: VISUAL_ID,
      title: 'Stored visual',
      visualization: expect.objectContaining({ chartType: 'line', version: 1 }),
      imageAvailable: true,
      provenance: {
        evidence: 'derived',
        generatedAt: '2026-08-08T10:00:00.000Z',
        datasetCount: 2,
        rowCount: 18,
        datasets: [
          { name: 'Capiro PE funding', rowCount: 14 },
          { name: 'SASC mark', rowCount: 4 },
        ],
      },
    });
    expect(findArtifact).toHaveBeenCalledWith({
      where: {
        id: VISUAL_ID,
        tenantId: 'tenant-1',
        userId: 'user-1',
        kind: 'analysis_chart',
      },
      select: { id: true, title: true, metadata: true, createdAt: true,
        clientId: true, conversation: { select: { clientId: true } } },
    });
  });

  test('returns PNG bytes only through the same tenant + user artifact predicate', async () => {
    const { service, findArtifact } = make({ storedMetadata: { imageBase64: 'cG5n' } });
    await expect(service.getArtifactImage(ctx, VISUAL_ID)).resolves.toEqual({
      buffer: Buffer.from('png'),
      contentType: 'image/png',
    });
    expect(findArtifact).toHaveBeenCalledWith({
      where: {
        id: VISUAL_ID,
        tenantId: 'tenant-1',
        userId: 'user-1',
        kind: 'analysis_chart',
      },
      select: { contentType: true, metadata: true,
        clientId: true, conversation: { select: { clientId: true } } },
    });
  });

  test('denies stored metadata and PNG after the selected client wall grant is revoked', async () => {
    const h = make({ storedMetadata: { imageBase64: 'cG5n' }, memoryWall: true });
    await expect(h.service.getArtifact(ctx, VISUAL_ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(h.service.getArtifactImage(ctx, VISUAL_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('immediately discards only unlinked current-user artifacts created by this V3 visual path', async () => {
    const { service, findMany, deleteMany } = make({
      artifactCandidates: [
        { id: VISUAL_ID, metadata: { source: 'meri_v3_visual_analysis' } },
        { id: OTHER_ID, metadata: { source: 'legacy_analysis' } },
      ],
      deleteCount: 1,
    });
    await expect(service.discardUnreleasedArtifacts(ctx, [VISUAL_ID, OTHER_ID])).resolves.toBe(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [VISUAL_ID, OTHER_ID] },
        tenantId: 'tenant-1',
        userId: 'user-1',
        kind: 'analysis_chart',
        messageId: null,
      },
      select: { id: true, metadata: true },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: [VISUAL_ID] },
        tenantId: 'tenant-1',
        userId: 'user-1',
        kind: 'analysis_chart',
        messageId: null,
      },
    });
  });

  test('discard rejects invalid or oversized artifact-id input before touching persistence', async () => {
    const { service, findMany } = make();
    await expect(service.discardUnreleasedArtifacts(ctx, ['not-an-id'])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.discardUnreleasedArtifacts(
        ctx,
        Array.from(
          { length: 7 },
          (_, index) => `a1111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  test('fallback sweep is bounded and deletes only old, unlinked V3 visual candidates', async () => {
    process.env.MERIV3_ANALYSIS_ORPHAN_RETENTION_HOURS = '24';
    process.env.MERIV3_ANALYSIS_ORPHAN_SWEEP_MINUTES = '60';
    const { service, findMany, deleteMany } = make({
      artifactCandidates: [
        { id: VISUAL_ID, metadata: { source: 'meri_v3_visual_analysis' } },
        { id: OTHER_ID, metadata: { source: 'legacy_analysis' } },
      ],
      deleteCount: 1,
    });
    const now = new Date('2026-08-08T12:00:00.000Z');

    await expect(service.cleanupOrphanedArtifacts(ctx, now)).resolves.toBe(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        kind: 'analysis_chart',
        messageId: null,
        createdAt: { lt: new Date('2026-08-07T12:00:00.000Z') },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, metadata: true },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: [VISUAL_ID] },
        tenantId: 'tenant-1',
        userId: 'user-1',
        kind: 'analysis_chart',
        messageId: null,
      },
    });

    await expect(
      service.cleanupOrphanedArtifacts(ctx, new Date('2026-08-08T12:30:00.000Z')),
    ).resolves.toBe(0);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  test('returns null when an artifact has neither a valid spec nor bounded image bytes', async () => {
    const { service } = make({ storedMetadata: { visualization: { chartType: 'script' } } });
    await expect(service.getArtifact(ctx, VISUAL_ID)).resolves.toBeNull();
    await expect(service.getArtifactImage(ctx, VISUAL_ID)).resolves.toBeNull();
  });
});
