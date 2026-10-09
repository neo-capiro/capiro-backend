import type { TenantContext } from '@capiro/shared';
import { MeriMcpService } from './meri-mcp.service.js';
import { createMcpClient } from './meri-mcp-transport.js';

jest.mock('./meri-mcp-transport.js', () => ({ createMcpClient: jest.fn() }));

const ctx = {
  tenantId: 'tenant',
  userId: 'owner',
  role: 'standard_user',
} as unknown as TenantContext;
function make() {
  const row = {
    id: 'server',
    tenantId: 'tenant',
    ownerUserId: 'owner',
    scope: 'user',
    enabled: true,
    name: 'meriv3-airtable',
    catalogId: 'meriv3-airtable',
    endpoint: 'https://mcp.airtable.com/mcp',
    transport: 'http',
    authType: 'oauth',
    connectionStatus: 'connected',
    toolAllowlist: ['list_bases', 'execute_api'],
    readOnlyTools: ['list_bases', 'execute_api'],
  };
  const tx = {
    tenant: { findUnique: jest.fn(async () => ({ slug: 'capiro-internal', settings: { clioFeatureFlags: { 'notetaker.krisp.enabled': true } } })) },
    clioMcpServer: {
      findFirst: jest.fn(async () => row),
      findMany: jest.fn(async () => [row]),
      update: jest.fn(async () => row),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) };
  const config = { get: jest.fn((key: string) => (key === 'CLIO_MCP_ENABLED' ? true : undefined)) };
  const oauth = { isConfigured: jest.fn(() => true), buildProvider: jest.fn(() => ({})) };
  const client = {
    listTools: jest.fn(async () => [
      { name: 'list_bases', inputSchema: { type: 'object' } },
      { name: 'execute_api', inputSchema: { type: 'object' } },
    ]),
    callTool: jest.fn(async (): Promise<unknown> => ({
      content: [{ type: 'text', text: 'fixture' }],
    })),
  };
  jest.mocked(createMcpClient).mockReturnValue(client);
  return {
    service: new MeriMcpService(prisma as never, config as never, oauth as never),
    row,
    tx,
    client,
    oauth,
  };
}

describe('Google Drive preview runtime authorization', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MERI_MCP_GOOGLE_DRIVE_ENABLED: 'true',
      MERI_MCP_GOOGLE_DRIVE_CLIENT_ID: 'id',
      MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET: 'secret',
      MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS: 'owner',
      MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS: 'tenant',
    };
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
  });
  function drive() {
    const result = make();
    Object.assign(result.row, {
      name: 'meriv3-google-drive',
      catalogId: 'meriv3-google-drive',
      endpoint: 'https://drivemcp.googleapis.com/mcp/v1',
      toolAllowlist: ['search_files', 'create_file'],
      readOnlyTools: ['search_files', 'create_file'],
    });
    result.client.listTools.mockResolvedValue([
      { name: 'search_files', inputSchema: { type: 'object' } },
      { name: 'create_file', inputSchema: { type: 'object' } },
    ]);
    return result;
  }
  test.each(['owner', 'tenant'])(
    'revoking the %s blocks cached tools, execution, and rediscovery',
    async (kind) => {
      const { service, client } = drive();
      expect((await service.bridgedSchemasFor(ctx)).map((s) => s.name)).toEqual([
        'mcp__meriv3_google_drive__search_files',
      ]);
      if (kind === 'owner') delete process.env.MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS;
      else delete process.env.MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS;
      client.listTools.mockClear();
      expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
      await expect(
        service.executeBridged(ctx, 'mcp__meriv3_google_drive__search_files', {}),
      ).rejects.toThrow();
      expect(await service.discoverTools('tenant', 'server')).toBe(0);
      expect(client.callTool).not.toHaveBeenCalled();
      expect(client.listTools).not.toHaveBeenCalled();
    },
  );
});

describe('managed MCP runtime boundary', () => {
  const originalEnabled = process.env.MERI_MCP_AIRTABLE_ENABLED;
  beforeEach(() => {
    process.env.MERI_MCP_AIRTABLE_ENABLED = 'true';
    jest.clearAllMocks();
  });
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.MERI_MCP_AIRTABLE_ENABLED;
    else process.env.MERI_MCP_AIRTABLE_ENABLED = originalEnabled;
  });

  test('discovery strips writes and leaves a managed authorization pending', async () => {
    const { service, tx } = make();
    expect(await service.discoverTools('tenant', 'server')).toBe(1);
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toolAllowlist: ['list_bases'],
          readOnlyTools: ['list_bases'],
          connectionStatus: 'pending',
        }),
      }),
    );
  });

  test('Krisp throttling preserves connection state and retries discovery after a minute', async () => {
    const { service, tx, row, client } = make();
    Object.assign(row, { name: 'meriv3-krisp', catalogId: 'meriv3-krisp', endpoint: 'https://mcp.krisp.ai/mcp', toolAllowlist: ['search_meetings'], readOnlyTools: ['search_meetings'] });
    client.listTools.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { code: 429 }));
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
      expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { lastError: 'The app could not be reached. Please try again.' } }));
      client.listTools.mockResolvedValue([{ name: 'search_meetings', inputSchema: { type: 'object' } }]);
      now.mockReturnValue(1_061_000);
      expect((await service.bridgedSchemasFor(ctx)).map(t => t.name)).toEqual(['mcp__meriv3_krisp__search_meetings']);
      expect(client.listTools).toHaveBeenCalledTimes(2);
    } finally { now.mockRestore(); }
  });

  test('Krisp invalid credentials still require reauthentication', async () => {
    const { service, tx, row, client } = make();
    Object.assign(row, { name: 'meriv3-krisp', catalogId: 'meriv3-krisp', endpoint: 'https://mcp.krisp.ai/mcp', toolAllowlist: ['search_meetings'], readOnlyTools: ['search_meetings'] });
    client.listTools.mockRejectedValue(Object.assign(new Error('expired'), { name: 'InvalidTokenError', code: 429 }));
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ connectionStatus: 'needs_reauth' }) }));
  });

  test('an authenticated discovery failure records error instead of connected', async () => {
    const { service, client, tx } = make();
    client.listTools.mockRejectedValue(new Error('provider unavailable'));
    expect(await service.discoverTools('tenant', 'server')).toBe(0);
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ connectionStatus: 'error' }),
      }),
    );
  });

  test('unknown tools stay blocked even when persisted in a legacy allowlist', async () => {
    const { service, client } = make();
    const schemas = await service.bridgedSchemasFor(ctx);
    expect(schemas.map((s) => s.name)).toEqual(['mcp__meriv3_airtable__list_bases']);
    await expect(
      service.executeBridged(ctx, 'mcp__meriv3_airtable__execute_api', {}),
    ).rejects.toThrow();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test('a disconnect on another API replica removes cached schemas and prevents execution', async () => {
    const { service, row, client } = make();
    await service.bridgedSchemasFor(ctx);
    row.connectionStatus = 'disconnected';
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    await expect(
      service.executeBridged(ctx, 'mcp__meriv3_airtable__list_bases', {}),
    ).rejects.toThrow('reconnect');
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test('provider availability gates cached schemas and execution', async () => {
    const { service, client } = make();
    await service.bridgedSchemasFor(ctx);
    process.env.MERI_MCP_AIRTABLE_ENABLED = 'false';
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    await expect(
      service.executeBridged(ctx, 'mcp__meriv3_airtable__list_bases', {}),
    ).rejects.toThrow();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test('provider isError results are failures, never successful fixture reads', async () => {
    const { service, client } = make();
    await service.bridgedSchemasFor(ctx);
    client.callTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'denied' }],
    });
    await expect(
      service.executeBridged(ctx, 'mcp__meriv3_airtable__list_bases', {}),
    ).rejects.toThrow('could not complete');
  });

  test('the legacy settings route cannot alter managed endpoints or permissions', async () => {
    const { service, tx } = make();
    await expect(
      service.updateServer(ctx, 'server', { endpoint: 'https://elsewhere.example' }),
    ).rejects.toThrow('Meri integrations');
    expect(tx.clioMcpServer.update).not.toHaveBeenCalled();
  });
});


describe('Krisp tenant rollout at the MCP execution boundary', () => {
  test('flag rollback blocks cached schemas, calls, and tool rediscovery immediately', async () => {
    const { service, row, tx, client } = make();
    Object.assign(row, { name: 'meriv3-krisp', catalogId: 'meriv3-krisp', endpoint: 'https://mcp.krisp.ai/mcp',
      toolAllowlist: ['search_meetings', 'import_recording'], readOnlyTools: ['search_meetings', 'import_recording'] });
    client.listTools.mockResolvedValue([{ name: 'search_meetings', inputSchema: { type: 'object' } }, { name: 'import_recording', inputSchema: { type: 'object' } }]);
    expect((await service.bridgedSchemasFor(ctx)).map((tool) => tool.name)).toEqual(['mcp__meriv3_krisp__search_meetings']);
    tx.tenant.findUnique.mockResolvedValue({ slug: 'capiro-internal', settings: { clioFeatureFlags: { 'notetaker.krisp.enabled': false } } });
    client.listTools.mockClear(); client.callTool.mockClear();
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    await expect(service.executeBridged(ctx, 'mcp__meriv3_krisp__search_meetings', {})).rejects.toThrow();
    expect(await service.discoverTools('tenant', 'server')).toBe(0);
    expect(client.listTools).not.toHaveBeenCalled(); expect(client.callTool).not.toHaveBeenCalled();
  });
});

/**
 * Additive detailed seam at the MCP owner boundary: identical schemas plus
 * bounded, non-disclosing failure metadata. Raw per-server failures are exposed
 * here for the managed owner to filter; a recorded failure is never a schema and
 * never authorizes a tool.
 */
describe('managed catalog availability seam at the MCP owner boundary', () => {
  const originalEnabled = process.env.MERI_MCP_AIRTABLE_ENABLED;
  beforeEach(() => {
    process.env.MERI_MCP_AIRTABLE_ENABLED = 'true';
    jest.clearAllMocks();
  });
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.MERI_MCP_AIRTABLE_ENABLED;
    else process.env.MERI_MCP_AIRTABLE_ENABLED = originalEnabled;
  });

  test('bridgedSchemasFor keeps its array contract beside the detailed seam', async () => {
    const { service } = make();
    expect((await service.bridgedSchemasFor(ctx)).map((s) => s.name)).toEqual([
      'mcp__meriv3_airtable__list_bases',
    ]);
    const detailed = await service.bridgedSchemasDetailedFor(ctx);
    expect(detailed.schemas.map((s) => s.name)).toEqual(['mcp__meriv3_airtable__list_bases']);
    expect(detailed.failures).toEqual([]);
    expect(detailed.registryUnavailable).toBe(false);
  });

  test('a provider listTools outage is recorded as a managed failure, not a silent empty', async () => {
    const { service, client } = make();
    client.listTools.mockRejectedValue(new Error('provider unavailable'));
    const result = await service.bridgedSchemasDetailedFor(ctx);
    expect(result.schemas).toEqual([]);
    expect(result.registryUnavailable).toBe(false);
    expect(result.failures).toEqual([
      { serverId: 'server', managedAppId: 'airtable', reason: 'unavailable' },
    ]);
  });

  test('an authorization failure classifies as needs_reauth', async () => {
    const { service, client } = make();
    client.listTools.mockRejectedValue(
      Object.assign(new Error('expired'), { name: 'InvalidTokenError' }),
    );
    const result = await service.bridgedSchemasDetailedFor(ctx);
    expect(result.failures).toEqual([
      { serverId: 'server', managedAppId: 'airtable', reason: 'needs_reauth' },
    ]);
  });

  test('a managed app with no supported read tool classifies as malformed', async () => {
    const { service, client } = make();
    client.listTools.mockResolvedValue([{ name: 'execute_api', inputSchema: { type: 'object' } }]);
    const result = await service.bridgedSchemasDetailedFor(ctx);
    expect(result.schemas).toEqual([]);
    expect(result.failures).toEqual([
      { serverId: 'server', managedAppId: 'airtable', reason: 'malformed' },
    ]);
  });

  test('a registry snapshot failure is registryUnavailable, never an empty success', async () => {
    const { service, tx } = make();
    tx.clioMcpServer.findMany.mockRejectedValue(new Error('db down'));
    const result = await service.bridgedSchemasDetailedFor(ctx);
    expect(result.schemas).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.registryUnavailable).toBe(true);
  });

  test('cacheOnly peeks the existing snapshot with zero provider I/O', async () => {
    const { service, client } = make();
    client.listTools.mockRejectedValue(new Error('provider unavailable'));
    const first = await service.bridgedSchemasDetailedFor(ctx);
    expect(first.failures).toEqual([
      { serverId: 'server', managedAppId: 'airtable', reason: 'unavailable' },
    ]);
    expect(client.listTools).toHaveBeenCalledTimes(1);

    const peek = await service.bridgedSchemasDetailedFor(ctx, { cacheOnly: true });
    expect(peek.failures).toEqual([
      { serverId: 'server', managedAppId: 'airtable', reason: 'unavailable' },
    ]);
    expect(peek.registryUnavailable).toBe(false);
    expect(client.listTools).toHaveBeenCalledTimes(1);
  });

  test('cacheOnly with no existing snapshot performs zero provider I/O', async () => {
    const { service, client } = make();
    const peek = await service.bridgedSchemasDetailedFor(ctx, { cacheOnly: true });
    expect(peek).toEqual({ schemas: [], failures: [], registryUnavailable: false });
    expect(client.listTools).not.toHaveBeenCalled();
  });

  test.each(['disconnected', 'pending'] as const)(
    'a deliberate %s after discovery is not reported as a failure',
    async (status) => {
      const { service, row, client } = make();
      client.listTools.mockRejectedValue(new Error('provider unavailable'));

      const first = await service.bridgedSchemasDetailedFor(ctx);
      expect(first.failures).toEqual([
        { serverId: 'server', managedAppId: 'airtable', reason: 'unavailable' },
      ]);
      expect(client.listTools).toHaveBeenCalledTimes(1);

      // A cross-replica intentional disconnect/pending lands after discovery but
      // before the fresh visibility read: the current row is no longer an outage.
      row.connectionStatus = status;

      const second = await service.bridgedSchemasDetailedFor(ctx);
      expect(second.failures).toEqual([]);
      expect(second.schemas).toEqual([]);
      // No rediscovery: the cached snapshot is still within its TTL.
      expect(client.listTools).toHaveBeenCalledTimes(1);
    },
  );

  const genericCases: Array<[('token' | 'none'), ('disconnected' | 'pending')]> = [
    ['token', 'disconnected'],
    ['token', 'pending'],
    ['none', 'disconnected'],
    ['none', 'pending'],
  ];

  test.each(genericCases)(
    'a genuine generic %s connector failure with %s metadata is still reported',
    async (authType, status) => {
      const { service, row, client } = make();
      // A generic (catalog-less) token/none connector: the connection status is
      // NOT a discovery/execution gate (only OAuth is skipped when non-connected
      // — see registryFor/executeBridged), so a genuine listTools failure is a
      // real outage and must not be masked by the deliberate-disconnect policy.
      Object.assign(row, {
        id: 'srv-generic',
        name: 'custom-connector',
        catalogId: null,
        endpoint: 'https://custom.example/mcp',
        authType,
        connectionStatus: status,
        toolAllowlist: ['thing'],
        readOnlyTools: ['thing'],
      });
      client.listTools.mockRejectedValue(new Error('provider unavailable'));

      const first = await service.bridgedSchemasDetailedFor(ctx);
      expect(first.schemas).toEqual([]);
      expect(first.registryUnavailable).toBe(false);
      expect(first.failures).toEqual([
        { serverId: 'srv-generic', managedAppId: null, reason: 'unavailable' },
      ]);
      expect(client.listTools).toHaveBeenCalledTimes(1);

      // Bounded failure retained across a cached repeat with no rediscovery.
      const second = await service.bridgedSchemasDetailedFor(ctx);
      expect(second.failures).toEqual([
        { serverId: 'srv-generic', managedAppId: null, reason: 'unavailable' },
      ]);
      expect(second.schemas).toEqual([]);
      expect(client.listTools).toHaveBeenCalledTimes(1);
      expect(client.callTool).not.toHaveBeenCalled();
    },
  );

  test('global MCP disable is deliberate: no failure and no registry outage', async () => {
    const tx = {
      tenant: { findUnique: jest.fn(async () => null) },
      clioMcpServer: { findMany: jest.fn(async () => []) },
    };
    const prisma = { withTenant: jest.fn(async (_t: string, fn: (value: unknown) => unknown) => fn(tx)) };
    const config = { get: jest.fn((key: string) => (key === 'CLIO_MCP_ENABLED' ? false : undefined)) };
    const oauth = { isConfigured: jest.fn(() => true) };
    const service = new MeriMcpService(prisma as never, config as never, oauth as never);
    expect(await service.bridgedSchemasDetailedFor(ctx)).toEqual({
      schemas: [],
      failures: [],
      registryUnavailable: false,
    });
  });
});
