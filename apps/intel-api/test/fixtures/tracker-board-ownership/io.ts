import type { Prisma } from '../../../generated/prisma-client/index.js';
import type { PrismaService } from '../../../src/prisma/prisma.service.js';
import { clientId, term, topic, watchlist } from './rows.js';

export interface IOCall {
  operation: string;
  args: unknown[];
  scope: 'tenant' | 'system' | 'global';
  tenantId?: string;
  transaction?: number;
}
export interface Options {
  results?: Record<string, unknown>;
  queues?: Record<string, unknown[]>;
}

function rawOperation(sql: string): string {
  if (sql.includes('context_embeddings')) return 'semantic';
  if (sql.includes('FROM client_facilities')) return 'suggestedJurisdictions';
  if (sql.includes('SELECT id::text AS id FROM clients')) return 'clientOwnership';
  if (sql.includes('FROM clients')) return 'clientNames';
  if (sql.includes('SELECT DISTINCT cb.id')) return 'federalCandidates';
  if (sql.includes('SELECT DISTINCT sb.id')) return 'stateCandidates';
  if (sql.includes('FROM state_bill')) return sql.includes('LIKE $1') ? 'stateSearch' : 'stateRows';
  if (sql.includes('FROM congress_bill')) {
    if (sql.includes('LIKE $1')) return 'federalSearch';
    return sql.includes('WHERE id = $1') ? 'federalIdentity' : 'federalRows';
  }
  throw new Error('Unassigned raw I/O: ' + sql);
}

function defaults(): Record<string, unknown> {
  return {
    clientOwnership: [{ id: clientId }],
    clientNames: [],
    suggestedJurisdictions: [],
    semantic: [],
    federalCandidates: [],
    stateCandidates: [],
    federalRows: [],
    federalIdentity: [],
    stateRows: [],
    federalSearch: [],
    stateSearch: [],
    'watchlist.findFirst': watchlist(),
    'watchlist.findMany': [watchlist()],
    'watchlistTopic.findMany': [topic()],
    'watchlistTerm.findMany': [term()],
    'trackedBill.findMany': [],
    'trackedBill.findFirst': null,
    'trackedBill.count': 0,
    'trackedBill.groupBy': [],
    'trackedBill.upsert': {},
    'trackedBill.deleteMany': { count: 0 },
    'trackedBill.updateMany': { count: 1 },
    'intelFeedback.findMany': [],
    'intelFeedback.create': {},
    'intelAlert.findMany': [],
    'intelAlert.findFirst': { id: 'alert' },
    'intelAlert.groupBy': [],
    'intelAlert.create': {},
    'billMatch.findMany': [],
    'billMatch.create': {},
    'billMatch.update': {},
  };
}

export class FixtureIo {
  readonly calls: IOCall[] = [];
  readonly events: string[] = [];
  readonly prisma: PrismaService;
  private readonly results: Record<string, unknown>;
  private readonly queues: Map<string, unknown[]>;
  private readonly gates = new Map<string, Array<() => void>>();
  private sequence = 0;

  constructor(options: Options) {
    this.results = { ...defaults(), ...options.results };
    this.queues = new Map(
      Object.entries(options.queues ?? {}).map(([key, values]) => [key, [...values]]),
    );
    this.prisma = {
      withTenant: <T>(tenantId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
        this.scoped('tenant', tenantId, callback),
      withSystem: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
        this.scoped('system', undefined, callback),
      $queryRawUnsafe: (sql: string, ...values: unknown[]) =>
        this.invoke(rawOperation(sql), [sql, ...values], { scope: 'global' }),
    } as unknown as PrismaService;
  }

  callsOf(operation: string): IOCall[] {
    return this.calls.filter((call) => call.operation === operation);
  }

  queue(operation: string, ...values: unknown[]): void {
    this.queues.set(operation, values);
  }

  started(operation: string): Promise<void> {
    return this.calls.some((call) => call.operation === operation)
      ? Promise.resolve()
      : new Promise((resolve) => {
          this.gates.set(operation, [...(this.gates.get(operation) ?? []), resolve]);
        });
  }

  private async invoke(
    operation: string,
    args: unknown[],
    scope: Omit<IOCall, 'operation' | 'args'>,
  ) {
    this.calls.push({ operation, args, ...scope });
    this.events.push(operation);
    for (const release of this.gates.get(operation) ?? []) release();
    const items = this.queues.get(operation);
    const value = items?.length ? items.shift() : this.results[operation];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? (value as () => unknown)() : value;
  }

  private transaction(scope: IOCall['scope'], tenantId?: string) {
    const id = ++this.sequence;
    const context = { scope, tenantId, transaction: id };
    const models: Record<string, Record<string, (args: unknown) => Promise<unknown>>> = {};
    for (const operation of Object.keys(defaults()).filter((name) => name.includes('.'))) {
      const [model, method] = operation.split('.') as [string, string];
      (models[model] ??= {})[method] = (args) => this.invoke(operation, [args], context);
    }
    const tx = {
      ...models,
      $queryRawUnsafe: (sql: string, ...values: unknown[]) =>
        this.invoke(rawOperation(sql), [sql, ...values], context),
    } as unknown as Prisma.TransactionClient;
    return { id, tx };
  }

  private async scoped<T>(
    scope: IOCall['scope'],
    tenantId: string | undefined,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const { id, tx } = this.transaction(scope, tenantId);
    this.events.push(`tx:start:${id}:${scope}`);
    try {
      const result = await callback(tx);
      this.events.push(`tx:end:${id}`);
      return result;
    } catch (error) {
      this.events.push(`tx:fail:${id}`);
      throw error;
    }
  }
}
