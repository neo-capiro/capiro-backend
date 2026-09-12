import type { TenantContext } from '@capiro/shared';
import { MeriManagedMcpService } from './meri-managed-mcp.service.js';
import {
  MERIV3_AIRTABLE_CATALOG_ID,
  MERIV3_AIRTABLE_ENDPOINT,
  MERIV3_HUBSPOT_CATALOG_ID,
  MERIV3_HUBSPOT_ENDPOINT,
} from './meri-managed-mcp.helpers.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as unknown as TenantContext;

function make() {
  const tx = {
    clioMcpServer: {
      findMany: jest.fn(async (): Promise<Array<Record<string, unknown>>> => []),
      findFirst: jest.fn(async (): Promise<Record<string, unknown> | null> => null),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async (): Promise<Record<string, unknown>> => ({})),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const mcp = {
    createServer: jest.fn(),
    discoverTools: jest.fn(async () => 2),
    deleteServer: jest.fn(async () => ({ deleted: true })),
    invalidate: jest.fn(),
    bridgedSchemasFor: jest.fn(async () => []),
    isBridgedToolReadOnly: jest.fn(() => true),
    executeBridged: jest.fn(async () => ({ ok: true })),
  };
  const oauth = {
    isConfigured: jest.fn(() => true),
    start: jest.fn(async () => ({ authUrl: 'https://provider.example/authorize' })),
    disconnect: jest.fn(async () => undefined),
  };
  const service = new MeriManagedMcpService(prisma as never, mcp as never, oauth as never);
  return { service, prisma, mcp, oauth, tx };
}

describe('MeriManagedMcpService', () => {
  const originalClientId = process.env.MERI_MCP_HUBSPOT_CLIENT_ID;
  const originalSecret = process.env.MERI_MCP_HUBSPOT_CLIENT_SECRET;
  const originalMcpEnabled = process.env.CLIO_MCP_ENABLED;

  beforeEach(() => {
    process.env.MERI_MCP_HUBSPOT_CLIENT_ID = 'server-owned-client';
    process.env.MERI_MCP_HUBSPOT_CLIENT_SECRET = 'server-owned-secret';
    process.env.CLIO_MCP_ENABLED = 'true';
  });

  afterEach(() => {
    if (originalClientId === undefined) delete process.env.MERI_MCP_HUBSPOT_CLIENT_ID;
    else process.env.MERI_MCP_HUBSPOT_CLIENT_ID = originalClientId;
    if (originalSecret === undefined) delete process.env.MERI_MCP_HUBSPOT_CLIENT_SECRET;
    else process.env.MERI_MCP_HUBSPOT_CLIENT_SECRET = originalSecret;
    if (originalMcpEnabled === undefined) delete process.env.CLIO_MCP_ENABLED;
    else process.env.CLIO_MCP_ENABLED = originalMcpEnabled;
    jest.restoreAllMocks();
  });

  test('lists all four personal apps even when nothing is connected', async () => {
    const { service } = make();
    const apps = await service.listApps(ctx);
    expect(apps.map((app) => app.id)).toEqual(['hubspot', 'airtable', 'monday', 'google-drive']);
    expect(apps.every((app) => app.connected === false)).toBe(true);
    expect(apps.every((app) => app.status === 'disconnected')).toBe(true);
  });

  test('global MCP kill switch makes both managed apps unavailable and refuses connect', async () => {
    process.env.CLIO_MCP_ENABLED = 'false';
    const { service, mcp } = make();
    const apps = await service.listApps(ctx);
    expect(apps.every((app) => app.available === false)).toBe(true);
    await expect(service.connect(ctx, 'hubspot')).rejects.toThrow(
      'Connected apps are temporarily disabled.',
    );
    expect(mcp.createServer).not.toHaveBeenCalled();
  });

  test('HubSpot connection is personal, isolated, and uses server-owned OAuth credentials', async () => {
    const { service, mcp, oauth, tx } = make();
    mcp.createServer.mockResolvedValue({ id: 'hubspot-server' });
    const result = await service.connect(ctx, 'hubspot');
    expect(mcp.createServer).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        name: MERIV3_HUBSPOT_CATALOG_ID,
        transport: 'http',
        endpoint: MERIV3_HUBSPOT_ENDPOINT,
        authType: 'oauth',
        scope: 'user',
        toolAllowlist: [],
        readOnlyTools: [],
        enabled: true,
        oauthClientId: 'server-owned-client',
        oauthClientSecret: 'server-owned-secret',
      }),
    );
    expect(tx.clioMcpServer.update).toHaveBeenCalledWith({
      where: { id: 'hubspot-server' },
      data: { catalogId: MERIV3_HUBSPOT_CATALOG_ID },
    });
    expect(oauth.start).toHaveBeenCalledWith(ctx, 'hubspot-server');
    expect(result.authUrl).toBe('https://provider.example/authorize');
  });

  test('HubSpot fails cleanly when Capiro has not configured its OAuth app', async () => {
    delete process.env.MERI_MCP_HUBSPOT_CLIENT_ID;
    delete process.env.MERI_MCP_HUBSPOT_CLIENT_SECRET;
    const { service, mcp } = make();
    await expect(service.connect(ctx, 'hubspot')).rejects.toThrow(
      'HubSpot is temporarily unavailable. Please try again later.',
    );
    expect(mcp.createServer).not.toHaveBeenCalled();
  });

  test('Airtable uses the official remote MCP endpoint and personal OAuth', async () => {
    const { service, mcp, oauth, tx } = make();
    mcp.createServer.mockResolvedValue({ id: 'airtable-server' });
    await service.connect(ctx, 'airtable');
    expect(mcp.createServer).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        name: MERIV3_AIRTABLE_CATALOG_ID,
        transport: 'http',
        endpoint: MERIV3_AIRTABLE_ENDPOINT,
        authType: 'oauth',
        scope: 'user',
        enabled: true,
      }),
    );
    expect(tx.clioMcpServer.update).toHaveBeenCalledWith({
      where: { id: 'airtable-server' },
      data: { catalogId: MERIV3_AIRTABLE_CATALOG_ID },
    });
    expect(oauth.start).toHaveBeenCalledWith(ctx, 'airtable-server');
  });

  test('unconnected users receive zero managed tool schemas', async () => {
    const { service, mcp } = make();
    await expect(service.schemasForMeriV3(ctx)).resolves.toEqual([]);
    expect(mcp.bridgedSchemasFor).not.toHaveBeenCalled();
  });

  test('OAuth finalization strips provider writes before any MeriV3 schema can use them', async () => {
    const { service, tx, mcp } = make();
    tx.clioMcpServer.findFirst.mockResolvedValue({
      id: 'hubspot-server',
      catalogId: MERIV3_HUBSPOT_CATALOG_ID,
      toolAllowlist: ['get_user_details', 'search_crm_objects', 'create_contact', 'update_deal'],
      readOnlyTools: [],
      connectionStatus: 'pending',
      enabled: true,
    });
    await expect(service.finalizeConnection(ctx.tenantId, 'hubspot-server')).resolves.toBe(2);
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        toolAllowlist: ['get_user_details', 'search_crm_objects'],
        readOnlyTools: ['get_user_details', 'search_crm_objects'],
      },
    }));
    expect(tx.clioMcpServer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ enabled: true, connectionStatus: { in: ['pending', 'connected'] } }),
      data: { connectionStatus: 'connected', lastError: null },
    }));
    expect(mcp.invalidate).toHaveBeenCalledWith(ctx.tenantId);
  });

  test('a failed discovery retains credentials and cannot report success', async () => {
    const { service, mcp, tx } = make();
    tx.clioMcpServer.findMany.mockResolvedValue([{
      id: 'existing', enabled: true, connectionStatus: 'connected', catalogId: MERIV3_HUBSPOT_CATALOG_ID,
    }]);
    mcp.discoverTools.mockResolvedValue(0);
    await expect(service.connect(ctx, 'hubspot')).rejects.toThrow('could not be reached');
    expect(mcp.deleteServer).not.toHaveBeenCalled();
    expect(mcp.createServer).not.toHaveBeenCalled();
  });

  test('revalidates an existing authorization in place', async () => {
    const { service, mcp, tx } = make();
    const row = {
      id: 'existing', enabled: true, connectionStatus: 'connected', catalogId: MERIV3_HUBSPOT_CATALOG_ID,
      toolAllowlist: ['get_user_details'], readOnlyTools: ['get_user_details'],
    };
    tx.clioMcpServer.findMany.mockResolvedValue([row]);
    tx.clioMcpServer.findFirst.mockResolvedValue(row);
    expect((await service.connect(ctx, 'hubspot')).alreadyConnected).toBe(true);
    expect(mcp.discoverTools).toHaveBeenCalledWith(ctx.tenantId, 'existing');
    expect(mcp.deleteServer).not.toHaveBeenCalled();
  });

  test('two simultaneous connect requests share one authorization flow', async () => {
    const { service, mcp, oauth } = make();
    mcp.createServer.mockResolvedValue({ id: 'new' });
    await Promise.all([service.connect(ctx, 'airtable'), service.connect(ctx, 'airtable')]);
    expect(mcp.createServer).toHaveBeenCalledTimes(1);
    expect(oauth.start).toHaveBeenCalledTimes(1);
  });

  test('a disconnected row cannot be finalized', async () => {
    const { service, tx } = make();
    tx.clioMcpServer.findFirst.mockResolvedValue({
      id: 'old', enabled: true, catalogId: MERIV3_HUBSPOT_CATALOG_ID,
      connectionStatus: 'disconnected', toolAllowlist: ['get_user_details'],
    });
    await expect(service.finalizeConnection(ctx.tenantId, 'old')).rejects.toThrow();
    expect(tx.clioMcpServer.updateMany).not.toHaveBeenCalled();
  });

  test('all personal queries include tenant and owner', async () => {
    const { service, tx } = make();
    await service.listApps(ctx);
    expect(tx.clioMcpServer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: ctx.tenantId, ownerUserId: ctx.userId, scope: 'user' }),
    }));
  });

  test('executeRead re-verifies current schema membership before external execution', async () => {
    const { service, mcp } = make();
    jest.spyOn(service, 'schemasForMeriV3').mockResolvedValue([
      {
        name: 'mcp__meriv3_hubspot__search_crm_objects',
        description: 'Search contacts',
        input_schema: { type: 'object', properties: {} },
        source: 'managed_mcp',
        appId: 'hubspot',
        appName: 'HubSpot',
        readOnly: true,
      },
    ]);
    await expect(
      service.executeRead(ctx, 'mcp__meriv3_hubspot__search_crm_objects', { query: 'Acme' }),
    ).resolves.toEqual({ ok: true });
    expect(mcp.executeBridged).toHaveBeenCalledWith(
      ctx,
      'mcp__meriv3_hubspot__search_crm_objects',
      { query: 'Acme' },
    );
    await expect(
      service.executeRead(ctx, 'mcp__meriv3_hubspot__create_contact', {}),
    ).rejects.toThrow('Connected-app tool is unavailable or not read-only.');
  });
});
