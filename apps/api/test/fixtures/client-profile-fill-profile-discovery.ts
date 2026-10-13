import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';
import type { ClientProfileFillProfileDiscovery } from '../../src/clients/client-profile-fill-profile-discovery.js';

export const ctx = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  role: 'standard_user',
} as unknown as TenantContext;
export const clientId = '33333333-3333-3333-3333-333333333333';
export const runId = '44444444-4444-4444-4444-444444444444';
export const now = new Date('2026-10-13T12:00:00.000Z');

export function facility(overrides: Record<string, unknown> = {}) {
  return {
    id: 'facility-one',
    name: 'Headquarters',
    addressLine: '101 Main Street',
    city: 'Arlington',
    state: 'VA',
    zip: '22201',
    geocodeStatus: 'pending',
    updatedAt: new Date('2026-10-12T10:00:00.000Z'),
    congressionalDistrict: null,
    stateHouseDistrict: null,
    stateSenateDistrict: null,
    ...overrides,
  };
}

export function resolved(overrides: Record<string, unknown> = {}) {
  return {
    congressionalDistrict: 'VA-08',
    stateHouseDistrict: 'VA-HD-49',
    stateSenateDistrict: 'VA-SD-31',
    geocodeStatus: 'matched',
    geocodeMatchedAddress: '101 MAIN ST, ARLINGTON, VA, 22201',
    districtSource: 'geocoded',
    ...overrides,
  };
}

interface Options {
  profile?: unknown;
  profileError?: Error;
  client?: { intakeData?: unknown } | null;
  clientError?: Error;
  facilities?: Record<string, unknown>[];
  proposals?: unknown[];
  facilityReadError?: Error;
  pendingReadError?: Error;
  insertOutcomes?: Array<number | Error>;
  resolverOutcomes?: Array<ReturnType<typeof resolved> | Error>;
  terminal?: boolean;
  cursorError?: Error;
  afterCursor?: () => void;
}
interface Call {
  operation: string;
  args: unknown[];
  transaction: number | null;
}
interface Transaction {
  id: number;
  tenantId: string;
  effects: Call[];
  result?: 'commit' | 'rollback';
}
interface State {
  options: Options;
  calls: Call[];
  events: string[];
  transactions: Transaction[];
  committed: Call[];
  current: Transaction | null;
  insertIndex: number;
  resolverIndex: number;
}

function record(state: State, operation: string, args: unknown[], write = false) {
  const transaction = state.current?.id ?? null;
  const call = { operation, args, transaction };
  state.calls.push(call);
  state.events.push(`${transaction ?? 'outside'}:${operation}`);
  if (write) state.current?.effects.push(call);
  return call;
}

function rawMethods(state: State) {
  return {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('SELECT proposed_value_jsonb AS "proposedValue"')) {
        record(state, 'pending', [sql, ...args]);
        if (state.options.pendingReadError) throw state.options.pendingReadError;
        return (state.options.proposals ?? []).map((proposedValue) => ({ proposedValue }));
      }
      if (sql.includes("status IN ('accepted', 'rejected')")) {
        record(state, 'terminal', [sql, ...args]);
        return state.options.terminal ? [{ id: 'reviewed-finding' }] : [];
      }
      throw new Error(`Unexpected profile query: ${sql}`);
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('INSERT INTO client_profile_fill_source_cursor')) {
        record(state, 'cursor', [sql, ...args], true);
        if (state.options.cursorError) throw state.options.cursorError;
        state.options.afterCursor?.();
        return 1;
      }
      if (sql.includes('UPDATE client_profile_fill_finding')) {
        record(state, 'retire', [sql, ...args], true);
        return 0;
      }
      if (sql.includes('INSERT INTO client_profile_fill_finding')) {
        record(state, 'finding', [sql, ...args], true);
        const outcome = state.options.insertOutcomes?.[state.insertIndex++] ?? 1;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }
      throw new Error(`Unexpected profile mutation: ${sql}`);
    }),
  };
}

function modelMethods(state: State) {
  return {
    client: {
      findFirst: jest.fn(async (args: unknown) => {
        record(state, 'client', [args]);
        if (state.options.clientError) throw state.options.clientError;
        return state.options.client === undefined ? { intakeData: {} } : state.options.client;
      }),
    },
    clientFacility: {
      findMany: jest.fn(async (args: { select: Record<string, boolean>; take: number }) => {
        record(state, 'facilities', [args]);
        if (state.options.facilityReadError) throw state.options.facilityReadError;
        return (state.options.facilities ?? [])
          .slice(0, args.take)
          .map((row) => Object.fromEntries(Object.keys(args.select).map((key) => [key, row[key]])));
      }),
    },
  };
}

function prismaStub(state: State) {
  return {
    withTenant: jest.fn(async (tenantId: string, callback: (tx: unknown) => Promise<unknown>) => {
      const transaction: Transaction = { id: state.transactions.length + 1, tenantId, effects: [] };
      const tx = { scope: transaction.id, ...rawMethods(state), ...modelMethods(state) };
      state.transactions.push(transaction);
      state.current = transaction;
      state.events.push(`${transaction.id}:begin`);
      try {
        const result = await callback(tx);
        transaction.result = 'commit';
        state.committed.push(...transaction.effects);
        state.events.push(`${transaction.id}:commit`);
        return result;
      } catch (error) {
        transaction.result = 'rollback';
        state.events.push(`${transaction.id}:rollback`);
        throw error;
      } finally {
        state.current = null;
      }
    }),
  };
}

function discoveryServices(state: State) {
  return {
    intelligence: {
      getClientProfile: jest.fn(async (...args: unknown[]) => {
        record(state, 'profile', args);
        if (state.options.profileError) throw state.options.profileError;
        return state.options.profile === undefined ? {} : state.options.profile;
      }),
    },
    facilities: {
      resolveFacilityDistrict: jest.fn(async (...args: unknown[]) => {
        record(state, 'resolve', args);
        const outcome = state.options.resolverOutcomes?.[state.resolverIndex++] ?? resolved();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      }),
    },
  };
}

// Original Completion routes, cursor writes, finding hashes, and review ledger run
// unchanged. Only callback transaction I/O and canonical provider facades are fakes.
export function harness(options: Options = {}) {
  const state: State = {
    options,
    calls: [],
    events: [],
    transactions: [],
    committed: [],
    current: null,
    insertIndex: 0,
    resolverIndex: 0,
  };
  const prisma = prismaStub(state);
  const providers = discoveryServices(state);
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    {} as never,
    providers.intelligence as never,
    providers.facilities as never,
    {} as never,
    {} as never,
  );
  const routes = (
    service as unknown as { owners: { profileDiscovery: ClientProfileFillProfileDiscovery } }
  ).owners.profileDiscovery;
  return {
    ...state,
    service,
    prisma,
    ...providers,
    callsOf: (operation: string) => state.calls.filter((call) => call.operation === operation),
    federal: () => routes.gatherFederalMarket(ctx, clientId, runId),
    facilityResolution: () => routes.gatherFacilityResolution(ctx, clientId, runId),
    districts: () => routes.gatherDistrictNexus(ctx, clientId, runId),
    findings: () => state.calls.filter((call) => call.operation === 'finding').map(decodeFinding),
    cursors: () =>
      state.calls
        .filter((call) => call.operation === 'cursor')
        .map((call) => ({
          tenantId: call.args[1],
          clientId: call.args[2],
          source: call.args[3],
          watermark: JSON.parse(call.args[4] as string),
        })),
  };
}

function decodeFinding(call: Call) {
  return {
    runId: call.args[1],
    tenantId: call.args[2],
    clientId: call.args[3],
    kind: call.args[4],
    targetKey: call.args[5],
    source: call.args[6],
    factKind: call.args[7],
    currentValue: JSON.parse(call.args[8] as string),
    proposedValue: JSON.parse(call.args[9] as string),
    evidence: JSON.parse(call.args[10] as string),
    confidence: call.args[11],
    status: call.args[12],
    contentHash: call.args[13],
  };
}

export function installHooks() {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected provider request');
    });
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
