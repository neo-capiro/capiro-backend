import type { TenantContext } from '@capiro/shared';
import { MeriManagedMcpService } from './meri-managed-mcp.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { createMcpClient } from './meri-mcp-transport.js';
import { ConnectedAppReadService } from './connected-app-read.service.js';
import { connectedInputSchema } from './connected-app-read.contract.js';

jest.mock('./meri-mcp-transport.js', () => ({ createMcpClient: jest.fn() }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), role: 'standard_user' } as TenantContext;
const tool = 'get_table_schema',
  bridged = 'mcp__meriv3_airtable__get_table_schema';
// Synthetic schema, not a claim about a live provider's current argument names.
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { baseId: { const: 'isolated-base' }, tableId: { const: 'isolated-table' } },
  required: ['baseId', 'tableId'],
};
const args = { baseId: 'isolated-base', tableId: 'isolated-table' };
type Where = Record<string, unknown>;

function rowFixture(dirty: boolean) {
  return {
    id: id(3),
    tenantId: ctx.tenantId,
    ownerUserId: ctx.userId,
    scope: 'user',
    name: 'meriv3-airtable',
    catalogId: 'meriv3-airtable',
    endpoint: 'https://mcp.airtable.com/mcp',
    transport: 'http',
    authType: 'oauth',
    enabled: true,
    connectionStatus: 'connected',
    toolAllowlist: dirty ? [tool, 'list_bases', 'execute_api'] : [tool],
    readOnlyTools: dirty ? [tool, 'list_bases', 'execute_api'] : [tool],
    lastError: null as string | null,
    createdAt: new Date(1000),
    updatedAt: new Date(1000),
  };
}

function database(row: ReturnType<typeof rowFixture>) {
  let beforeWrite: ((data: Where) => void) | undefined;
  const matches = (where: Where): boolean =>
    Object.entries(where).every(([key, expected]) => {
      if (expected === undefined) return true;
      if (key === 'OR') return Array.isArray(expected) && expected.some(matches);
      const actual = (row as unknown as Where)[key];
      // structuredClone crosses Jest realms; instanceof Date is not reliable here.
      if (Object.prototype.toString.call(expected) === '[object Date]')
        return (
          Object.prototype.toString.call(actual) === '[object Date]' &&
          (actual as Date).getTime() === (expected as Date).getTime()
        );
      if (expected && typeof expected === 'object') {
        if ('in' in expected) return Array.isArray(expected.in) && expected.in.includes(actual);
        if ('not' in expected) return actual !== expected.not;
      }
      return actual === expected;
    });
  const tx = {
    clioMcpServer: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        matches(where) ? [structuredClone(row)] : [],
      ),
      findFirst: jest.fn(async ({ where }: { where: Where }) =>
        matches(where) ? structuredClone(row) : null,
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Where }) => {
        beforeWrite?.(data);
        if (!matches(where)) return { count: 0 };
        Object.assign(row, structuredClone(data));
        if (!Object.hasOwn(data, 'updatedAt'))
          row.updatedAt = new Date(row.updatedAt.getTime() + 1);
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (tenant: string, action: (value: typeof tx) => unknown) => {
      expect(tenant).toBe(ctx.tenantId);
      return action(tx);
    }),
  };
  return {
    row,
    tx,
    prisma,
    onWrite: (hook: (data: Where) => void) => {
      beforeWrite = hook;
    },
    advance: () => {
      row.updatedAt = new Date(row.updatedAt.getTime() + 100);
    },
  };
}

function fixture(dirty = false) {
  const db = database(rowFixture(dirty));
  const { row, prisma } = db;
  const config = { get: (key: string) => (key === 'CLIO_MCP_ENABLED' ? true : undefined) };
  // No invented token/client secret: the synthetic transport never invokes this opaque provider port.
  const oauth = { isConfigured: () => true, buildProvider: jest.fn(() => ({})) };
  const transport = {
    listTools: jest.fn(async () => [
      { name: tool, inputSchema },
      { name: 'list_bases', inputSchema: { type: 'object' } },
      { name: 'execute_api', inputSchema: { type: 'object' } },
    ]),
    callTool: jest.fn(async () => ({
      structuredContent: { tableId: 'isolated-table', fields: [] },
    })),
  };
  jest.mocked(createMcpClient).mockReturnValue(transport);
  const mcp = new MeriMcpService(prisma as never, config as never, oauth as never);
  const managed = new MeriManagedMcpService(prisma as never, mcp, oauth as never);
  const reads = new ConnectedAppReadService(
    prisma as never,
    {
      readInTransaction: async () => ({
        role: 'standard_user',
        membershipRevision: 'current-member',
      }),
    } as never,
    {
      resolveApplicationAuthorityClient: () => {
        throw Error('This case is General only');
      },
    } as never,
    managed,
    mcp,
  );
  const request = {
    clientId: null,
    connectionId: row.id,
    provider: 'airtable',
    tool,
    schemaHash: connectedInputSchema(inputSchema).schemaHash,
    arguments: args,
  };
  return {
    ...db,
    mcp,
    managed,
    reads,
    transport,
    request,
  };
}

const originalEnv = process.env;
beforeEach(() => {
  process.env = { ...originalEnv, CLIO_MCP_ENABLED: 'true', MERI_MCP_AIRTABLE_ENABLED: 'true' };
  jest.clearAllMocks();
});
afterEach(() => {
  process.env = originalEnv;
});

test.each([{ allowed: [] as string[] }, { allowed: [tool] }])(
  'hardening cannot restore a concurrently reduced tool grant $allowed',
  async ({ allowed }) => {
    const f = fixture(true);
    let changed = false;
    f.onWrite((data) => {
      if (!changed && data.toolAllowlist) {
        changed = true;
        f.row.toolAllowlist = [...allowed];
        f.row.readOnlyTools = [...allowed];
        f.advance();
      }
    });
    await expect(
      f.managed.executeRead(ctx, 'mcp__meriv3_airtable__list_bases', {}),
    ).rejects.toThrow();
    expect(f.row.toolAllowlist).toEqual(allowed);
    expect(f.row.readOnlyTools).toEqual(allowed);
    expect(f.transport.callTool).not.toHaveBeenCalled();
    if (allowed.length) {
      await expect(f.managed.executeRead(ctx, bridged, args)).resolves.toMatchObject({
        untrusted: true,
      });
      expect(f.transport.callTool).toHaveBeenCalledWith(tool, args);
    }
  },
);

test.each([false, true])(
  'finalization cannot complete a newer pending operation (dirty=%s)',
  async (dirty) => {
    const f = fixture(dirty);
    f.row.connectionStatus = 'pending';
    let changed = false;
    f.onWrite((data) => {
      if (!changed && data.connectionStatus === 'connected') {
        changed = true;
        f.advance();
        f.row.lastError = 'new-operation';
      }
    });
    await expect(f.managed.finalizeConnection(ctx.tenantId, f.row.id)).rejects.toThrow();
    expect(f.row.connectionStatus).toBe('pending');
    expect(f.row.lastError).toBe('new-operation');
    expect(f.transport.callTool).not.toHaveBeenCalled();
    expect(f.transport.listTools).not.toHaveBeenCalled();
  },
);

test('current finalization atomically hardens the same observed policy and connects', async () => {
  const f = fixture(true);
  f.row.connectionStatus = 'pending';
  await expect(f.managed.finalizeConnection(ctx.tenantId, f.row.id)).resolves.toBe(2);
  expect(f.row.toolAllowlist).toEqual([tool, 'list_bases']);
  expect(f.row.readOnlyTools).toEqual([tool, 'list_bases']);
  expect(f.row.connectionStatus).toBe('connected');
});

test('isolated Airtable read uses actual owners and exactly one bounded synthetic transport call', async () => {
  const f = fixture();
  await expect(f.reads.read(ctx, 'read_connected_app', f.request)).resolves.toMatchObject({
    provider: 'airtable',
    tool,
    status: 'ok',
    scope: 'connection_permissions',
    completeness: 'provider_page',
    untrusted: true,
    providerResult: { structuredContent: { tableId: 'isolated-table', fields: [] } },
  });
  expect(f.transport.callTool).toHaveBeenCalledTimes(1);
  expect(f.transport.callTool).toHaveBeenCalledWith(tool, args);
  for (const [connection] of jest.mocked(createMcpClient).mock.calls) {
    expect(connection.endpoint).toBe('https://mcp.airtable.com/mcp');
    expect(connection.authToken).toBeNull();
  }
});

test.each(['owner', 'pending', 'disabled'])(
  'cached schema cannot read after %s changes',
  async (change) => {
    const f = fixture();
    await f.reads.read(ctx, 'list_connected_app_reads', { clientId: null });
    if (change === 'owner') f.row.ownerUserId = id(4);
    else if (change === 'pending') f.row.connectionStatus = 'pending';
    else f.row.enabled = false;
    f.advance();
    const result = await f.reads.read(ctx, 'read_connected_app', f.request);
    expect(result).toMatchObject({ providerResult: null });
    expect(f.transport.callTool).not.toHaveBeenCalled();
  },
);
