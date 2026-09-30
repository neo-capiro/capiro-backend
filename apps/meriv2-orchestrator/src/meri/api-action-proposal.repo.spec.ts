import type { ConfigService } from '@nestjs/config';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ApiActionProposalRepo } from './api-action-proposal.repo';
import { RequestCredentialsStore } from '../request/request-credentials.store';
import { withTrustedCurrentTurnScope } from '../request/trusted-current-turn-scope';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const currentTurn = {
  tenantId: TENANT,
  userId: USER,
  conversationId: CONVERSATION,
  selectedClientId: CLIENT,
};

function cfg(values: Record<string, string | undefined>) {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function mockFetch(response: { ok: boolean; status?: number; body?: unknown; text?: string }) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        statusText: response.ok ? 'OK' : 'Error',
        json: async () => response.body ?? {},
        text: async () => response.text ?? '',
      };
    },
  );
  return calls;
}

const originalFetch = global.fetch;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
  jest.restoreAllMocks();
});

const proposalDefinition = {
  proposalId: 'p1',
  status: 'proposed',
  tool: 'send_email',
  preview: {
    label: 'Send email',
    riskTier: 'restricted',
    leavesFirm: true,
    reversible: false,
    fields: {},
    counts: {},
    reason: 'Requires approval',
  },
  expiresAt: '2026-07-28T01:00:00.000Z',
  reason: 'Requires approval',
  ruleId: 'send.requires_approval',
  riskTier: 'restricted',
  policyCode: 'external_send',
  attemptCount: 0,
  resultSummary: null,
  createdAt: '2026-07-28T00:45:00.000Z',
  updatedAt: '2026-07-28T00:45:00.000Z',
};

// Match the API owner's ActionAuthorityResult envelope.
const proposalBody = { disposition: 'pending_approval', proposal: proposalDefinition };

describe('ApiActionProposalRepo', () => {
  it('posts tool/input/conversationId/surface, forwarding the caller bearer and internal service secret', async () => {
    const calls = mockFetch({ ok: true, body: proposalBody });
    const repo = new ApiActionProposalRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));

    const result = await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      repo.create({
        tool: 'send_email',
        input: { to: 'a@b.com', subject: 's', body: 'b' },
        conversationId: 'conv-1',
        surface: 'chat',
      }),
    );

    expect(calls[0]?.url).toBe('http://localhost:3000/api/clio/action-proposals');
    expect(calls[0]?.headers.authorization).toBe('Bearer user-tok');
    expect(calls[0]?.headers['x-internal-service-secret']).toBe('sec-123');
    expect(calls[0]?.body).toEqual({
      tool: 'send_email',
      input: { to: 'a@b.com', subject: 's', body: 'b' },
      conversationId: 'conv-1',
      surface: 'chat',
    });
    expect(result).toEqual(proposalBody);
  });

  it('forwards x-capiro-impersonate-tenant when set, omits it otherwise', async () => {
    const calls = mockFetch({ ok: true, body: proposalBody });
    const repo = new ApiActionProposalRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));

    await RequestCredentialsStore.run(
      { bearerToken: 'user-tok', impersonateTenantId: 'tenant-X' },
      () => repo.create({ tool: 'send_email', input: {}, surface: 'chat' }),
    );
    expect(calls[0]?.headers['x-capiro-impersonate-tenant']).toBe('tenant-X');

    const calls2 = mockFetch({ ok: true, body: proposalBody });
    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      repo.create({ tool: 'send_email', input: {}, surface: 'chat' }),
    );
    expect(calls2[0]?.headers['x-capiro-impersonate-tenant']).toBeUndefined();
  });

  it('omits the service-secret header when unset outside production (dev/test observe mode)', async () => {
    const calls = mockFetch({ ok: true, body: proposalBody });
    const repo = new ApiActionProposalRepo(cfg({}));
    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      repo.create({ tool: 'send_email', input: {}, surface: 'chat' }),
    );
    expect(calls[0]?.headers['x-internal-service-secret']).toBeUndefined();
  });

  it('sends RP proposals in the trusted current-turn envelope and derives both conversation ids', async () => {
    const calls = mockFetch({ ok: true, body: proposalBody });
    const repo = new ApiActionProposalRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));

    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      withTrustedCurrentTurnScope(currentTurn, () =>
        repo.create({
          tool: 'create_research_portfolio_snapshot',
          input: { operationKey: 'snapshot:1' },
          surface: 'chat',
        }),
      ),
    );

    expect(calls[0]?.body).toEqual({
      version: 1,
      proposal: {
        tool: 'create_research_portfolio_snapshot',
        input: { operationKey: 'snapshot:1', conversationId: CONVERSATION },
        conversationId: CONVERSATION,
        surface: 'chat',
      },
      currentTurn,
    });
  });

  it('uses the real fetch path to carry only bearer, service identity, and the bounded RP envelope', async () => {
    (global as unknown as { fetch: unknown }).fetch = originalFetch;
    let captured:
      | {
          authorization?: string;
          service?: string;
          body: Record<string, unknown>;
        }
      | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        captured = {
          authorization: req.headers.authorization,
          service: req.headers['x-internal-service-secret'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(proposalBody));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('controlled HTTP unavailable');
    try {
      const repo = new ApiActionProposalRepo(
        cfg({
          INTERNAL_SERVICE_SECRET: 'sec-123',
          MERIV2_API_BASE_URL: `http://127.0.0.1:${address.port}`,
        }),
      );
      await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        withTrustedCurrentTurnScope(currentTurn, () =>
          repo.create({
            tool: 'create_research_portfolio_snapshot',
            input: { operationKey: 'snapshot:http' },
            surface: 'chat',
          }),
        ),
      );
    } finally {
      server.close();
      await once(server, 'close');
    }
    expect(captured).toMatchObject({
      authorization: 'Bearer user-tok',
      service: 'sec-123',
      body: {
        version: 1,
        proposal: {
          conversationId: CONVERSATION,
          input: { operationKey: 'snapshot:http', conversationId: CONVERSATION },
        },
        currentTurn,
      },
    });
  });

  it('rejects absent scope, outer/inner retargeting, and absent RP service identity before HTTP', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const request = {
      tool: 'create_research_portfolio_snapshot',
      input: {},
      surface: 'chat' as const,
    };
    const repo = new ApiActionProposalRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () => repo.create(request)),
    ).rejects.toThrow('Trusted current conversation is unavailable');
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        withTrustedCurrentTurnScope(currentTurn, () =>
          repo.create({ ...request, conversationId: OTHER_CONVERSATION }),
        ),
      ),
    ).rejects.toThrow('cannot target another conversation');
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        withTrustedCurrentTurnScope(currentTurn, () =>
          repo.create({ ...request, input: { conversationId: OTHER_CONVERSATION } }),
        ),
      ),
    ).rejects.toThrow('cannot target another conversation');
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        withTrustedCurrentTurnScope(currentTurn, () =>
          new ApiActionProposalRepo(cfg({})).create(request),
        ),
      ),
    ).rejects.toThrow('INTERNAL_SERVICE_SECRET is not configured for Research Portfolio');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['staging', 'production'])(
    '%s: throws immediately without a network call when the service secret is missing',
    async (env) => {
      const fetchSpy = jest.fn();
      (global as unknown as { fetch: unknown }).fetch = fetchSpy;
      const repo = new ApiActionProposalRepo(cfg({ NODE_ENV: env }));
      await expect(
        RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
          repo.create({ tool: 'send_email', input: {}, surface: 'chat' }),
        ),
      ).rejects.toThrow(/INTERNAL_SERVICE_SECRET is not configured/);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('throws immediately without a network call when no bearer is in scope', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const repo = new ApiActionProposalRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));
    await expect(repo.create({ tool: 'send_email', input: {}, surface: 'chat' })).rejects.toThrow(
      /No forwarded credential/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response — never returns a fabricated proposal', async () => {
    mockFetch({ ok: false, status: 403, text: 'Forbidden' });
    const repo = new ApiActionProposalRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.create({ tool: 'send_email', input: {}, surface: 'chat' }),
      ),
    ).rejects.toThrow(/Action authority failed: 403/);
  });

  it('propagates a network failure (never swallows it into a fake success)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const repo = new ApiActionProposalRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.create({ tool: 'send_email', input: {}, surface: 'chat' }),
      ),
    ).rejects.toThrow('ECONNRESET');
  });
});
import { createMeriTelemetryContext } from '@capiro/meriv2-core';
import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import {
  runWithMeriOrchestratorTelemetry,
  setMeriOtelRuntime,
} from '../telemetry/meri-telemetry.runtime.js';

test('proposal owner exports the actual transported client span with opaque proposal identity', async () => {
  const spans: any[] = [];
  const sdk = createMeriOtelRuntime({
    serviceName: 'proposal-owner-test',
    exporter: {
      export: (batch, done) => {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: async () => {},
    },
  });
  await setMeriOtelRuntime(sdk);
  const calls = mockFetch({ ok: true, body: proposalBody });
  try {
    await runWithMeriOrchestratorTelemetry(
      createMeriTelemetryContext({ tenantId: TENANT, actorId: USER }),
      () => {},
      () =>
        RequestCredentialsStore.run({ bearerToken: 'PRIVATE_USER_TOKEN' }, () =>
          new ApiActionProposalRepo(cfg({ INTERNAL_SERVICE_SECRET: 'PRIVATE_SECRET' })).create({
            tool: 'send_email',
            input: { body: 'PRIVATE_EMAIL' },
            surface: 'chat',
          }),
        ),
    );
    await sdk.forceFlush();
    const carrier = JSON.parse(
      decodeURIComponent(calls[0]!.headers['x-capiro-telemetry-context']!),
    );
    const span = spans.find((candidate) => candidate.spanContext().spanId === carrier.spanId);
    expect(span).toBeDefined();
    expect(span.parentSpanContext.spanId).toBe(carrier.parentSpanId);
    expect(span.attributes['meri.outcome']).toBe('pending_approval');
    expect(span.attributes['meri.proposalId']).toMatch(/^sha256:/);
    expect(JSON.stringify(span.attributes)).not.toContain('PRIVATE_');
  } finally {
    await setMeriOtelRuntime(undefined);
  }
});
