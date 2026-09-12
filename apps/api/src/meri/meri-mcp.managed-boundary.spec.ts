import type { TenantContext } from '@capiro/shared';
import { MeriMcpService } from './meri-mcp.service.js';
import { createMcpClient } from './meri-mcp-transport.js';

jest.mock('./meri-mcp-transport.js', () => ({ createMcpClient: jest.fn() }));

const ctx = { tenantId: 'tenant', userId: 'owner', role: 'standard_user' } as unknown as TenantContext;
function make() {
  const row = {
    id: 'server', tenantId: 'tenant', ownerUserId: 'owner', scope: 'user', enabled: true,
    name: 'meriv3-airtable', catalogId: 'meriv3-airtable', endpoint: 'https://mcp.airtable.com/mcp',
    transport: 'http', authType: 'oauth', connectionStatus: 'connected',
    toolAllowlist: ['list_bases', 'execute_api'], readOnlyTools: ['list_bases', 'execute_api'],
  };
  const tx = { clioMcpServer: {
    findFirst: jest.fn(async () => row),
    findMany: jest.fn(async () => [row]),
    update: jest.fn(async () => row),
    updateMany: jest.fn(async () => ({ count: 1 })),
  } };
  const prisma = { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) };
  const config = { get: jest.fn((key: string) => key === 'CLIO_MCP_ENABLED' ? true : undefined) };
  const oauth = { isConfigured: jest.fn(() => true), buildProvider: jest.fn(() => ({})) };
  const client = {
    listTools: jest.fn(async () => [
      { name: 'list_bases', inputSchema: { type: 'object' } },
      { name: 'execute_api', inputSchema: { type: 'object' } },
    ]),
    callTool: jest.fn(async (): Promise<unknown> => ({ content: [{ type: 'text', text: 'fixture' }] })),
  };
  jest.mocked(createMcpClient).mockReturnValue(client);
  return { service: new MeriMcpService(prisma as never, config as never, oauth as never), row, tx, client, oauth };
}

describe('managed MCP runtime boundary', () => {
  const originalEnabled = process.env.MERI_MCP_AIRTABLE_ENABLED;
  beforeEach(() => { process.env.MERI_MCP_AIRTABLE_ENABLED = 'true'; jest.clearAllMocks(); });
  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.MERI_MCP_AIRTABLE_ENABLED;
    else process.env.MERI_MCP_AIRTABLE_ENABLED = originalEnabled;
  });

  test('discovery strips writes and leaves a managed authorization pending', async () => {
    const { service, tx } = make();
    expect(await service.discoverTools('tenant', 'server')).toBe(1);
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ toolAllowlist: ['list_bases'], readOnlyTools: ['list_bases'], connectionStatus: 'pending' }),
    }));
  });

  test('an authenticated discovery failure records error instead of connected', async () => {
    const { service, client, tx } = make();
    client.listTools.mockRejectedValue(new Error('provider unavailable'));
    expect(await service.discoverTools('tenant', 'server')).toBe(0);
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ connectionStatus: 'error' }),
    }));
  });

  test('unknown tools stay blocked even when persisted in a legacy allowlist', async () => {
    const { service, client } = make();
    const schemas = await service.bridgedSchemasFor(ctx);
    expect(schemas.map((s) => s.name)).toEqual(['mcp__meriv3_airtable__list_bases']);
    await expect(service.executeBridged(ctx, 'mcp__meriv3_airtable__execute_api', {})).rejects.toThrow();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test('a disconnect on another API replica removes cached schemas and prevents execution', async () => {
    const { service, row, client } = make();
    await service.bridgedSchemasFor(ctx);
    row.connectionStatus = 'disconnected';
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    await expect(service.executeBridged(ctx, 'mcp__meriv3_airtable__list_bases', {})).rejects.toThrow('reconnect');
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test('provider availability gates cached schemas and execution', async () => {
    const { service, client } = make();
    await service.bridgedSchemasFor(ctx);
    process.env.MERI_MCP_AIRTABLE_ENABLED = 'false';
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    await expect(service.executeBridged(ctx, 'mcp__meriv3_airtable__list_bases', {})).rejects.toThrow();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test('provider isError results are failures, never successful fixture reads', async () => {
    const { service, client } = make();
    await service.bridgedSchemasFor(ctx);
    client.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'denied' }] });
    await expect(service.executeBridged(ctx, 'mcp__meriv3_airtable__list_bases', {})).rejects.toThrow('could not complete');
  });

  test('the legacy settings route cannot alter managed endpoints or permissions', async () => {
    const { service, tx } = make();
    await expect(service.updateServer(ctx, 'server', { endpoint: 'https://elsewhere.example' })).rejects.toThrow('Meri integrations');
    expect(tx.clioMcpServer.update).not.toHaveBeenCalled();
  });
});
