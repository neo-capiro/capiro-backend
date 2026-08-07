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

  test('lists exactly HubSpot and Airtable even when nothing is connected', async () => {
    const { service } = make();
    const apps = await service.listApps(ctx);
    expect(apps.map((app) => app.id)).toEqual(['hubspot', 'airtable']);
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
      'HubSpot sign-in is not configured for Capiro yet.',
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
      toolAllowlist: ['get_user_details', 'search_contacts', 'create_contact', 'update_deal'],
      readOnlyTools: [],
      connectionStatus: 'connected',
    });
    await expect(service.finalizeConnection(ctx.tenantId, 'hubspot-server')).resolves.toBe(2);
    expect(tx.clioMcpServer.update).toHaveBeenCalledWith({
      where: { id: 'hubspot-server' },
      data: {
        toolAllowlist: ['get_user_details', 'search_contacts'],
        readOnlyTools: ['get_user_details', 'search_contacts'],
        lastError: null,
      },
    });
    expect(mcp.invalidate).toHaveBeenCalledWith(ctx.tenantId);
  });

  test('executeRead re-verifies current schema membership before external execution', async () => {
    const { service, mcp } = make();
    jest.spyOn(service, 'schemasForMeriV3').mockResolvedValue([
      {
        name: 'mcp__meriv3_hubspot__search_contacts',
        description: 'Search contacts',
        input_schema: { type: 'object', properties: {} },
        source: 'managed_mcp',
        appId: 'hubspot',
        appName: 'HubSpot',
        readOnly: true,
      },
    ]);
    await expect(
      service.executeRead(ctx, 'mcp__meriv3_hubspot__search_contacts', { query: 'Acme' }),
    ).resolves.toEqual({ ok: true });
    expect(mcp.executeBridged).toHaveBeenCalledWith(
      ctx,
      'mcp__meriv3_hubspot__search_contacts',
      { query: 'Acme' },
    );
    await expect(
      service.executeRead(ctx, 'mcp__meriv3_hubspot__create_contact', {}),
    ).rejects.toThrow('Connected-app tool is unavailable or not read-only.');
  });
});
