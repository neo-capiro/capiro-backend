import type { ConfigService } from '@nestjs/config';
import { StrategyContextPlaneClient, operationFor } from './strategy-context-plane.client.js';
import type { StrategyGovernedTurnContext } from './strategy-governed-context.types.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';

function governed(
  operationId: StrategyGovernedTurnContext['operationId'] = 'strategies.generate',
): StrategyGovernedTurnContext {
  const surface =
    operationId === 'workspace.generate'
      ? 'workspace-gen'
      : operationId === 'outreach.generate'
        ? 'outreach'
        : 'strategy';
  return {
    version: 1,
    operationId,
    prompt: 'governed context',
    contextPacket: {
      packetId: 'packet-1',
      persisted: true,
      surface,
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

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('StrategyContextPlaneClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('posts the server-owned scope under the internal service secret', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'governed_packet', governedContext: governed() }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new StrategyContextPlaneClient(
      config({
        API_INTERNAL_URL: 'https://api.internal/',
        INTERNAL_SERVICE_SECRET: 'secret',
      }),
    );

    await expect(
      client.compile({
        tenantId: 'tenant-1',
        clerkUserId: 'user-1',
        clientId: CLIENT,
        mode: 'assistant',
        query: 'Move a step',
        strategyId: 'strategy-1',
        nodeId: 'node-1',
        traceId: 'trace-1',
      }),
    ).resolves.toEqual(governed());

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.internal/api/internal/strategy/context/compile',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-internal-service-secret': 'secret',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({
      tenantId: 'tenant-1',
      clerkUserId: 'user-1',
      clientId: CLIENT,
      mode: 'assistant',
      strategyId: 'strategy-1',
      nodeId: 'node-1',
      traceId: 'trace-1',
    });
  });

  test.each([
    ['workspace_draft', 'workspace.generate'],
    ['outreach_record', 'outreach.generate'],
  ] as const)('validates %s document context against %s', async (artifactKind, operationId) => {
    const expected = governed(operationId);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'governed_packet', governedContext: expected }),
    }) as unknown as typeof fetch;
    const client = new StrategyContextPlaneClient(
      config({ API_BASE_URL: 'https://api', INTERNAL_SERVICE_SECRET: 'secret' }),
    );
    await expect(
      client.compile({
        tenantId: 'tenant-1',
        clerkUserId: 'user-1',
        clientId: CLIENT,
        mode: 'document',
        artifactKind,
        nodeId: 'node-1',
      }),
    ).resolves.toEqual(expected);
  });

  test('fails before transport when the internal secret is absent', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new StrategyContextPlaneClient(config({ API_BASE_URL: 'https://api' }));
    await expect(
      client.compile({
        tenantId: 'tenant-1',
        clerkUserId: 'user-1',
        clientId: CLIENT,
        mode: 'draft',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects packet operation, client, or surface drift', async () => {
    const invalid = governed('outreach.generate');
    invalid.contextPacket = { ...invalid.contextPacket, clientId: 'other-client' };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'governed_packet', governedContext: invalid }),
    }) as unknown as typeof fetch;
    const client = new StrategyContextPlaneClient(
      config({ API_BASE_URL: 'https://api', INTERNAL_SERVICE_SECRET: 'secret' }),
    );
    await expect(
      client.compile({
        tenantId: 'tenant-1',
        clerkUserId: 'user-1',
        clientId: CLIENT,
        mode: 'draft',
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  test('maps Strategy execution documents to destination operations', () => {
    expect(operationFor('draft', null)).toBe('strategies.generate');
    expect(operationFor('assistant', null)).toBe('strategies.generate');
    expect(operationFor('document', 'workspace_draft')).toBe('workspace.generate');
    expect(operationFor('document', 'outreach_record')).toBe('outreach.generate');
    expect(() => operationFor('document', null)).toThrow(
      'Strategy document context requires an artifact kind',
    );
  });
});
