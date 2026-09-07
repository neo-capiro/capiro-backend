import type { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import { wrapToolResultForPrompt } from '@capiro/meriv2-core';
import { ApiClientContextRepo } from './api-client-context.repo';
import { ApiToolExecutorRepo } from './api-tool-executor.repo';
import { RequestCredentialsStore } from '../request/request-credentials.store';

const ctx: MeriContext = { tenantId: 't', userId: 'u', clerkUserId: 'c', role: 'standard_user' };
const config = {
  get: (k: string) =>
    (
      ({ MERIV2_API_BASE_URL: 'http://api.test', INTERNAL_SERVICE_SECRET: 'SERVICE' }) as Record<
        string,
        string
      >
    )[k],
} as unknown as ConfigService;

describe('ApiClientContextRepo', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('uses the canonical rich tool and preserves delegated identity and page options', async () => {
    const calls: Array<{
      url: unknown;
      init: { headers: Record<string, string>; method: string; body: string };
    }> = [];
    const richContext = {
      context: { client: { id: 'cid', name: 'Acme' }, recentMeetings: [{ id: 'meeting-1' }] },
      profile: { capabilities: [{ id: 'cap-26', description: 'Complete capability evidence' }] },
      profileSections: {
        capabilities: { total: 26, returned: 1, nextCursor: null, status: 'complete' },
      },
    };
    global.fetch = (async (
      url: unknown,
      init: { headers: Record<string, string>; method: string; body: string },
    ) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => richContext };
    }) as unknown as typeof fetch;

    const repo = new ApiClientContextRepo(new ApiToolExecutorRepo(config));
    const result = await RequestCredentialsStore.run(
      { bearerToken: 'TOK', impersonateTenantId: 'effective-tenant' },
      () =>
        repo.loadClientContext(ctx, 'cid', { section: 'capabilities', cursor: 'NEXT', limit: 10 }),
    );

    expect(result.client.id).toBe('cid');
    expect(result.profile).toEqual(richContext.profile);
    expect(result.profileSections).toEqual(richContext.profileSections);
    expect(result.recentMeetings).toEqual(richContext.context.recentMeetings);
    expect(calls[0]?.url).toBe('http://api.test/api/clio/tools/get_client_context');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers.authorization).toBe('Bearer TOK');
    expect(calls[0]?.init.headers['x-internal-service-secret']).toBe('SERVICE');
    expect(calls[0]?.init.headers['x-capiro-impersonate-tenant']).toBe('effective-tenant');
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      clientId: 'cid',
      section: 'capabilities',
      cursor: 'NEXT',
      limit: 10,
    });
  });

  it('throws when no forwarded credential is in scope', async () => {
    const repo = new ApiClientContextRepo(new ApiToolExecutorRepo(config));
    await expect(repo.loadClientContext(ctx, 'cid')).rejects.toThrow(/forwarded credential/);
  });

  it('throws on a non-ok api response', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'denied',
    })) as unknown as typeof fetch;
    const repo = new ApiClientContextRepo(new ApiToolExecutorRepo(config));
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'TOK' }, () => repo.loadClientContext(ctx, 'cid')),
    ).rejects.toThrow(/403/);
  });

  it('does not turn a malformed rich response into empty context', async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ error: 'unavailable' }),
    })) as unknown as typeof fetch;
    const repo = new ApiClientContextRepo(new ApiToolExecutorRepo(config));
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'TOK' }, () => repo.loadClientContext(ctx, 'cid')),
    ).rejects.toThrow(/missing its client context/);
  });

  it('keeps all section cursors ahead of large profile and engagement text under the real prompt cap', async () => {
    const sectionNames = ['capabilities', 'people', 'facilities', 'submissionHistory', 'advocacyMatters', 'advocacyRecords'];
    const payload = {
      tool: 'get_client_context',
      profileSections: Object.fromEntries(
        sectionNames.map((section) => [
          section,
          {
            status: 'partial',
            total: 100,
            returned: 25,
            nextCursor: `${section}-next-page`,
          },
        ]),
      ),
      coverageNote: 'Unavailable sections are not empty.',
      profile: { capabilities: [{ id: 'cap-1', description: 'x'.repeat(30000) }] },
      context: {
        client: { id: 'cid', name: 'Acme' },
        recentMeetings: [{ description: 'y'.repeat(30000) }],
      },
    };
    global.fetch = (async () => ({
      ok: true,
      json: async () => payload,
    })) as unknown as typeof fetch;
    const repo = new ApiClientContextRepo(new ApiToolExecutorRepo(config));
    const result = await RequestCredentialsStore.run({ bearerToken: 'TOK' }, () =>
      repo.loadClientContext(ctx, 'cid'),
    );
    const prompt = wrapToolResultForPrompt('get_client_context', result, 12000);
    for (const section of sectionNames) expect(prompt).toContain(`${section}-next-page`);
    expect(prompt).toContain('Unavailable sections are not empty.');
    expect(prompt).toContain('[truncated tool result]');
  });
});
