import type { ConfigService } from '@nestjs/config';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import { runWithStrategyGovernedContext } from './strategy-governed-context.runtime.js';
import type { StrategyGovernedTurnContext } from './strategy-governed-context.types.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function governed(
  operationId: StrategyGovernedTurnContext['operationId'] = 'strategies.generate',
): StrategyGovernedTurnContext {
  return {
    version: 1,
    operationId,
    prompt: 'governed context',
    contextPacket: {
      packetId: 'packet-1',
      persisted: true,
      surface:
        operationId === 'workspace.generate'
          ? 'workspace-gen'
          : operationId === 'outreach.generate'
            ? 'outreach'
            : 'strategy',
      clientId: CLIENT,
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    retrieval: {
      plan: {
        version: 1,
        queryClass: 'lookup',
        subjectScope: 'client',
        targetHint: null,
        recipeTool: null,
        requireCompleteCoverage: false,
        requiredDomains: ['clients'],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: true,
        requestedDomains: ['clients'],
        searchedDomains: ['clients'],
        missingDomains: [],
        partialDomains: [],
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 1,
        recordsReturned: 1,
        paginationComplete: true,
        truncated: false,
        sourceHealth: [],
        unavailableSources: [],
        toolsInvoked: [],
        stopReason: 'complete',
      },
    },
  };
}

describe('StrategyOrchestratorClient governed transport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function client(secret = 'secret') {
    return new StrategyOrchestratorClient(
      config({
        MERIV2_ORCHESTRATOR_URL: 'https://meri.internal/',
        INTERNAL_SERVICE_SECRET: secret,
      }),
    );
  }

  test('direct Strategy draft calls fail before transport when no governed runtime exists', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      client().draft({ clientId: CLIENT, type: 'appropriations' }, 'token'),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('forwards the governed bundle and internal marker to the orchestrator', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ summary: 'Drafted', nodes: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = governed();

    await runWithStrategyGovernedContext(ctx, () =>
      client().draft({ clientId: CLIENT, type: 'appropriations' }, 'token'),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://meri.internal/meri-api/strategy-draft',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer token',
          'x-internal-service-secret': 'secret',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.clientId).toBe(CLIENT);
    expect(body.governedContext).toEqual(ctx);
  });

  test.each([
    ['workspace_draft', 'workspace.generate'],
    ['outreach_record', 'outreach.generate'],
  ] as const)('requires %s to carry %s context', async (kind, operationId) => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: null, summary: null, sections: [], model: null }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = governed(operationId);

    await runWithStrategyGovernedContext(ctx, () =>
      client().nodeDocumentDraft({ clientId: CLIENT, kind }, 'token'),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.governedContext.operationId).toBe(operationId);
  });

  test('rejects a Strategy packet on an Outreach document path', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      runWithStrategyGovernedContext(governed('strategies.generate'), () =>
        client().nodeDocumentDraft(
          { clientId: CLIENT, kind: 'outreach_record' },
          'token',
        ),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('report narrative is an internal, delegated hop that needs no governed bundle', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sections: [], model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client().reportNarrative(
      { audience: 'client', evidence: [{ id: 'plan:strategy', text: 'x' }] },
      undefined,
      undefined,
      { tenantId: 'tenant-1', clerkUserId: 'user-1' },
      12_345,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://meri.internal/meri-api/strategy-report-narrative',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-internal-service-secret': 'secret',
          'x-capiro-delegated-tenant': 'tenant-1',
          'x-capiro-delegated-user': 'user-1',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.governedContext).toBeUndefined();
    expect(body.evidence).toEqual([{ id: 'plan:strategy', text: 'x' }]);
  });

  test('report narrative without a bearer or delegation fails before transport', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      client().reportNarrative({ audience: 'client', evidence: [] }, undefined),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('requires the internal secret for governed reasoning routes', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      runWithStrategyGovernedContext(governed(), () =>
        client('').draft({ clientId: CLIENT }, 'token'),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('Steward extraction remains a separate authenticated operation', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ facts: [], conflicts: [], summary: 'none' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(client().stewardExtract({ documentId: 'doc-1' }, 'token')).resolves.toEqual({
      facts: [],
      conflicts: [],
      summary: 'none',
    });
    const init = fetchMock.mock.calls[0]![1];
    expect(init.headers['x-internal-service-secret']).toBeUndefined();
  });
});
