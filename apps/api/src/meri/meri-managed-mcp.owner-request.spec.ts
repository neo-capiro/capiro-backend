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

type HookMethod = 'findMany' | 'findFirst' | 'updateMany';

/**
 * A typed mutation hook that changes the ACTUAL stored rows at ONE real
 * findMany/findFirst boundary. `when` encodes the exact query shape the service
 * emits at that boundary; a hook that never matches leaves `hits` at 0, so a
 * test asserting `hits === 1` cannot pass unless the intended boundary ran with
 * the intended predicate.
 */
interface BoundaryHook {
  name: string;
  method: HookMethod;
  when: (args: { where?: Where }) => boolean;
  apply: (rows: Row[]) => void;
  hits: number;
  matchedWheres: Where[];
}

function boundaryHook(
  name: string,
  method: HookMethod,
  when: BoundaryHook['when'],
  apply: BoundaryHook['apply'],
): BoundaryHook {
  return { name, method, when, apply, hits: 0, matchedWheres: [] };
}

/**
 * Faithful query-time snapshot: Prisma returns VALUES, not references to the
 * mutable in-memory row. structuredClone preserves Date instances, so a later
 * mutation of the stored row cannot retroactively rewrite a snapshot already
 * handed to an earlier read (e.g. the admitted schema/source objects).
 */
function cloneRow(row: Row): Row {
  return structuredClone(row);
}

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

function createDb(rows: Row[], hooks: BoundaryHook[] = []) {
  const fireBoundaryHooks = (method: HookMethod, args: { where?: Where }, stored: Row[]): void => {
    for (const hook of hooks) {
      if (hook.method !== method || !hook.when(args)) continue;
      hook.hits += 1;
      hook.matchedWheres.push(args?.where ?? {});
      // Mutate the ACTUAL stored rows at the boundary, BEFORE the query
      // evaluates, so the returned snapshot reflects the mutation.
      hook.apply(stored);
    }
  };
  const clioMcpServer = {
    findMany: jest.fn(
      async (args: { where?: Where; orderBy?: Record<string, 'asc' | 'desc'> }) => {
        fireBoundaryHooks('findMany', args, rows);
        const matched = rows.filter((row) => whereMatches(row, args?.where ?? {}));
        const orderBy = args?.orderBy;
        const entries = orderBy ? Object.entries(orderBy) : [];
        if (!entries.length) return matched.map(cloneRow);
        const [field, dir] = entries[0]!;
        return [...matched]
          .sort((a, b) => {
            const av = (a as unknown as Record<string, unknown>)[field];
            const bv = (b as unknown as Record<string, unknown>)[field];
            const an = av instanceof Date ? av.getTime() : Number(av);
            const bn = bv instanceof Date ? bv.getTime() : Number(bv);
            const cmp = an === bn ? 0 : an < bn ? -1 : 1;
            return dir === 'desc' ? -cmp : cmp;
          })
          .map(cloneRow);
      },
    ),
    findFirst: jest.fn(async (args: { where?: Where }) => {
      fireBoundaryHooks('findFirst', args, rows);
      const row = rows.find((candidate) => whereMatches(candidate, args?.where ?? {}));
      return row ? cloneRow(row) : null;
    }),
    updateMany: jest.fn(async (args: { where?: Where; data?: Record<string, unknown> }) => {
      // Fire boundary hooks BEFORE the write predicate is evaluated, so a hook
      // can model a concurrent mutation landing in the findFirst -> updateMany
      // window and the conditional write CAS is exercised against the CURRENT
      // stored row, exactly as Prisma would evaluate it.
      fireBoundaryHooks('updateMany', args, rows);
      const matched = rows.filter((row) => whereMatches(row, args?.where ?? {}));
      for (const row of matched) Object.assign(row, args?.data ?? {});
      return { count: matched.length };
    }),
    update: jest.fn(async (args: { where: Where; data: Record<string, unknown> }) => {
      const row = rows.find((candidate) => whereMatches(candidate, args.where));
      if (!row) throw new Error('Record to update not found.');
      Object.assign(row, args.data);
      return cloneRow(row);
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

function harness(rows: Row[], client: McpClient, hooks: BoundaryHook[] = []) {
  const db = createDb(rows, hooks);
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

describe('post-admission static-authority mutation at the final id-scoped boundary', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, CLIO_MCP_ENABLED: 'true', MERI_MCP_AIRTABLE_ENABLED: 'true' };
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * Prime the real advertisement/cache (exactly one listTools), then hand back
   * handles whose hook mutates the stored row AT the exact
   * `visibleServers({ id, enabled: true })` read inside executeBridged
   * (meri-mcp.service.ts:640-642) — the LAST read before clientFor/callTool.
   * No other discovery read in the chain carries `where.id`, so a hook that
   * fires exactly once proves THIS window was exercised, not an earlier one.
   */
  function primeThenMutateAtFinalBoundary(mutate: (row: Row) => void) {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow();
    const hook = boundaryHook(
      'executeBridged.finalIdScopedVisibleServers',
      'findMany',
      (args) => args?.where?.id === row.id && args?.where?.enabled === true,
      () => mutate(row),
    );
    const { mcp, managed, db } = harness([row], { listTools, callTool }, [hook]);
    return { listTools, callTool, row, hook, mcp, managed, db };
  }

  async function runCase(mutate: (row: Row) => void) {
    const c = primeThenMutateAtFinalBoundary(mutate);
    // Real advertisement through the discovery path: exactly one listTools.
    await expect(c.mcp.bridgedSchemasFor(OWNER)).resolves.toHaveLength(1);
    expect(c.listTools).toHaveBeenCalledTimes(1);

    const error = await c.managed.executeRead(OWNER, TOOL, INPUT).then(
      () => null,
      (e: unknown) => e,
    );

    // The final id-scoped boundary was actually reached, with the real predicate.
    expect(c.hook.hits).toBe(1);
    expect(c.hook.matchedWheres[0]).toMatchObject({
      id: c.row.id,
      tenantId: OWNER.tenantId,
      enabled: true,
    });
    // Cached discovery is reused — no rediscovery.
    expect(c.listTools).toHaveBeenCalledTimes(1);
    // The last-mile re-validation must deny before any provider I/O.
    expect(c.callTool).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    return { ...c, error };
  }

  test('an endpoint change at the final id-scoped read is denied before provider I/O', async () => {
    const { error } = await runCase((row) => {
      row.endpoint = 'https://attacker.example/mcp';
    });
    expect((error as Error).message).toBe('This app connection is unavailable. Please reconnect.');
  });

  test('a name change at the final id-scoped read is denied before provider I/O', async () => {
    const { error } = await runCase((row) => {
      row.name = 'renamed-connector';
    });
    expect((error as Error).message).toBe('This app connection is unavailable. Please reconnect.');
  });

  test('a scope change off personal at the final id-scoped read is denied before provider I/O', async () => {
    const { error } = await runCase((row) => {
      row.scope = 'tenant';
    });
    expect((error as Error).message).toBe('This app connection is unavailable. Please reconnect.');
  });

  test('a transport change off http at the final id-scoped read is denied before provider I/O', async () => {
    const { error } = await runCase((row) => {
      row.transport = 'stdio';
    });
    expect((error as Error).message).toBe('This app connection is unavailable. Please reconnect.');
  });

  test('an authType change off oauth at the final id-scoped read is denied before provider I/O', async () => {
    const { error } = await runCase((row) => {
      row.authType = 'token';
    });
    expect((error as Error).message).toBe('This app connection is unavailable. Please reconnect.');
  });

  test('an emptied toolAllowlist at the final id-scoped read is denied before provider I/O', async () => {
    const { error } = await runCase((row) => {
      row.toolAllowlist = [];
      row.readOnlyTools = [];
    });
    expect((error as Error).message).toBe('Connected-app tool is unavailable or not read-only.');
  });

  // The catalog window. When catalogId leaves the managed set at the final
  // id-scoped read, managedAppDefinition(server.catalogId) is undefined at
  // meri-mcp.service.ts:647, so the managed guard is skipped, AND clientFor
  // (742) has no managed block to enforce endpoint/name/scope/transport. A
  // cached managed tool then reaches the provider. These cases assert the SAFE
  // outcome (deny, zero provider calls) and are EXPECTED TO FAIL against the
  // current source until the minimal production repair. They must not be
  // relaxed to permit the unsafe call.
  test('a catalogId change to a non-managed id at the final id-scoped read must not reach the provider', async () => {
    const { error } = await runCase((row) => {
      row.catalogId = 'not-a-managed-app';
    });
    expect(error).toBeInstanceOf(Error);
  });

  test('a catalogId change to null at the final id-scoped read must not reach the provider', async () => {
    const { error } = await runCase((row) => {
      row.catalogId = null;
    });
    expect(error).toBeInstanceOf(Error);
  });
});

describe('hardenServer owner window: no narrowing write to a reassigned row', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, CLIO_MCP_ENABLED: 'true', MERI_MCP_AIRTABLE_ENABLED: 'true' };
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * The actor's own personal row still carries unsafe persisted metadata, so
   * schemasForMeriV3's hardenServer(tenantId, row.id) would normally narrow it.
   * The hook reassigns ownership at hardenServer's real findFirst boundary
   * (meri-managed-mcp.service.ts:298-300) — AFTER personalRows returned its
   * snapshot and BEFORE the scoped updateMany (317-333) is evaluated. That
   * update predicate is {id, tenantId, enabled, connectionStatus in} with NO
   * owner/scope term, so the narrowing / error-status write still lands on the
   * now-foreign row. Asserted here against the SAFE outcome; expected to FAIL
   * against current source until the minimal owner-filter repair.
   */
  function hardenWindowCase(overrides: Partial<Row>) {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow(overrides);
    const original = structuredClone(row);
    const hook = boundaryHook(
      'schemasForMeriV3.hardenServer.findFirst',
      'findFirst',
      (args) => args?.where?.id === row.id && args?.where?.tenantId === OWNER.tenantId,
      (rows) => {
        const stored = rows.find((candidate) => candidate.id === row.id);
        if (stored) stored.ownerUserId = 'user-other';
      },
    );
    const { db, managed } = harness([row], { listTools, callTool }, [hook]);
    return { listTools, callTool, row, original, hook, db, managed };
  }

  test('narrowing hardening must not land on a row reassigned mid-read', async () => {
    const c = hardenWindowCase({
      toolAllowlist: ['list_bases', 'execute_api'],
      readOnlyTools: ['list_bases', 'execute_api'],
    });

    const error = await c.managed.executeRead(OWNER, TOOL, INPUT).then(
      () => null,
      (e: unknown) => e,
    );

    // The reassignment window was actually exercised, with the real predicate.
    expect(c.hook.hits).toBe(1);
    expect(c.hook.matchedWheres[0]).toMatchObject({ id: c.row.id, tenantId: OWNER.tenantId });

    // The now-foreign row keeps its ORIGINAL metadata: no narrowing write reached it.
    expect(c.row.toolAllowlist).toEqual(c.original.toolAllowlist);
    expect(c.row.readOnlyTools).toEqual(c.original.readOnlyTools);
    expect(c.row.connectionStatus).toBe(c.original.connectionStatus);
    // And the actor's read was denied with zero provider calls.
    expect(error).toBeInstanceOf(Error);
    expect(c.listTools).not.toHaveBeenCalled();
    expect(c.callTool).not.toHaveBeenCalled();
  });

  test('error-status hardening must not land on a row reassigned mid-read', async () => {
    const c = hardenWindowCase({
      toolAllowlist: ['execute_api'],
      readOnlyTools: ['execute_api'],
    });

    const error = await c.managed.executeRead(OWNER, TOOL, INPUT).then(
      () => null,
      (e: unknown) => e,
    );

    expect(c.hook.hits).toBe(1);
    // No error-status write landed on the now-foreign row.
    expect(c.row.connectionStatus).not.toBe('error');
    expect(c.row.connectionStatus).toBe(c.original.connectionStatus);
    expect(c.row.toolAllowlist).toEqual(c.original.toolAllowlist);
    expect(error).toBeInstanceOf(Error);
    expect(c.listTools).not.toHaveBeenCalled();
    expect(c.callTool).not.toHaveBeenCalled();
  });
});

describe('hardenServer conditional write (CAS) owner window: post-findFirst reassignment', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv, CLIO_MCP_ENABLED: 'true', MERI_MCP_AIRTABLE_ENABLED: 'true' };
    jest.clearAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * The actor's own personal row still needs safe hardening, so
   * schemasForMeriV3's hardenServer(tenantId, row.id, ctx.userId) reads it while
   * the owner is still the actor and decides to write. The hook then reassigns
   * ownership at hardenServer's REAL updateMany boundary — AFTER findFirst has
   * already returned its snapshot and BEFORE the write predicate is evaluated.
   * This is the genuine post-findFirst / pre-updateMany window: the owner-scoped
   * conditional write CAS must match ZERO rows, so the now-foreign row keeps its
   * original metadata. The reassigned row is no longer visible to the actor's
   * canonical read, so the read is denied with zero provider I/O.
   */
  function casWindowCase(overrides: Partial<Row>) {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow(overrides);
    const original = structuredClone(row);
    const hook = boundaryHook(
      'schemasForMeriV3.hardenServer.updateMany',
      'updateMany',
      (args) =>
        args?.where?.id === row.id &&
        args?.where?.tenantId === OWNER.tenantId &&
        args?.where?.scope === 'user' &&
        args?.where?.ownerUserId === OWNER.userId,
      (rows) => {
        const stored = rows.find((candidate) => candidate.id === row.id);
        if (stored) stored.ownerUserId = 'user-other';
      },
    );
    const { db, managed } = harness([row], { listTools, callTool }, [hook]);
    return { listTools, callTool, row, original, hook, db, managed };
  }

  test('a narrowing write must not land on a row reassigned between findFirst and updateMany', async () => {
    const c = casWindowCase({
      toolAllowlist: ['list_bases', 'execute_api'],
      readOnlyTools: ['list_bases', 'execute_api'],
    });

    const error = await c.managed.executeRead(OWNER, TOOL, INPUT).then(
      () => null,
      (e: unknown) => e,
    );

    // The genuine post-findFirst/pre-updateMany window ran, with the real
    // conditional owner predicate (scope:user + ownerUserId in the write CAS).
    expect(c.hook.hits).toBe(1);
    expect(c.hook.matchedWheres[0]).toMatchObject({
      id: c.row.id,
      tenantId: OWNER.tenantId,
      scope: 'user',
      ownerUserId: OWNER.userId,
    });
    // The reassigned-away row keeps its ORIGINAL metadata: the CAS write matched
    // zero rows and never narrowed it.
    expect(c.row.toolAllowlist).toEqual(c.original.toolAllowlist);
    expect(c.row.readOnlyTools).toEqual(c.original.readOnlyTools);
    expect(c.row.connectionStatus).toBe(c.original.connectionStatus);
    // Canonical read denied, zero provider I/O.
    expect(error).toBeInstanceOf(Error);
    expect(c.listTools).not.toHaveBeenCalled();
    expect(c.callTool).not.toHaveBeenCalled();
  });

  test('an error-status write must not land on a row reassigned between findFirst and updateMany', async () => {
    const c = casWindowCase({
      toolAllowlist: ['execute_api'],
      readOnlyTools: ['execute_api'],
    });

    const error = await c.managed.executeRead(OWNER, TOOL, INPUT).then(
      () => null,
      (e: unknown) => e,
    );

    expect(c.hook.hits).toBe(1);
    // No error-status write landed on the now-foreign row.
    expect(c.row.connectionStatus).not.toBe('error');
    expect(c.row.connectionStatus).toBe(c.original.connectionStatus);
    expect(c.row.toolAllowlist).toEqual(c.original.toolAllowlist);
    expect(error).toBeInstanceOf(Error);
    expect(c.listTools).not.toHaveBeenCalled();
    expect(c.callTool).not.toHaveBeenCalled();
  });
});

/**
 * Additive availability slice: the SAME real personal owner chain, with ONLY the
 * provider transport mocked. Proves the managed catalog can now distinguish a
 * genuine non-outage result (nothing eligible, or a healthy app) from an actual
 * connector/registry discovery failure, retains healthy authorized tools from a
 * partial catalog, classifies auth/catalog failures, and never discloses another
 * owner/tenant or a custom connector through the sanitized result.
 */
describe('managed catalog availability (personal owner, provider-free)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      CLIO_MCP_ENABLED: 'true',
      MERI_MCP_AIRTABLE_ENABLED: 'true',
      MERI_MCP_GOOGLE_DRIVE_ENABLED: 'true',
      MERI_MCP_GOOGLE_DRIVE_CLIENT_ID: 'id',
      MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET: 'secret',
      MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS: OWNER.userId,
      MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS: OWNER.tenantId,
    };
    // resetAllMocks (not clearAllMocks) so a per-endpoint mockImplementation from
    // a prior test can never leak into the next one; harness re-seats the
    // transport mock return value in every test.
    jest.resetAllMocks();
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  function clientFor(listTools: jest.Mock): McpClient {
    return { listTools, callTool: jest.fn(async () => providerResult) } as McpClient;
  }

  /** Route the mocked transport to a per-endpoint client so two managed apps can
   *  have independent provider behaviour without a second service instance. */
  function routeClients(byEndpoint: Record<string, McpClient>): void {
    jest
      .mocked(createMcpClient)
      .mockImplementation((conn) => byEndpoint[conn.endpoint ?? 'default']!);
  }

  test('a caller with no eligible connection is complete, deliberate, and provider-free', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const { managed } = harness([airtableRow({ enabled: false })], clientFor(listTools));

    const result = await managed.managedCatalogForMeriV3(OWNER);

    expect(result.schemas).toEqual([]);
    expect(result.availability).toEqual({
      state: 'no_eligible',
      complete: true,
      registryUnavailable: false,
      failures: [],
    });
    expect(listTools).not.toHaveBeenCalled();
  });

  test('a healthy eligible app yields a complete catalog, distinct from an outage', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const { managed } = harness([airtableRow()], clientFor(listTools));

    const result = await managed.managedCatalogForMeriV3(OWNER);

    expect(result.schemas.map((s) => s.name)).toEqual(['mcp__meriv3_airtable__list_bases']);
    expect(result.availability).toMatchObject({ state: 'ok', complete: true, failures: [] });
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  test('a provider listTools outage is unavailable — never a silent empty success', async () => {
    const listTools = jest.fn(async () => {
      throw new Error('provider unreachable');
    });
    const { managed } = harness([airtableRow()], clientFor(listTools));

    const result = await managed.managedCatalogForMeriV3(OWNER);

    expect(result.schemas).toEqual([]);
    expect(result.availability).toEqual({
      state: 'unavailable',
      complete: false,
      registryUnavailable: false,
      failures: [{ appId: 'airtable', name: 'Airtable', reason: 'unavailable' }],
    });
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  test('a partial catalog retains healthy authorized tools beside the failed app', async () => {
    const airtableList = jest.fn(async () => AIRTABLE_TOOLS);
    const driveList = jest.fn(async () => {
      throw new Error('drive down');
    });
    const { managed } = harness([airtableRow(), driveRow()], clientFor(airtableList));
    routeClients({
      [MERIV3_AIRTABLE_ENDPOINT]: clientFor(airtableList),
      [MERIV3_GOOGLE_DRIVE_ENDPOINT]: clientFor(driveList),
    });

    const result = await managed.managedCatalogForMeriV3(OWNER);

    expect(result.schemas.map((s) => s.name)).toEqual(['mcp__meriv3_airtable__list_bases']);
    expect(result.availability).toEqual({
      state: 'partial',
      complete: false,
      registryUnavailable: false,
      failures: [{ appId: 'google-drive', name: 'Google Drive', reason: 'unavailable' }],
    });
    // One bounded listTools per eligible app — no storm, no duplicate read.
    expect(airtableList).toHaveBeenCalledTimes(1);
    expect(driveList).toHaveBeenCalledTimes(1);
  });

  test('an authorization failure is reported as needs_reauth, not a plain outage', async () => {
    const listTools = jest.fn(async () => {
      throw Object.assign(new Error('expired'), { name: 'InvalidTokenError' });
    });
    const { managed } = harness([airtableRow()], clientFor(listTools));

    const result = await managed.managedCatalogForMeriV3(OWNER);

    expect(result.availability).toEqual({
      state: 'unavailable',
      complete: false,
      registryUnavailable: false,
      failures: [{ appId: 'airtable', name: 'Airtable', reason: 'needs_reauth' }],
    });
  });

  test('a managed app advertising no supported read tool is malformed, not available', async () => {
    const listTools = jest.fn(async () => []);
    const { managed } = harness([airtableRow()], clientFor(listTools));

    const result = await managed.managedCatalogForMeriV3(OWNER);

    expect(result.schemas).toEqual([]);
    expect(result.availability.failures).toEqual([
      { appId: 'airtable', name: 'Airtable', reason: 'malformed' },
    ]);
  });

  test('a failing custom connector is never disclosed through the managed availability', async () => {
    const custom: Row = airtableRow({
      id: 'srv-custom',
      name: 'custom-connector',
      catalogId: null,
      endpoint: 'https://custom.example/mcp',
      authType: 'none',
      toolAllowlist: ['thing'],
      readOnlyTools: [],
    });
    const airtableList = jest.fn(async () => AIRTABLE_TOOLS);
    const customList = jest.fn(async () => {
      throw new Error('custom secret outage');
    });
    const { managed } = harness([airtableRow(), custom], clientFor(airtableList));
    routeClients({
      [MERIV3_AIRTABLE_ENDPOINT]: clientFor(airtableList),
      'https://custom.example/mcp': clientFor(customList),
    });

    const result = await managed.managedCatalogForMeriV3(OWNER);

    // The custom connector really was queried and it really failed...
    expect(customList).toHaveBeenCalledTimes(1);
    // ...but nothing about it leaks into the managed availability.
    expect(result.availability).toEqual({
      state: 'ok',
      complete: true,
      registryUnavailable: false,
      failures: [],
    });
    expect(JSON.stringify(result.availability)).not.toContain('custom');
  });

  test('another owner failing connector is filtered out of the acting owner availability', async () => {
    const airtableList = jest.fn(async () => AIRTABLE_TOOLS);
    const driveList = jest.fn(async () => {
      throw new Error('foreign outage');
    });
    const foreign = driveRow({ id: 'srv-foreign', ownerUserId: 'user-other' });
    const { managed } = harness([airtableRow(), foreign], clientFor(airtableList));
    routeClients({
      [MERIV3_AIRTABLE_ENDPOINT]: clientFor(airtableList),
      [MERIV3_GOOGLE_DRIVE_ENDPOINT]: clientFor(driveList),
    });

    const result = await managed.managedCatalogForMeriV3(OWNER);

    expect(result.availability.failures).toEqual([]);
    // The foreign personal row is not the actor's, so it is never queried.
    expect(driveList).not.toHaveBeenCalled();
  });

  test('the registry snapshot cache is reused with one bounded listTools per app', async () => {
    const airtableList = jest.fn(async () => AIRTABLE_TOOLS);
    const driveList = jest.fn(async () => DRIVE_TOOLS);
    const { managed } = harness([airtableRow(), driveRow()], clientFor(airtableList));
    routeClients({
      [MERIV3_AIRTABLE_ENDPOINT]: clientFor(airtableList),
      [MERIV3_GOOGLE_DRIVE_ENDPOINT]: clientFor(driveList),
    });

    const first = await managed.managedCatalogForMeriV3(OWNER);
    const second = await managed.managedCatalogForMeriV3(OWNER);

    expect(first.availability.state).toBe('ok');
    // Identical result from the same cached per-tenant/actor snapshot.
    expect(second).toEqual(first);
    expect(airtableList).toHaveBeenCalledTimes(1);
    expect(driveList).toHaveBeenCalledTimes(1);
  });

  /**
   * F-A1-1 two-call regression (repeat-call masking). ONE persistent predicate
   * fake DB and ONE real owner; the SAME harness instance serves both calls —
   * no invalidate/reset/row-reconnection and no private-method bypass. The
   * FIRST call records the real discovery failure and persists it onto the
   * stored row (status flips). The SECOND identical owner call must STILL report
   * the known, still-owned outage and retain any healthy tools — never fold it
   * into a deliberate no_eligible/ok/complete "success". The second-call block
   * asserts the DESIRED truthful behaviour and is EXPECTED TO FAIL against the
   * current candidate; it must not be relaxed to accept the masking.
   */
  const outageCases: Array<{
    label: string;
    make: () => McpToolDescriptor[];
    reason: 'unavailable' | 'needs_reauth' | 'malformed';
    status: 'error' | 'needs_reauth';
  }> = [
    {
      label: 'a provider outage',
      make: () => {
        throw new Error('provider unreachable');
      },
      reason: 'unavailable',
      status: 'error',
    },
    {
      label: 'an authorization failure (InvalidTokenError)',
      make: () => {
        throw Object.assign(new Error('expired'), { name: 'InvalidTokenError' });
      },
      reason: 'needs_reauth',
      status: 'needs_reauth',
    },
    {
      label: 'a malformed/unsupported empty catalog',
      make: () => [],
      reason: 'malformed',
      status: 'error',
    },
  ];

  test.each(outageCases)(
    'a currently-owned failed connection keeps its $reason outage across two identical owner calls ($label)',
    async ({ make, reason, status }) => {
      const listTools = jest.fn(async () => make());
      const callTool = jest.fn(async () => providerResult);
      const row = airtableRow();
      const { managed } = harness([row], { listTools, callTool });

      const first = await managed.managedCatalogForMeriV3(OWNER);
      expect(first.availability).toEqual({
        state: 'unavailable',
        complete: false,
        registryUnavailable: false,
        failures: [{ appId: 'airtable', name: 'Airtable', reason }],
      });
      // The real registry catch persisted the failure onto the stored row.
      expect(row.connectionStatus).toBe(status);
      expect(listTools).toHaveBeenCalledTimes(1);

      // Same actor, same persistent predicate, no invalidate — the cached
      // registry/failure is still in force.
      const second = await managed.managedCatalogForMeriV3(OWNER);

      // DESIRED truthfulness (EXPECTED TO FAIL on the candidate): the known,
      // still-owned outage is reported again, never masked as a deliberate
      // no_eligible/complete success.
      expect(second.availability.state).toBe('unavailable');
      expect(second.availability.complete).toBe(false);
      expect(second.availability.failures).toEqual([
        { appId: 'airtable', name: 'Airtable', reason },
      ]);
      expect(second.schemas).toEqual([]);
      // No extra provider I/O on the second call.
      expect(listTools).toHaveBeenCalledTimes(1);
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  test('a partial catalog keeps the failed app reported and the healthy tools on the next identical owner call', async () => {
    const airtableList = jest.fn(async () => AIRTABLE_TOOLS);
    const driveList = jest.fn(async () => {
      throw new Error('drive down');
    });
    const airtableClient = clientFor(airtableList);
    const driveClient = clientFor(driveList);
    const rowD = driveRow();
    const { managed } = harness([airtableRow(), rowD], airtableClient);
    routeClients({
      [MERIV3_AIRTABLE_ENDPOINT]: airtableClient,
      [MERIV3_GOOGLE_DRIVE_ENDPOINT]: driveClient,
    });

    const first = await managed.managedCatalogForMeriV3(OWNER);
    expect(first.schemas.map((s) => s.name)).toEqual(['mcp__meriv3_airtable__list_bases']);
    expect(first.availability).toEqual({
      state: 'partial',
      complete: false,
      registryUnavailable: false,
      failures: [{ appId: 'google-drive', name: 'Google Drive', reason: 'unavailable' }],
    });
    // The real registry catch persisted the failure onto the failed stored row.
    expect(rowD.connectionStatus).toBe('error');
    expect(airtableList).toHaveBeenCalledTimes(1);
    expect(driveList).toHaveBeenCalledTimes(1);

    const second = await managed.managedCatalogForMeriV3(OWNER);

    // DESIRED truthful behaviour (EXPECTED TO FAIL on the candidate): the
    // failed app stays reported and the healthy app stays usable — the known
    // outage must never collapse to an ok/complete success.
    expect(second.schemas.map((s) => s.name)).toEqual(['mcp__meriv3_airtable__list_bases']);
    expect(second.availability.state).toBe('partial');
    expect(second.availability.complete).toBe(false);
    expect(second.availability.failures).toEqual([
      { appId: 'google-drive', name: 'Google Drive', reason: 'unavailable' },
    ]);
    // One bounded listTools per app across both calls, zero callTool.
    expect(airtableList).toHaveBeenCalledTimes(1);
    expect(driveList).toHaveBeenCalledTimes(1);
    expect(airtableClient.callTool as jest.Mock).not.toHaveBeenCalled();
    expect(driveClient.callTool as jest.Mock).not.toHaveBeenCalled();
  });

  test('a currently-owned disconnected row is a deliberate non-outage, provider-free', async () => {
    const listTools = jest.fn(async () => AIRTABLE_TOOLS);
    const { managed } = harness([airtableRow({ connectionStatus: 'disconnected' })], {
      listTools,
      callTool: jest.fn(async () => providerResult),
    });

    const result = await managed.managedCatalogForMeriV3(OWNER);

    // An intentional disconnect is not an outage and not a discovery attempt.
    expect(result.availability).toEqual({
      state: 'no_eligible',
      complete: true,
      registryUnavailable: false,
      failures: [],
    });
    expect(listTools).not.toHaveBeenCalled();
  });

  test('a still-owned failure survives cache invalidation with zero provider retry', async () => {
    const listTools = jest.fn(async () => {
      throw new Error('provider unreachable');
    });
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow();
    const { managed, mcp } = harness([row], { listTools, callTool });

    const first = await managed.managedCatalogForMeriV3(OWNER);
    expect(first.availability.state).toBe('unavailable');
    // The real registry catch persisted the failure onto the stored row.
    expect(row.connectionStatus).toBe('error');
    expect(listTools).toHaveBeenCalledTimes(1);

    // Model cache expiry: drop the per-tenant/actor snapshot. The still-owned
    // failed row must be reported from its CURRENT stored status — no reconnect,
    // no rediscovery, no retry storm.
    mcp.invalidate(OWNER.tenantId);

    const second = await managed.managedCatalogForMeriV3(OWNER);
    expect(second.availability).toEqual({
      state: 'unavailable',
      complete: false,
      registryUnavailable: false,
      failures: [{ appId: 'airtable', name: 'Airtable', reason: 'unavailable' }],
    });
    expect(second.schemas).toEqual([]);
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
  });

  /**
   * Late failure-provenance seam (reviewer Hypothesis 2). The real source order
   * is personalRows -> registry discovery + failure/status write -> fresh
   * visible read -> raw `registry.failures` passthrough. The mutation is applied
   * at the SECOND real OR read (`visibleServers` inside bridgedSchemasDetailedFor),
   * AFTER the registry failure/DB status write and BEFORE the final visibility
   * evaluation, through the existing BoundaryHook (the provider throw itself
   * never mutates the row, so this is not the unrelated registry status-write
   * race). The candidate must never expose a failure OR a schema belonging to a
   * row that is now foreign/disabled/unmanaged, and no private row detail may
   * reach the public availability. These tests assert the DESIRED non-exposure
   * and are EXPECTED TO FAIL on the candidate. No live exploit is claimed; the
   * reviewer adjudicates the measured receipt.
   */
  function lateFinalVisibleCase(mutate: (row: Row) => void) {
    const listTools = jest.fn(async () => {
      throw new Error('provider unreachable');
    });
    const callTool = jest.fn(async () => providerResult);
    const row = airtableRow();
    let orReads = 0;
    const hook = boundaryHook(
      'bridgedSchemasDetailedFor.finalVisibleServers',
      'findMany',
      (args) => {
        const where = args?.where ?? {};
        const branches = Array.isArray(where.OR) ? where.OR : null;
        if (!branches || where.tenantId !== OWNER.tenantId) return false;
        // FIRST OR read is registry discovery; mutate at the SECOND (the final
        // fresh visibility read) so the failure/status write has already landed.
        orReads += 1;
        return orReads === 2;
      },
      (rows) => {
        const stored = rows.find((candidate) => candidate.id === row.id);
        if (stored) mutate(stored);
      },
    );
    const { managed } = harness([row], { listTools, callTool }, [hook]);
    return { listTools, callTool, row, hook, managed };
  }

  const lateMutations: Array<[string, (row: Row) => void]> = [
    [
      'owner transfer to another actor',
      (row) => {
        row.ownerUserId = 'user-other';
      },
    ],
    [
      'disable of the currently-owned row',
      (row) => {
        row.enabled = false;
      },
    ],
    [
      'catalog classification leaving the managed set',
      (row) => {
        row.catalogId = null;
      },
    ],
  ];

  test.each(lateMutations)(
    'a late %s at the final visible read never exposes that row failure or schema',
    async (_label, mutate) => {
      const c = lateFinalVisibleCase(mutate);

      const result = await c.managed.managedCatalogForMeriV3(OWNER);

      // The SECOND, final real OR read was actually exercised, once, with the
      // exact tenant/actor predicate (firm-wide ∪ own personal).
      expect(c.hook.hits).toBe(1);
      expect(c.hook.matchedWheres[0]).toMatchObject({
        tenantId: OWNER.tenantId,
        enabled: true,
        OR: [{ scope: 'tenant' }, { scope: 'user', ownerUserId: OWNER.userId }],
      });

      // DESIRED non-exposure (EXPECTED TO FAIL on the candidate): the now
      // foreign/disabled/unmanaged row contributes neither a failure nor a
      // schema, and no private row detail reaches the public availability.
      expect(result.availability.failures).toEqual([]);
      expect(result.schemas).toEqual([]);
      expect(JSON.stringify(result.availability)).not.toContain(c.row.id);
      expect(JSON.stringify(result.availability)).not.toContain(c.row.name);
      expect(JSON.stringify(result.availability)).not.toContain(MERIV3_AIRTABLE_ENDPOINT);

      // No transport dispatch: only the single discovery listTools ran.
      expect(c.listTools).toHaveBeenCalledTimes(1);
      expect(c.callTool).not.toHaveBeenCalled();
    },
  );
});
