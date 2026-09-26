import type { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from './api-tool-executor.repo';
import { ApiActionProposalRepo } from './api-action-proposal.repo';
import { ApiComplianceAuditRepo } from './api-compliance-audit.repo';
import { RequestCredentialsStore } from '../request/request-credentials.store';

/**
 * Impersonation passthrough (2.5): the orchestrator does NOT authorize
 * impersonation — it re-sends the `x-capiro-impersonate-tenant` header on its
 * delegated apps/api calls (tool execution + action-proposal creation) so
 * apps/api, which OWNS the authorization and re-validates it, scopes the call
 * to the impersonated tenant instead of the caller's home tenant (the
 * split-tenant hazard). Absent the header, nothing changes (today's behavior).
 */
const ctx: MeriContext = { tenantId: 't', userId: 'u', clerkUserId: 'c', role: 'standard_user' };
const config = {
  get: (k: string) =>
    k === 'MERIV2_API_BASE_URL'
      ? 'http://api.test'
      : k === 'MERIV2_TOOL_TIMEOUT_MS'
        ? '60000'
        : undefined,
} as unknown as ConfigService;

describe('impersonation passthrough on delegated apps/api calls (2.5)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  const captureFetch = (body: unknown) => {
    const calls: Array<{ url: unknown; headers: Record<string, string> }> = [];
    global.fetch = (async (url: unknown, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => body };
    }) as unknown as typeof fetch;
    return calls;
  };

  it('tool executor forwards the impersonate header when set', async () => {
    const calls = captureFetch({ ok: true });
    const repo = new ApiToolExecutorRepo(config);
    await RequestCredentialsStore.run({ bearerToken: 'TOK', impersonateTenantId: 'tenant-X' }, () =>
      repo.execute(ctx, 'search_congress_bills', { q: 'ndaa' }),
    );
    expect(calls[0]?.headers.authorization).toBe('Bearer TOK');
    expect(calls[0]?.headers['x-capiro-impersonate-tenant']).toBe('tenant-X');
  });

  it('tool executor omits the impersonate header when not impersonating', async () => {
    const calls = captureFetch({ ok: true });
    const repo = new ApiToolExecutorRepo(config);
    await RequestCredentialsStore.run({ bearerToken: 'TOK' }, () =>
      repo.execute(ctx, 'search_congress_bills', { q: 'ndaa' }),
    );
    expect(calls[0]?.headers['x-capiro-impersonate-tenant']).toBeUndefined();
  });

  it('action-proposal creation forwards the impersonate header when set', async () => {
    const calls = captureFetch({ proposalId: 'p1', status: 'proposed' });
    const repo = new ApiActionProposalRepo(config);
    await RequestCredentialsStore.run({ bearerToken: 'TOK', impersonateTenantId: 'tenant-X' }, () =>
      repo.create({ tool: 'send_email', input: {}, surface: 'chat' }),
    );
    expect(calls[0]?.headers['x-capiro-impersonate-tenant']).toBe('tenant-X');
  });

  it('compliance audit forwards the impersonate header when set', async () => {
    const calls = captureFetch({ ok: true });
    const repo = new ApiComplianceAuditRepo(config);
    await RequestCredentialsStore.run(
      { bearerToken: 'TOK', impersonateTenantId: 'tenant-X' },
      async () => {
        repo.record({
          trigger: 'send_email',
          decision: 'PASS',
          reason: 'Passed the compliance gate.',
        });
        await new Promise((resolve) => setImmediate(resolve));
      },
    );
    expect(calls[0]?.headers['x-capiro-impersonate-tenant']).toBe('tenant-X');
  });
});
