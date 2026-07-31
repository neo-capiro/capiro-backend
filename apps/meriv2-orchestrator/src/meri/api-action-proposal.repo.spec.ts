import type { ConfigService } from '@nestjs/config';
import { ApiActionProposalRepo } from './api-action-proposal.repo';
import { RequestCredentialsStore } from '../request/request-credentials.store';

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

const proposalBody = {
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
