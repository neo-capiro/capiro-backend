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
