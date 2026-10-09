/**
 * Lane A1 — API personal managed owner request proof (provider-free).
 *
 * This spec qualifies the PERSONAL (scope='user') managed-app owner path end to
 * end through the real services, with ONLY the provider transport
 * (`createMcpClient` → listTools/callTool) and the OAuth-configured provider
 * mocked:
 *
 *   MeriManagedMcpService.executeRead
 *     → MeriManagedMcpService.schemasForMeriV3
 *         → personalRows           (real tenant/scope/owner/catalog predicate)
 *         → hardenServer           (real allowlist hardening + scoped update)
 *     → MeriMcpService.bridgedSchemasFor
 *         → registryFor            (real visibleServers actor-OR predicate)
 *         → clientFor              (real endpoint/name/scope/transport check)
 *     → MeriMcpService.executeBridged
 *         → registryFor (cached)   (fresh visibleServers recheck before I/O)
 *         → clientFor → callTool   (the one provider call)
 *
 * The database fake is NOT a permission oracle: it evaluates the real Prisma
 * `where` shapes the services actually emit (tenantId, scope, ownerUserId,
 * actor OR, id, catalogId `in`, enabled, connectionStatus in/not) and applies
 * `updateMany`/`update` data to matching rows only. A wrong tenant or actor is
 * excluded because the query predicate excludes it, not because a fixture
 * returned a magic "authorized" row.
 *
 * Scope: personal actor/tenant/API owner only. This fixture does NOT qualify
 * request identity (see meri-v3-internal-service.guard.spec.ts, run separately)
 * nor raw Capiro client/comparison/portfolio routing (owned elsewhere on A1).
 */
import type { TenantContext } from '@capiro/shared';
import { MeriManagedMcpService } from './meri-managed-mcp.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { createMcpClient } from './meri-mcp-transport.js';
import {
  MERIV3_AIRTABLE_CATALOG_ID,
  MERIV3_AIRTABLE_ENDPOINT,
  MERIV3_GOOGLE_DRIVE_CATALOG_ID,
  MERIV3_GOOGLE_DRIVE_ENDPOINT,
} from './meri-managed-mcp.helpers.js';
import {
  wrapMcpResultForPrompt,
  type McpClient,
  type McpToolDescriptor,
} from './meri-mcp.helpers.js';

jest.mock('./meri-mcp-transport.js', () => ({ createMcpClient: jest.fn() }));

const OWNER = {
  tenantId: 'tenant-owner',
  tenantSlug: 'capiro-internal',
  userId: 'user-owner',
  clerkUserId: 'clerk-owner',
  role: 'standard_user',
} as unknown as TenantContext;

const TOOL = 'mcp__meriv3_airtable__list_bases';
const WRITE_TOOL = 'mcp__meriv3_airtable__execute_api';
const INPUT = { baseId: 'appEXAMPLE' };

const AIRTABLE_TOOLS: McpToolDescriptor[] = [
  { name: 'list_bases', description: 'List bases', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'execute_api',
    description: 'Run an arbitrary API call',
    inputSchema: { type: 'object', properties: {} },
  },
];

const DRIVE_TOOL = 'mcp__meriv3_google_drive__search_files';
const DRIVE_TOOLS: McpToolDescriptor[] = [
  {
    name: 'search_files',
    description: 'Search Drive',
    inputSchema: { type: 'object', properties: {} },
  },
  { name: 'create_file', description: 'Create a file', inputSchema: { type: 'object', properties: {} } },
];

/** A realistic provider callTool result: opaque owner wire, never `isError`. */
const providerResult: unknown = {
  content: [{ type: 'text', text: '{"bases":[{"id":"appEXAMPLE","name":"Example"}]}' }],
  structuredContent: { bases: [{ id: 'appEXAMPLE', name: 'Example' }] },
};

interface Row {
  id: string;
  tenantId: string;
  ownerUserId: string | null;
  scope: 'user' | 'tenant';
  enabled: boolean;
  name: string;
  catalogId: string | null;
  endpoint: string | null;
  command: string | null;
  args: unknown;
  envJson: unknown;
  transport: string;
  authType: string;
  connectionStatus: string;
  toolAllowlist: unknown;
  readOnlyTools: unknown;
  authTokenCiphertext: string | null;
  authTokenIv: string | null;
  authTokenAuthTag: string | null;
  authKeyVersion: number | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

function airtableRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'srv-airtable',
    tenantId: OWNER.tenantId,
    ownerUserId: OWNER.userId,
    scope: 'user',
    enabled: true,
    name: MERIV3_AIRTABLE_CATALOG_ID,
    catalogId: MERIV3_AIRTABLE_CATALOG_ID,
    endpoint: MERIV3_AIRTABLE_ENDPOINT,
    command: null,
    args: [],
    envJson: {},
    transport: 'http',
    authType: 'oauth',
    connectionStatus: 'connected',
    toolAllowlist: ['list_bases'],
    readOnlyTools: ['list_bases'],
    authTokenCiphertext: null,
    authTokenIv: null,
    authTokenAuthTag: null,
    authKeyVersion: null,
    lastSyncAt: null,
    lastError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function driveRow(overrides: Partial<Row> = {}): Row {
  return airtableRow({
    id: 'srv-drive',
    name: MERIV3_GOOGLE_DRIVE_CATALOG_ID,
    catalogId: MERIV3_GOOGLE_DRIVE_CATALOG_ID,
    endpoint: MERIV3_GOOGLE_DRIVE_ENDPOINT,
    toolAllowlist: ['search_files'],
    readOnlyTools: ['search_files'],
    ...overrides,
  });
}

type Where = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function matchCondition(value: unknown, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (typeof cond === 'object' && cond !== null) {
    const c = cond as Record<string, unknown>;
    if ('in' in c) {
      const list = c.in;
      return Array.isArray(list) && list.includes(value);
    }
    if ('not' in c) return value !== c.not;
    if ('equals' in c) return value === c.equals;
    return false;
  }
  return value === cond;
}

/** Evaluate the real Prisma where shapes the services emit. */
function whereMatches(row: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      const branches = Array.isArray(cond) ? cond : [];
      if (!branches.some((branch) => whereMatches(row, asRecord(branch)))) return false;
      continue;
    }
    if (!matchCondition((row as unknown as Record<string, unknown>)[key], cond)) return false;
  }
  return true;
}

function createDb(rows: Row[]) {
  const clioMcpServer = {
    findMany: jest.fn(
      async (args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'> }) => {
        const matched = rows.filter((row) => whereMatches(row, args?.where ?? {}));
        const orderBy = args?.orderBy;
        const entries = orderBy ? Object.entries(orderBy) : [];
        if (!entries.length) return matched;
        const [field, dir] = entries[0]!;
        return [...matched].sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[field];
          const bv = (b as unknown as Record<string, unknown>)[field];
          const an = av instanceof Date ? av.getTime() : Number(av);
          const bn = bv instanceof Date ? bv.getTime() : Number(bv);
          const cmp = an === bn ? 0 : an < bn ? -1 : 1;
          return dir === 'desc' ? -cmp : cmp;
        });
      },
    ),
    findFirst: jest.fn(async (args: { where?: Where }) => {
      return rows.find((row) => whereMatches(row, args?.where ?? {})) ?? null;
    }),
    updateMany: jest.fn(async (args: { where?: Where; data?: Record<string, unknown> }) => {
      const matched = rows.filter((row) => whereMatches(row, args?.where ?? {}));
      for (const row of matched) Object.assign(row, args?.data ?? {});
      return { count: matched.length };
    }),
    update: jest.fn(async (args: { where: Where; data: Record<string, unknown> }) => {
      const row = rows.find((candidate) => whereMatches(candidate, args.where));
      if (!row) throw new Error('Record to update not found.');
      Object.assign(row, args.data);
      return row;
    }),
  };
  const tenant = { findUnique: jest.fn(async () => null) };
  const auditLog = { create: jest.fn(async () => ({})) };
  const tx = { clioMcpServer, tenant, auditLog };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { prisma, tx };
}

function harness(rows: Row[], client: McpClient) {
  const db = createDb(rows);
  const config = {
    get: jest.fn((key: string) => (key === 'CLIO_MCP_ENABLED' ? true : undefined)),
  };
  const oauth = {
    isConfigured: jest.fn(() => true),
    buildProvider: jest.fn(() => ({})),
  };
  jest.mocked(createMcpClient).mockReturnValue(client);
  const mcp = new MeriMcpService(db.prisma as never, config as never, oauth as never);
  const managed = new MeriManagedMcpService(db.prisma as never, mcp, oauth as never);
  return { db, mcp, managed, oauth, config };
}

describe('MeriManagedMcpService personal owner request chain', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, CLIO_MCP_ENABLED: 'true', MERI_MCP_AIRTABLE_ENABLED: 'true' };
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test('the real owner chain forwards exactly one provider call and the exact owner wire', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow({
      toolAllowlist: ['list_bases', 'execute_api'],
      readOnlyTools: ['list_bases', 'execute_api'],
    });
    const other = airtableRow({
      id: 'srv-other',
      ownerUserId: 'user-other',
      toolAllowlist: ['list_bases', 'execute_api'],
      readOnlyTools: ['list_bases', 'execute_api'],
    });
    const { db, managed } = harness([row, other], { listTools, callTool });

    const result = await managed.executeRead(OWNER, TOOL, INPUT);

    // Exactly one provider invocation, with the current input forwarded verbatim.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('list_bases', INPUT);
    expect(listTools).toHaveBeenCalledTimes(1);
    // Exact {tool,server,untrusted,content} owner wire.
    expect(result).toEqual({
      tool: TOOL,
      server: MERIV3_AIRTABLE_CATALOG_ID,
      untrusted: true,
      content: wrapMcpResultForPrompt(MERIV3_AIRTABLE_CATALOG_ID, providerResult),
    });

    // Real scoped query predicate (tenant + personal scope + owner).
    expect(db.tx.clioMcpServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: OWNER.tenantId,
          scope: 'user',
          ownerUserId: OWNER.userId,
        }),
      }),
    );
    // Legitimate hardening ran and was scoped to the current row only.
    expect(db.tx.clioMcpServer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: row.id,
          tenantId: OWNER.tenantId,
          enabled: true,
          connectionStatus: { in: ['pending', 'connected'] },
        }),
        data: { toolAllowlist: ['list_bases'], readOnlyTools: ['list_bases'] },
      }),
    );
    expect(row.toolAllowlist).toEqual(['list_bases']);
    expect(row.readOnlyTools).toEqual(['list_bases']);
    // The non-matching row was never touched by the scoped update.
    expect(other.toolAllowlist).toEqual(['list_bases', 'execute_api']);
    expect(other.readOnlyTools).toEqual(['list_bases', 'execute_api']);
  });

  test('a wrong personal actor is filtered by the owner predicate and reaches no provider', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const { db, managed } = harness([airtableRow()], { listTools, callTool });
    const intruder = { ...OWNER, userId: 'user-intruder' } as TenantContext;

    await expect(managed.executeRead(intruder, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(db.tx.clioMcpServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: OWNER.tenantId,
          scope: 'user',
          ownerUserId: 'user-intruder',
        }),
      }),
    );
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('a wrong tenant is filtered by the tenant predicate and reaches no provider', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const { db, managed } = harness([airtableRow()], { listTools, callTool });
    const foreign = { ...OWNER, tenantId: 'tenant-other' } as TenantContext;

    await expect(managed.executeRead(foreign, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(db.tx.clioMcpServer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-other',
          scope: 'user',
          ownerUserId: OWNER.userId,
        }),
      }),
    );
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('the actor OR predicate hides another user personal row from the registry', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const { mcp } = harness([airtableRow()], { listTools, callTool });
    const intruder = { ...OWNER, userId: 'user-intruder' } as TenantContext;

    await expect(mcp.bridgedSchemasFor(intruder)).resolves.toEqual([]);
    await expect(mcp.executeBridged(intruder, TOOL, INPUT)).rejects.toThrow(
      'MCP tool not registered',
    );
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('a disabled current row yields zero provider calls', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const { db, managed } = harness([airtableRow({ enabled: false })], { listTools, callTool });

    await expect(managed.executeRead(OWNER, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(db.tx.clioMcpServer.updateMany).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('a disconnected current row yields zero provider calls', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const { db, managed } = harness([airtableRow({ connectionStatus: 'disconnected' })], {
      listTools,
      callTool,
    });

    await expect(managed.executeRead(OWNER, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(db.tx.clioMcpServer.updateMany).not.toHaveBeenCalled();
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('an ownership change at the transport-list boundary is caught before execution', async () => {
    const row = airtableRow();
    const listTools = jest.fn(async () => {
      // Genuine transport-list boundary: the current row changes owner here,
      // after personalRows admission, while the real services keep executing.
      row.ownerUserId = 'user-other';
      return AIRTABLE_TOOLS;
    });
    const callTool = jest.fn(async () => providerResult);
    const { managed } = harness([row], { listTools, callTool });

    await expect(managed.executeRead(OWNER, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  test('a cached discovery cannot bypass the fresh owner check in executeBridged', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow();
    const { mcp } = harness([row], { listTools, callTool });

    await expect(mcp.bridgedSchemasFor(OWNER)).resolves.toHaveLength(1);
    expect(listTools).toHaveBeenCalledTimes(1);

    // Ownership changes between catalog admission and execution.
    row.ownerUserId = 'user-other';

    await expect(mcp.executeBridged(OWNER, TOOL, INPUT)).rejects.toThrow(
      'MCP server not found or disabled',
    );
    // Registry cache is reused (no rediscovery), yet execution is denied.
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  test('revoking the owner after cached discovery yields zero calls through executeRead', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow();
    const { mcp, managed } = harness([row], { listTools, callTool });

    await expect(mcp.bridgedSchemasFor(OWNER)).resolves.toHaveLength(1);
    row.ownerUserId = 'user-other';

    await expect(managed.executeRead(OWNER, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  test('an endpoint change is rejected before any transport call', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const { managed } = harness([airtableRow({ endpoint: 'https://attacker.example/mcp' })], {
      listTools,
      callTool,
    });

    await expect(managed.executeRead(OWNER, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('a name change is rejected before any transport call', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const { managed } = harness([airtableRow({ name: 'renamed-connector' })], {
      listTools,
      callTool,
    });

    await expect(managed.executeRead(OWNER, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('a catalog change off the managed set yields zero provider calls', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const { managed } = harness([airtableRow({ catalogId: 'not-a-managed-app' })], {
      listTools,
      callTool,
    });

    await expect(managed.executeRead(OWNER, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('an allowlist with no read tools is hardened to error and yields zero provider calls', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow({
      toolAllowlist: ['execute_api'],
      readOnlyTools: ['execute_api'],
    });
    const { db, managed } = harness([row], { listTools, callTool });

    await expect(managed.executeRead(OWNER, TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(db.tx.clioMcpServer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          toolAllowlist: [],
          readOnlyTools: [],
          connectionStatus: 'error',
        }),
      }),
    );
    expect(listTools).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test('an unknown/write tool in persisted metadata never becomes executable', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow({
      toolAllowlist: ['list_bases', 'execute_api'],
      readOnlyTools: ['list_bases', 'execute_api'],
    });
    const { managed } = harness([row], { listTools, callTool });

    // The write tool is present in persisted metadata but is not a managed read.
    await expect(managed.executeRead(OWNER, WRITE_TOOL, INPUT)).rejects.toThrow(
      'Connected-app tool is unavailable or not read-only.',
    );
    expect(callTool).not.toHaveBeenCalled();

    // The genuine read tool still works and hardens the row in place.
    await expect(managed.executeRead(OWNER, TOOL, INPUT)).resolves.toMatchObject({
      tool: TOOL,
      server: MERIV3_AIRTABLE_CATALOG_ID,
      untrusted: true,
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('list_bases', INPUT);
    expect(row.toolAllowlist).toEqual(['list_bases']);
  });
});

describe('Google Drive preview actor/tenant revocation on the personal owner chain', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CLIO_MCP_ENABLED: 'true',
      MERI_MCP_GOOGLE_DRIVE_ENABLED: 'true',
      MERI_MCP_GOOGLE_DRIVE_CLIENT_ID: 'preview-client',
      MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET: 'preview-secret',
      MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS: OWNER.userId,
      MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS: OWNER.tenantId,
    };
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  test.each(['actor', 'tenant'] as const)(
    'revoking the preview %s yields zero provider calls through executeRead',
    async (kind) => {
      const listTools = jest.fn(async () => DRIVE_TOOLS);
      const callTool = jest.fn(async () => providerResult);
      const row = driveRow();
      const { mcp, managed } = harness([row], { listTools, callTool });

      // The approved internal owner can reach the real chain first.
      await expect(mcp.bridgedSchemasFor(OWNER)).resolves.toHaveLength(1);
      expect(listTools).toHaveBeenCalledTimes(1);

      if (kind === 'actor') delete process.env.MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS;
      else delete process.env.MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS;

      await expect(managed.executeRead(OWNER, DRIVE_TOOL, INPUT)).rejects.toThrow(
        'Connected-app tool is unavailable or not read-only.',
      );
      // Cached discovery is not re-run and never grants execution.
      expect(listTools).toHaveBeenCalledTimes(1);
      expect(callTool).not.toHaveBeenCalled();
    },
  );
});
