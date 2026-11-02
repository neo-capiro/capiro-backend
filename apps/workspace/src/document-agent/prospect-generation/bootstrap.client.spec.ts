import { ProspectGenerationBootstrapClient } from './bootstrap.client.js';
import { workspaceGenerationConversationId } from '@capiro/shared/workspace-prospect-generation-source';

describe('prospect generation Core registration transport', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001',
    actorId = '00000000-0000-4000-8000-000000000002';
  const source = {
    schemaVersion: 1 as const,
    requestId: 'wsgen:' + 'a'.repeat(64),
    draftId: '00000000-0000-4000-8000-000000000003',
    prospectId: '00000000-0000-4000-8000-000000000004',
    sourceVersionId: '00000000-0000-4000-8000-000000000005',
    sourceSnapshotHash: 'b'.repeat(64),
  };
  const receipt = {
    schemaVersion: 1,
    tenantId,
    actorId,
    source,
    conversationId: workspaceGenerationConversationId(source.requestId),
  };
  const client = new ProspectGenerationBootstrapClient(),
    originalFetch = global.fetch;
  const before = { api: process.env.API_BASE_URL, secret: process.env.INTERNAL_SERVICE_SECRET };
  const fetcher = jest.fn();
  beforeEach(() => {
    process.env.API_BASE_URL = 'https://core.internal.example';
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-service-secret';
    global.fetch = fetcher;
    fetcher.mockReset().mockResolvedValue(new Response(JSON.stringify(receipt)));
  });
  afterAll(() => {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries({
      API_BASE_URL: before.api,
      INTERNAL_SERVICE_SECRET: before.secret,
    }))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  it('binds tenant, actor, source and derived conversation and carries only current credentials', async () => {
    expect(await client.register(tenantId, actorId, source, 'current-session')).toBe(
      receipt.conversationId,
    );
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe(
      'https://core.internal.example/api/clio/conversations/workspace-generation',
    );
    expect(options.redirect).toBe('error');
    expect(options.headers.authorization).toBe('Bearer current-session');
    expect(JSON.parse(options.body)).toEqual(source);
  });
  it.each([
    { ...receipt, actorId: tenantId },
    { ...receipt, tenantId: actorId },
    { ...receipt, conversationId: source.draftId },
    { ...receipt, source: { ...source, sourceSnapshotHash: 'c'.repeat(64) } },
    { ...receipt, extra: true },
  ])('rejects a mismatched registration receipt', async (body) => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(client.register(tenantId, actorId, source, 'session')).rejects.toMatchObject({
      status: 503,
    });
  });
  it('bounds response bytes and refuses unsafe origins before forwarding credentials', async () => {
    fetcher.mockResolvedValue(new Response('x'.repeat(8193)));
    await expect(client.register(tenantId, actorId, source, 'session')).rejects.toMatchObject({
      status: 503,
    });
    process.env.API_BASE_URL = 'http://external.example';
    expect(client.configured()).toBe(false);
    await expect(client.register(tenantId, actorId, source, 'session')).rejects.toMatchObject({
      status: 503,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 409])('preserves a known current refusal (%i)', async (status) => {
    fetcher.mockResolvedValue(new Response('{}', { status }));
    await expect(client.register(tenantId, actorId, source, 'session')).rejects.toMatchObject({
      status: status === 409 ? 409 : 403,
    });
  });
});
