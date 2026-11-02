import type { TenantContext } from '@capiro/shared';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { createMcpClient } from './meri-mcp-transport.js';

jest.mock('./meri-mcp-transport.js', () => ({ createMcpClient: jest.fn() }));
const ctx = { tenantId: 'tenant', userId: 'owner', role: 'standard_user' } as TenantContext;

function scene() {
  const row = {
    id: 'server', tenantId: 'tenant', ownerUserId: 'owner', scope: 'user', enabled: true,
    name: 'notion', catalogId: 'notion', endpoint: 'https://mcp.notion.com/mcp',
    transport: 'http', authType: 'oauth', connectionStatus: 'connected', lastError: null as string | null,
    updatedAt: new Date('2026-10-31T00:00:00Z'), toolAllowlist: ['search'], readOnlyTools: ['search'],
  };
  const credential: Record<string, unknown> = {};
  function change(data: Record<string, unknown>) {
    // Model Prisma @updatedAt: implicit for an ordinary update, explicit when
    // supplied by the caller. The independent original witness always advanced
    // it; this fixture also models an explicit timestamp in a conditional lock.
    const nextRevision = data.updatedAt ?? new Date(row.updatedAt.getTime() + 1);
    Object.assign(row, data, { updatedAt: nextRevision });
  }
  function matches(where: Record<string, any>) {
    for (const key of ['id', 'tenantId', 'enabled'] as const) {
      if (where[key] !== undefined && where[key] !== row[key]) return false;
    }
    if (where.updatedAt && where.updatedAt.getTime() !== row.updatedAt.getTime()) return false;
    const status = where.connectionStatus;
    if (typeof status === 'string' && status !== row.connectionStatus) return false;
    if (status?.not === row.connectionStatus) return false;
    return true;
  }
  const tx = {
    clioMcpServer: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => matches(where) ? structuredClone(row) : null),
      findMany: jest.fn(async () => [structuredClone(row)]),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where)) return { count: 0 };
        change(data);
        return { count: 1 };
      }),
    },
    clioMcpOAuthCredential: {
      upsert: jest.fn(async ({ update }: { update: Record<string, unknown> }) => {
        Object.assign(credential, update);
        return credential;
      }),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(credential, data);
        return { count: 1 };
      }),
    },
  };
  const prisma = { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) };
  const values: Record<string, unknown> = {
    CLIO_MCP_ENABLED: true, CLIO_MCP_OAUTH_REDIRECT_URI: 'https://app.example/callback',
    OAUTH_STATE_SECRET: 'synthetic-state', OAUTH_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('hex'),
    OAUTH_TOKEN_ENCRYPTION_KEY_VERSION: 'v1',
  };
  const config = { get: (key: string) => values[key] };
  const oauth = new MeriMcpOAuthService(prisma as never, config as never);
  const mcp = new MeriMcpService(prisma as never, config as never, oauth);
  const client = { listTools: jest.fn(async () => [{ name: 'search', inputSchema: { type: 'object' } }]), callTool: jest.fn() };
  jest.mocked(createMcpClient).mockReturnValue(client);
  const provider = () => oauth.buildProvider({ id: row.id, tenantId: row.tenantId, name: row.name, catalogId: row.catalogId });
  // Use the actual provider passed to the transport by MeriMcpService.
  const refresh = async () => {
    const connection = jest.mocked(createMcpClient).mock.calls.at(-1)![0];
    await connection.authProvider!.saveTokens!({ access_token: 'synthetic-refreshed', token_type: 'Bearer' });
  };
  const run = (path: string) => path === 'registry' ? mcp.bridgedSchemasFor(ctx) : mcp.discoverTools('tenant', 'server');
  return { row, credential, tx, change, mcp, client, provider, refresh, run };
}

beforeEach(() => jest.clearAllMocks());

test.each(['registry', 'explicit'])('refreshed %s discovery success remains connected', async (path) => {
  const f = scene();
  f.client.listTools.mockImplementation(async () => {
    await f.refresh();
    expect(f.row.connectionStatus).toBe('connected');
    return [{ name: 'search', inputSchema: { type: 'object' } }];
  });
  const result = await f.run(path);
  if (path === 'registry') expect(result).toHaveLength(1);
  else expect(result).toBe(1);
  expect(f.row.connectionStatus).toBe('connected');
  expect(f.credential.accessTokenCiphertext).toBeTruthy();
});

test.each(['registry', 'explicit'])('refresh followed by failed %s discovery records unavailability', async (path) => {
  const f = scene();
  f.client.listTools.mockImplementation(async () => {
    await f.refresh();
    throw new Error('synthetic-private-list-failure');
  });
  const result = await f.run(path);
  expect(result).toEqual(path === 'registry' ? [] : 0);
  expect(f.row.connectionStatus).toBe('error');
  expect(f.row.lastError).toBe('Tool discovery failed.');
  expect(JSON.stringify(f.row)).not.toContain('synthetic-private');
});

test.each(['registry', 'explicit'])('refreshed %s failure preserves each newer lifecycle change', async (path) => {
  for (const newer of ['pending', 'disconnected', 'connected', 'disabled']) {
    const f = scene();
    let revision!: number;
    f.client.listTools.mockImplementation(async () => {
      await f.refresh();
      f.change({ connectionStatus: newer === 'disabled' ? 'connected' : newer,
        enabled: newer !== 'disabled', lastError: 'Newer operation result.' });
      revision = f.row.updatedAt.getTime();
      throw Object.assign(new Error('old auth failure'), { name: 'UnauthorizedError' });
    });
    expect(await f.run(path)).toEqual(path === 'registry' ? [] : 0);
    expect(f.row.connectionStatus).toBe(newer === 'disabled' ? 'connected' : newer);
    expect(f.row.lastError).toBe('Newer operation result.');
    expect(f.row.updatedAt.getTime()).toBe(revision);
  }
});

test.each(['registry', 'explicit'])('client metadata binding during refresh does not hide a subsequent %s failure', async (path) => {
  const f = scene();
  f.client.listTools.mockImplementation(async () => {
    const connection = jest.mocked(createMcpClient).mock.calls.at(-1)![0];
    await connection.authProvider!.saveClientInformation!({ client_id: 'synthetic-client', issuer: 'https://auth.example' });
    await f.refresh();
    throw new Error('synthetic-private-list-failure');
  });
  expect(await f.run(path)).toEqual(path === 'registry' ? [] : 0);
  expect(f.row.connectionStatus).toBe('error');
  expect(f.row.lastError).toBe('Tool discovery failed.');
});

test('credential storage preserves lifecycle revision and prior discovery error', async () => {
  const f = scene();
  f.change({ connectionStatus: 'pending', lastError: 'Earlier discovery failed.' });
  const revision = f.row.updatedAt.getTime();
  await f.provider().saveTokens({ access_token: 'synthetic-refresh', token_type: 'Bearer' });
  expect(f.row.updatedAt.getTime()).toBe(revision);
  expect(f.row.lastError).toBe('Earlier discovery failed.');
  expect(f.row.connectionStatus).toBe('pending');
  expect(f.credential.accessTokenCiphertext).toBeTruthy();
});

test('a lifecycle change between the token-save read and row lock refuses credential writes', async () => {
  const f = scene();
  const update = f.tx.clioMcpServer.updateMany.getMockImplementation()!;
  f.tx.clioMcpServer.updateMany.mockImplementation(async (args) => {
    f.change({ connectionStatus: 'pending', lastError: 'New authorization.' });
    return update(args);
  });
  await expect(f.provider().saveTokens({ access_token: 'stale', token_type: 'Bearer' })).rejects.toThrow('no longer active');
  expect(f.tx.clioMcpOAuthCredential.updateMany).not.toHaveBeenCalled();
  expect(f.row.lastError).toBe('New authorization.');
});

test.each(['disconnected', 'disabled'])('%s before token storage refuses credentials without a server write', async (state) => {
  const f = scene();
  f.change(state === 'disabled' ? { enabled: false } : { connectionStatus: 'disconnected' });
  await expect(f.provider().saveTokens({ access_token: 'stale', token_type: 'Bearer' })).rejects.toThrow('no longer active');
  expect(f.tx.clioMcpOAuthCredential.updateMany).not.toHaveBeenCalled();
  expect(f.tx.clioMcpServer.updateMany).not.toHaveBeenCalled();
});
