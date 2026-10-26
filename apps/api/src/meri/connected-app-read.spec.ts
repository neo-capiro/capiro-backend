import { ConnectedAppReadService } from './connected-app-read.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriManagedMcpService } from './meri-managed-mcp.service.js';
import {
  approvedConnectedRead,
  connectedInputSchema,
  parseConnectedAppRead,
} from './connected-app-read.contract.js';
import type { TenantContext } from '@capiro/shared';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_fixture',
  role: 'standard_user',
} as TenantContext;
const connectionId = '33333333-3333-4333-8333-333333333333';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string' },
    cursor: { type: 'string' },
    limit: { type: 'integer', maximum: 50 },
  },
  required: ['query'],
};
const schema = connectedInputSchema(inputSchema);
const selection = {
  connectionId,
  provider: 'slack',
  tool: 'search_messages',
  bridgedName: 'mcp__Slack__search_messages',
  ...schema,
};
const request = {
  clientId: null,
  connectionId,
  provider: selection.provider,
  tool: selection.tool,
  schemaHash: schema.schemaHash,
  arguments: { query: 'quarterly', limit: 2 },
};

function fixture() {
  let member = 'member-v1',
    revision = 'connection-v1';
  const membership = {
    readInTransaction: jest.fn(async () => ({ role: 'standard_user', membershipRevision: member })),
  };
  const security = { resolveApplicationAuthorityClient: jest.fn(async () => ['visible']) };
  const providerResult = {
    content: [{ type: 'text', text: 'Quarterly plan' }],
    structuredContent: {
      messages: [{ id: 'message-one', text: 'Quarterly plan' }],
      next_cursor: 'provider:page-2',
      has_more: true,
    },
  };
  const mcp = {
    connectedReadSelections: jest.fn(async () => [selection]),
    connectedReadUnavailableState: jest.fn(async () => 'unavailable'),
    assertConnectedReadCurrent: jest.fn(async () => ({ provider: 'slack', revision })),
    executeBridged: jest.fn(async () => ({
      content: 'untrusted Quarterly plan',
      structuredResult: providerResult,
    })),
  };
  const managed = {
    managedCatalogForMeriV3: jest.fn(async () => ({ availability: { state: 'ok' } })),
    executeRead: jest.fn(),
  };
  const prisma = {
    withTenant: jest.fn(async (tenant: string, read: (tx: object) => unknown) => {
      expect(tenant).toBe(ctx.tenantId);
      return read({});
    }),
  };
  const service = new ConnectedAppReadService(
    prisma as never,
    membership as never,
    security as never,
    managed as never,
    mcp as never,
  );
  return {
    service,
    mcp,
    managed,
    security,
    membership,
    providerResult,
    revoke: () => {
      member = 'revoked';
    },
    replace: () => {
      revision = 'connection-v2';
    },
  };
}

describe('fixed connected-app receiving and existing execution owner', () => {
  test('catalog exposes exact public input schema and no bridged transport name', async () => {
    const f = fixture(),
      result = await f.service.read(ctx, 'list_connected_app_reads', { clientId: null });
    expect(result).toMatchObject({
      status: 'ok',
      complete: false,
      capabilities: [{ connectionId, inputSchema }],
    });
    expect(JSON.stringify(result)).not.toContain('mcp__');
    expect(f.mcp.executeBridged).not.toHaveBeenCalled();
  });
  test('content and actual provider continuation survive; next page uses exact schema arguments', async () => {
    const f = fixture(),
      result = await f.service.read(ctx, 'read_connected_app', request);
    expect(result).toMatchObject({
      status: 'ok',
      providerResult: f.providerResult,
      completeness: 'provider_page',
      untrusted: true,
    });
    await f.service.read(ctx, 'read_connected_app', {
      ...request,
      arguments: { query: 'quarterly', cursor: 'provider:page-2' },
    });
    expect(f.mcp.executeBridged).toHaveBeenLastCalledWith(
      ctx,
      selection.bridgedName,
      { query: 'quarterly', cursor: 'provider:page-2' },
      { structuredRead: true, connectedRead: { connectionId, revision: 'connection-v1' } },
    );
  });
  test.each(['hubspot', 'airtable', 'google-drive'])(
    '%s dispatches through the existing managed executeRead owner',
    async (provider) => {
      const f = fixture();
      f.mcp.connectedReadSelections.mockResolvedValue([{ ...selection, provider }]);
      // Exercise the existing managed method, not a replacement transport.
      const owner = new MeriManagedMcpService(
        {} as never,
        { isBridgedToolReadOnly: () => true, executeBridged: f.mcp.executeBridged } as never,
        {} as never,
      );
      jest.spyOn(owner, 'schemasForMeriV3').mockResolvedValue([
        {
          name: selection.bridgedName,
          input_schema: inputSchema,
          description: 'fixture',
          source: 'managed_mcp',
          appId: provider as never,
          appName: provider,
          readOnly: true,
        },
      ]);
      f.managed.executeRead.mockImplementation(owner.executeRead.bind(owner));
      await f.service.read(ctx, 'read_connected_app', { ...request, provider });
      expect(f.managed.executeRead).toHaveBeenCalledTimes(1);
      expect(f.mcp.executeBridged).toHaveBeenCalledTimes(1);
    },
  );
  test.each(['schemaHash', 'connectionId', 'provider', 'tool'])(
    'stale %s returns unavailable without a provider call',
    async (field) => {
      const f = fixture();
      const wrong =
        field === 'schemaHash' ? 'a'.repeat(64) : field === 'connectionId' ? ctx.userId : 'other';
      expect(
        await f.service.read(ctx, 'read_connected_app', { ...request, [field]: wrong }),
      ).toMatchObject({ status: 'unavailable' });
      expect(f.mcp.executeBridged).not.toHaveBeenCalled();
    },
  );
  test.each([
    { query: 'x', limit: 51 },
    { query: 'x', write: true },
    { query: 'https://arbitrary.invalid' },
    { query: 'x', headers: {} },
  ])('invalid or endpoint-bearing arguments never reach provider', async (args) => {
    const f = fixture();
    await expect(
      f.service.read(ctx, 'read_connected_app', { ...request, arguments: args }),
    ).rejects.toThrow();
    expect(f.mcp.executeBridged).not.toHaveBeenCalled();
  });
  test.each(['membership', 'connection', 'client'])(
    'withholds late provider content after %s denial/change',
    async (kind) => {
      const f = fixture();
      f.mcp.executeBridged.mockImplementation(async () => {
        if (kind === 'membership') f.revoke();
        if (kind === 'connection') f.replace();
        if (kind === 'client')
          f.security.resolveApplicationAuthorityClient.mockRejectedValue(new Error('wall denied'));
        return { content: 'must not escape', structuredResult: f.providerResult };
      });
      await expect(
        f.service.read(ctx, 'read_connected_app', {
          ...request,
          clientId: kind === 'client' ? ctx.userId : null,
        }),
      ).rejects.toThrow();
    },
  );
  test('oversized provider page is explicitly partial, never an empty complete page', async () => {
    const f = fixture();
    f.mcp.executeBridged.mockResolvedValue({
      content: 'truncated untrusted',
      structuredResult: { text: 'x'.repeat(140000) },
    } as never);
    expect(await f.service.read(ctx, 'read_connected_app', request)).toMatchObject({
      status: 'partial',
      providerResult: null,
      reason: 'provider_result_exceeds_safe_json_boundary',
    });
  });
  test.each(['disconnected', 'permission_required'])(
    'current %s state is explicit and never calls the provider',
    async (status) => {
      const f = fixture();
      f.mcp.connectedReadSelections.mockResolvedValue([]);
      f.mcp.connectedReadUnavailableState.mockResolvedValue(status);
      expect(await f.service.read(ctx, 'read_connected_app', request)).toMatchObject({
        status,
        providerResult: null,
        content: null,
      });
      expect(f.mcp.executeBridged).not.toHaveBeenCalled();
    },
  );
  test('catalog approval refuses Slack writes/custom endpoints and retains Tango and approved document reads', () => {
    expect(approvedConnectedRead('slack', 'post_message')).toBeNull();
    expect(approvedConnectedRead('custom', 'read')).toBeNull();
    expect(approvedConnectedRead('sharepoint', 'get_file')).toBeNull();
    expect(approvedConnectedRead('makegov-tango', 'search_opportunities')).toBe('makegov-tango');
    expect(approvedConnectedRead('box', 'read_file')).toBe('box');
    expect(() =>
      connectedInputSchema({
        type: 'object',
        properties: { x: { $ref: 'https://schema.invalid' } },
      }),
    ).toThrow();
    expect(() => parseConnectedAppRead('delete_connected_app', request)).toThrow();
  });
});

describe('actual MCP current connection predicate', () => {
  test('null provider result remains unavailable rather than a successful empty page', async () => {
    const f = fixture();
    f.mcp.executeBridged.mockResolvedValue({
      content: 'untrusted null',
      structuredResult: null,
    } as never);
    expect(await f.service.read(ctx, 'read_connected_app', request)).toMatchObject({
      status: 'unavailable',
      providerResult: null,
      reason: 'provider_result_unavailable',
    });
  });
  function owner() {
    const row = {
      id: connectionId,
      tenantId: ctx.tenantId,
      scope: 'user',
      ownerUserId: ctx.userId,
      name: 'Slack',
      catalogId: 'slack',
      endpoint: 'https://mcp.slack.com/mcp',
      transport: 'http',
      authType: 'oauth',
      enabled: true,
      connectionStatus: 'connected',
      toolAllowlist: ['search_messages'],
      readOnlyTools: ['search_messages'],
      updatedAt: new Date('2026-10-26T00:00:00Z'),
    };
    const prisma = {
      withTenant: async (tenant: string, read: (tx: unknown) => unknown) =>
        read({
          clioMcpServer: {
            findMany: async ({ where }: any) =>
              tenant === row.tenantId &&
              where.tenantId === row.tenantId &&
              row.enabled &&
              (row.scope === 'tenant' ||
                where.OR.some((x: any) => x.ownerUserId === row.ownerUserId))
                ? [row]
                : [],
          },
        }),
    };
    const service = new MeriMcpService(
      prisma as never,
      { get: () => true } as never,
      { isConfigured: () => true } as never,
    );
    (service as any).registry.set(`${ctx.tenantId}:${ctx.userId}`, {
      fetchedAt: Date.now(),
      failures: [],
      schemas: [],
      byBridgedName: new Map([
        [
          selection.bridgedName,
          {
            serverId: connectionId,
            serverName: 'Slack',
            toolName: 'search_messages',
            bridgedName: selection.bridgedName,
            readOnly: true,
          },
        ],
      ]),
    });
    return { service, row };
  }
  test('retains exact tenant/actor row visibility', async () => {
    const f = owner();
    expect(
      await f.service.assertConnectedReadCurrent(ctx, connectionId, selection.bridgedName),
    ).toMatchObject({ provider: 'slack' });
    f.row.ownerUserId = 'other';
    await expect(
      f.service.assertConnectedReadCurrent(ctx, connectionId, selection.bridgedName),
    ).rejects.toThrow();
  });
  test.each(['disabled', 'reauth', 'allowlist', 'readOnly', 'endpoint', 'catalog'])(
    'refuses current %s change despite cached registered read',
    async (kind) => {
      const f = owner();
      if (kind === 'disabled') f.row.enabled = false;
      if (kind === 'reauth') f.row.connectionStatus = 'needs_reauth';
      if (kind === 'allowlist') f.row.toolAllowlist = [];
      if (kind === 'readOnly') f.row.readOnlyTools = [];
      if (kind === 'endpoint') f.row.endpoint = 'https://other.invalid';
      if (kind === 'catalog') f.row.catalogId = 'custom';
      await expect(
        f.service.assertConnectedReadCurrent(ctx, connectionId, selection.bridgedName),
      ).rejects.toThrow();
    },
  );
  test('connection replacement after admission is refused inside actual execution before transport', async () => {
    const f = owner(),
      revision = f.row.updatedAt.toISOString();
    f.row.updatedAt = new Date('2026-10-26T01:00:00Z');
    const client = jest
      .spyOn(f.service as any, 'clientFor')
      .mockReturnValue({ callTool: jest.fn() });
    await expect(
      f.service.executeBridged(
        ctx,
        selection.bridgedName,
        { query: 'x' },
        { structuredRead: true, connectedRead: { connectionId, revision } },
      ),
    ).rejects.toThrow('changed');
    expect(client).not.toHaveBeenCalled();
  });
});
