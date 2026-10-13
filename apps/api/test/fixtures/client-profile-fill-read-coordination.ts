import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';
import type { RefreshScheduleRow } from '../../src/clients/client-profile-fill-completion.service.js';

export const tenantId = '11111111-1111-1111-1111-111111111111';
export const clientId = '22222222-2222-2222-2222-222222222222';
export const now = '2026-10-13T12:00:00.000Z';
export const ctx: TenantContext = {
  tenantId,
  tenantSlug: 'read-test',
  userId: 'read-actor',
  clerkUserId: 'clerk-read-actor',
  role: 'standard_user',
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export function schedule(overrides: Partial<RefreshScheduleRow> = {}): RefreshScheduleRow {
  return {
    enabled: true,
    cadenceHours: 24,
    sources: ['lda'],
    nextRunAt: new Date('2026-10-14T12:00:00.000Z'),
    lastEnqueuedAt: null,
    updatedByUserId: ctx.userId,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...overrides,
  };
}
interface Call {
  operation: string;
  args: unknown[];
  sql?: string;
}
interface Options {
  setup?: Record<string, unknown>;
  setupRead?: Promise<unknown>;
  scheduleRows?: RefreshScheduleRow[];
  scheduleRead?: Promise<RefreshScheduleRow[]>;
  cursor?: unknown;
  cursorRead?: Promise<Array<{ watermark: unknown }>>;
  counts?: Array<{ status: string; count: unknown }>;
  countsRead?: Promise<Array<{ status: string; count: unknown }>>;
  authReplies?: Array<{ id: string } | null | Promise<{ id: string } | null>>;
  failure?: 'workflow' | 'cursor' | 'schedule' | 'counts';
  error?: Error;
}
function operation(sql: string) {
  if (sql.includes('FROM client_profile_fill_source_cursor')) return 'cursor';
  if (sql.includes('FROM client_profile_fill_schedule')) return 'schedule';
  if (sql.includes('FROM client_profile_fill_finding')) return 'counts';
  throw new Error(`Unexpected coordination query: ${sql}`);
}
function readRows(options: Options, op: string) {
  if (options.failure === op) throw options.error ?? new Error(`${op} failed`);
  if (op === 'cursor')
    return options.cursorRead ?? ('cursor' in options ? [{ watermark: options.cursor }] : []);
  if (op === 'schedule') return options.scheduleRead ?? options.scheduleRows ?? [];
  if (op === 'counts') return options.countsRead ?? options.counts ?? [];
  throw new Error(`Unexpected coordination read: ${op}`);
}
export function harness(options: Options = {}) {
  const calls: Call[] = [];
  const signals = new Map<string, ReturnType<typeof deferred<void>>>();
  const signal = (op: string) => {
    if (!signals.has(op)) signals.set(op, deferred<void>());
    return signals.get(op)!;
  };
  const capture = (operation: string, args: unknown[], sql?: string) => {
    calls.push({ operation, args, sql });
    signal(operation).resolve();
  };
  let authCount = 0;
  const unexpected = jest.fn(async () => {
    throw new Error('Unexpected coordination I/O');
  });
  const prisma = {
    withTenantUser: jest.fn(
      async (tenant: string, user: string, callback: (tx: unknown) => Promise<unknown>) => {
        authCount += 1;
        const ordinal = authCount;
        capture(`auth-${ordinal}`, [tenant, user]);
        return callback({
          client: {
            findFirst: jest.fn(async (input: unknown) => {
              capture('client', [input]);
              const reply = options.authReplies?.[ordinal - 1];
              const result = reply === undefined ? { id: clientId } : await reply;
              capture(`authorized-${ordinal}`, [result]);
              return result;
            }),
          },
        });
      },
    ),
    withTenant: jest.fn(async (tenant: string, callback: (tx: unknown) => Promise<unknown>) => {
      capture('tenant-read', [tenant]);
      return callback({
        $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
          const op = operation(sql);
          capture(op, args, sql);
          return readRows(options, op);
        }),
        $executeRawUnsafe: unexpected,
      });
    }),
    withSystem: unexpected,
    $queryRawUnsafe: unexpected,
    $executeRawUnsafe: unexpected,
  };
  const workflow = {
    getSetup: jest.fn(async (...args: unknown[]) => {
      capture('workflow', args);
      if (options.failure === 'workflow') throw options.error ?? new Error('workflow failed');
      return options.setupRead ?? options.setup ?? { taskPreview: ['Core task'], marker: 'core' };
    }),
  };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    workflow as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return {
    service,
    prisma,
    workflow,
    calls,
    unexpected,
    started: (op: string) => signal(op).promise,
    callsOf: (op: string) => calls.filter((call) => call.operation === op),
    setup: () => service.getSetup(ctx, clientId),
    health: () => service.getAdvocacyHistoryHealth(ctx, clientId),
  };
}
export const sqlText = (sql?: string) => (sql ?? '').replace(/\s+/g, ' ').trim();
export function installReadClock() {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(now));
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider request'));
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
