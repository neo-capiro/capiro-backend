import type { TenantContext } from '@capiro/shared';
import { MeriMcpService } from './meri-mcp.service.js';
import { createMcpClient } from './meri-mcp-transport.js';

jest.mock('./meri-mcp-transport.js', () => ({ createMcpClient: jest.fn() }));

const ctx = { tenantId: 'tenant', userId: 'owner', role: 'standard_user' } as TenantContext;
const tool = 'mcp__notion__search';

function fixture() {
  const row = {
    id: 'server', tenantId: ctx.tenantId, ownerUserId: ctx.userId, scope: 'user',
    enabled: true, name: 'notion', catalogId: 'notion', transport: 'http',
    endpoint: 'https://mcp.notion.com/mcp', authType: 'oauth', connectionStatus: 'connected',
    toolAllowlist: ['search'], readOnlyTools: ['search'],
    updatedAt: new Date('2026-10-31T00:00:00Z'),
    lastError: null as string | null,
  };
  const tx = {
    clioMcpServer: {
      findFirst: jest.fn(async () => structuredClone(row)),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        row.tenantId === where.tenantId && (!where.enabled || row.enabled) &&
          (row.scope === 'tenant' || row.ownerUserId === ctx.userId) ? [row] : []),
      update: jest.fn(async ({ data }: { data: object }) => Object.assign(row, data)),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
        if (where.updatedAt && (where.updatedAt as Date).getTime() !== row.updatedAt.getTime()) return { count: 0 };
        if (where.enabled === true && !row.enabled) return { count: 0 };
        if (typeof where.connectionStatus === 'string' && where.connectionStatus !== row.connectionStatus) return { count: 0 };
        if (where.connectionStatus && typeof where.connectionStatus === 'object' &&
            'not' in where.connectionStatus && where.connectionStatus.not === row.connectionStatus) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      delete: jest.fn(async () => row),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
  const client = {
    listTools: jest.fn(async () => [{ name: 'search', inputSchema: { type: 'object' } }]),
    callTool: jest.fn(async (): Promise<unknown> => ({ content: [{ type: 'text', text: 'fixture' }] })),
  };
  jest.mocked(createMcpClient).mockReturnValue(client);
  const service = new MeriMcpService(
    { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) } as never,
    { get: (key: string) => key === 'CLIO_MCP_ENABLED' } as never,
    { isConfigured: () => true, buildProvider: () => ({}) } as never,
  );
  return { service, row, tx, client };
}

describe('generic catalog current authorization', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an unchanged allowed tool remains advertised and executes once', async () => {
    const { service, client } = fixture();
    expect((await service.bridgedSchemasFor(ctx)).map((s) => s.name)).toEqual([tool]);
    await expect(service.executeBridged(ctx, tool, {})).resolves.toMatchObject({ tool });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  test.each(['removed tool', 'empty allowlist', 'read-only changed', 'renamed', 'disabled', 'foreign owner', 'foreign tenant', 'pending', 'needs_reauth', 'disconnected'])(
    '%s refuses cached advertisement and execution without provider I/O', async (change) => {
      const { service, row, client } = fixture();
      expect(await service.bridgedSchemasFor(ctx)).toHaveLength(1);
      if (change === 'removed tool') row.toolAllowlist = ['another_tool'];
      else if (change === 'empty allowlist') row.toolAllowlist = [];
      else if (change === 'read-only changed') row.readOnlyTools = [];
      else if (change === 'renamed') row.name = 'other';
      else if (change === 'disabled') row.enabled = false;
      else if (change === 'foreign owner') row.ownerUserId = 'other';
      else if (change === 'foreign tenant') row.tenantId = 'other';
      else row.connectionStatus = change;
      client.listTools.mockClear();
      expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
      await expect(service.executeBridged(ctx, tool, {})).rejects.toThrow();
      expect(client.listTools).not.toHaveBeenCalled();
      expect(client.callTool).not.toHaveBeenCalled();
    },
  );

  test('empty allowlist and unknown tool never authorize provider calls', async () => {
    const { service, row, client } = fixture();
    row.toolAllowlist = [];
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    await expect(service.executeBridged(ctx, tool, {})).rejects.toThrow();
    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test('catalog rediscovery cannot add an unexpected provider tool to the current allowlist', async () => {
    const { service, row, client } = fixture();
    client.listTools.mockResolvedValue([
      { name: 'search', inputSchema: { type: 'object' } },
      { name: 'delete_everything', inputSchema: { type: 'object' } },
    ]);
    expect(await service.discoverTools('tenant', 'server')).toBe(1);
    expect(row.toolAllowlist).toEqual(['search']);
    await expect(service.executeBridged(ctx, 'mcp__notion__delete_everything', {})).rejects.toThrow();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test('catalog rediscovery preserves an empty policy and reports unavailable tools', async () => {
    const { service, row } = fixture();
    row.toolAllowlist = [];
    expect(await service.discoverTools('tenant', 'server')).toBe(0);
    expect(row.toolAllowlist).toEqual([]);
    expect(row.connectionStatus).toBe('error');
  });

  test.each(['disconnected', 'pending'])('in-flight discovery cannot overwrite a newer %s state', async (status) => {
    const { service, row, client } = fixture();
    client.listTools.mockImplementation(async () => {
      row.connectionStatus = status;
      return [{ name: 'search', inputSchema: { type: 'object' } }];
    });
    expect(await service.discoverTools('tenant', 'server')).toBe(0);
    expect(row.connectionStatus).toBe(status);
  });

  test('discovery does not overwrite a policy narrowed during provider I/O', async () => {
    const { service, row, client } = fixture();
    client.listTools.mockImplementation(async () => {
      row.toolAllowlist = [];
      row.readOnlyTools = [];
      return [{ name: 'search', inputSchema: { type: 'object' } }];
    });
    row.connectionStatus = 'pending';
    expect(await service.discoverTools('tenant', 'server')).toBe(0);
    expect(row.connectionStatus).not.toBe('connected');
    expect(row.toolAllowlist).toEqual([]);
    expect(row.readOnlyTools).toEqual([]);
    await expect(service.executeBridged(ctx, tool, {})).rejects.toThrow();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  test.each(['InvalidTokenError', 'InvalidGrantError', 'UnauthorizedError', 'Error'])(
    'generic OAuth discovery %s does not retain a connected badge', async (name) => {
      const { service, row, client } = fixture();
      client.listTools.mockRejectedValue(Object.assign(new Error('private provider detail'), { name }));
      expect(await service.discoverTools('tenant', 'server')).toBe(0);
      expect(row.connectionStatus).toBe(name === 'Error' ? 'error' : 'needs_reauth');
      expect(row).toMatchObject({ lastError: 'Tool discovery failed.' });
      expect(client.callTool).not.toHaveBeenCalled();
    },
  );

  test('a foreign personal row cannot be removed by an administrator', async () => {
    const { service, row, tx } = fixture();
    row.ownerUserId = 'other';
    await expect(service.deleteServer({ ...ctx, role: 'capiro_admin' }, 'server')).rejects.toThrow();
    expect(tx.clioMcpServer.delete).not.toHaveBeenCalled();
  });

  test('readiness compares the post-discovery revision before writing', async () => {
    const { service, row, tx } = fixture();
    row.connectionStatus = 'pending';
    const update = tx.clioMcpServer.updateMany.getMockImplementation()!;
    tx.clioMcpServer.updateMany.mockImplementation(async (args) => {
      row.updatedAt = new Date(row.updatedAt.getTime() + 1);
      return update(args);
    });
    expect(await service.discoverTools('tenant', 'server')).toBe(0);
    expect(row.connectionStatus).toBe('pending');
  });

  test('token refresh revision changes during discovery still permit current readiness', async () => {
    const { service, row, client } = fixture();
    row.connectionStatus = 'pending';
    client.listTools.mockImplementation(async () => {
      row.updatedAt = new Date(row.updatedAt.getTime() + 1);
      return [{ name: 'search', inputSchema: { type: 'object' } }];
    });
    expect(await service.discoverTools('tenant', 'server')).toBe(1);
    expect(row.connectionStatus).toBe('connected');
  });

  test.each(['Error', 'UnauthorizedError'])('generic registry %s records a sanitized unavailable state', async (name) => {
    const { service, row, client } = fixture();
    client.listTools.mockRejectedValue(Object.assign(new Error('synthetic private detail'), { name }));
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    expect(row.connectionStatus).toBe(name === 'Error' ? 'error' : 'needs_reauth');
    expect(row).toMatchObject({ lastError: 'Tool discovery failed.' });
  });

  test.each(['pending', 'disconnected', 'new revision'])('stale registry error preserves a newer %s', async (change) => {
    const { service, row, client } = fixture();
    client.listTools.mockImplementation(async () => {
      if (change === 'new revision') row.updatedAt = new Date(row.updatedAt.getTime() + 1);
      else row.connectionStatus = change;
      throw Object.assign(new Error('synthetic auth failure'), { name: 'UnauthorizedError' });
    });
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    expect(row.connectionStatus).toBe(change === 'new revision' ? 'connected' : change);
  });

  test('stale registry success cannot erase a newer authorization error', async () => {
    const { service, row, client } = fixture();
    client.listTools.mockImplementation(async () => {
      row.connectionStatus = 'error';
      row.lastError = 'New authorization failed.';
      return [{ name: 'search', inputSchema: { type: 'object' } }];
    });
    expect(await service.bridgedSchemasFor(ctx)).toEqual([]);
    expect(row.lastError).toBe('New authorization failed.');
    expect(row.connectionStatus).toBe('error');
  });
});
