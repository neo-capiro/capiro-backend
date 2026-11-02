import { PrismaService } from './prisma.service.js';
import { readClassicOutreachMetrics } from '../engagement/classic-outreach-metrics.js';
import { readResearchPortfolioMetrics } from '../research-portfolios/research-portfolio-metrics.js';

const start = Date.parse('2026-10-31T12:00:00Z');
const ctx = { tenantId: 'synthetic-tenant', userId: 'synthetic-user', clerkUserId: 'synthetic-clerk', role: 'standard_user' } as any;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(start); });
afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });

/** Real endpoint -> budget adapter -> actual shared transaction boundary.
 * Only acquisition/query/rollback effects are synthetic; no database or client
 * is constructed. This checks forwarded bounds, not native engine timing. */
function harness(mode: 'pool' | 'setup' | 'settings' | 'rollback') {
  const state = { options: [] as any[], firstRows: true, domainCounts: 0,
    transactions: 0, cleaned: 0, setupBudget: null as number | null,
    poolWaiting: false, setupActive: false, rollbackWaiting: false };
  let releaseRollback!: () => void;
  const rollback = new Promise<void>(resolve => { releaseRollback = resolve; });
  const receiver = Object.create(PrismaService.prototype);
  receiver.scopedClient = () => ({ $transaction: async (run: any, options: any) => {
    state.options.push(options);
    const phase = ++state.transactions;
    // Spend 9900ms while respecting both reserved engine allowances:
    // 1950ms acquisition (<2000), then 7950ms execution (<8000).
    if (phase === 1) await delay(1950);
    if (phase === 2 && mode === 'pool') {
      state.poolWaiting = true;
      // Prisma defaults maxWait independently of its transaction timeout.
      await delay(options?.maxWait ?? 2000);
      state.poolWaiting = false;
      throw Object.assign(Error('synthetic acquisition expired'), { code: 'P2028' });
    }
    if (phase === 2 && (mode === 'setup' || mode === 'settings')) await delay(25);
    let statementMs = Infinity;
    const execute = async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const sql = typeof strings === 'string' ? strings : strings.join('?');
      if (phase === 2 && mode === 'settings' && sql.includes('statement_timeout')) {
        state.setupBudget = options.timeout;
        state.setupActive = true;
        try { await delay(options.timeout); }
        finally { state.setupActive = false; }
        throw Object.assign(Error('synthetic first setup statement expired'), { code: 'P2028' });
      }
      if (sql.includes('statement_timeout')) {
        const value = Number.parseInt(String(values[0]), 10);
        if (Number.isFinite(value) && value > 0) statementMs = value;
      }
      if (phase === 2 && mode === 'setup' && sql.includes('app.current_tenant')) {
        state.setupBudget = Math.min(statementMs, options.timeout);
        state.setupActive = true;
        try { await delay(state.setupBudget); }
        finally { state.setupActive = false; }
        throw Object.assign(Error('synthetic tenant setup cancelled'), { code: '57014' });
      }
      return 1;
    };
    const rows = async () => {
      if (state.firstRows) { state.firstRows = false; await delay(7950); }
      return [];
    };
    const count = async () => {
      state.domainCounts++;
      if (mode === 'rollback') throw Error('synthetic query failure');
      return 0;
    };
    const tx = { $executeRaw: execute, $executeRawUnsafe: execute,
      tenantMembership: { findFirst: async () => ({ id: 'synthetic-member', role: 'standard_user', updatedAt: new Date(start) }) },
      outreachRecord: { findMany: rows, count }, researchPortfolio: { findMany: rows, count } };
    try { return await run(tx); }
    finally {
      if (phase === 2 && mode === 'rollback') {
        state.rollbackWaiting = true;
        await rollback;
        state.rollbackWaiting = false;
      }
      state.cleaned++;
    }
  } });
  return { state, releaseRollback, prisma: receiver as PrismaService };
}

describe.each([['Classic', readClassicOutreachMetrics], ['Research', readResearchPortfolioMetrics]] as const)(
  '%s absolute transaction deadline', (_name, read) => {
    test('shares the last 100ms between acquisition and execution', async () => {
      const f = harness('pool'); let settled = false;
      const request = read(f.prisma, ctx, {}, Date.now).then(
        value => { settled = true; return value; }, error => { settled = true; return error; });
      try {
        await jest.advanceTimersByTimeAsync(9900);
        expect(f.state.options.map(value => value.timeout)).toEqual([8000, 50]);
        expect(f.state.options.map(value => value.maxWait)).toEqual([2000, 50]);
        expect(f.state.poolWaiting).toBe(true);
        await jest.advanceTimersByTimeAsync(50);
        expect(settled).toBe(true); expect(f.state.poolWaiting).toBe(false);
        expect(await request).toMatchObject({ status: 503 });
        expect(f.state.domainCounts).toBe(0); expect(f.state.transactions).toBe(2);
      } finally { await jest.runAllTimersAsync(); await request; }
    });

    test.each(['setup', 'settings'] as const)('bounds %s even before domain work starts', async mode => {
      const f = harness(mode); let settled = false;
      const request = read(f.prisma, ctx, {}, Date.now).then(
        value => { settled = true; return value; }, error => { settled = true; return error; });
      try {
        await jest.advanceTimersByTimeAsync(9925);
        expect(f.state.setupActive).toBe(true); expect(f.state.setupBudget).toBe(50);
        await jest.advanceTimersByTimeAsync(50);
        expect(settled).toBe(true); expect(f.state.setupActive).toBe(false);
        expect(await request).toMatchObject({ status: 503 });
        expect(f.state.domainCounts).toBe(0); expect(f.state.cleaned).toBe(2);
      } finally { await jest.runAllTimersAsync(); await request; }
    });

    test('awaits rollback after deadline and starts no postcheck', async () => {
      const f = harness('rollback'); let settled = false;
      const request = read(f.prisma, ctx, {}, Date.now).then(
        value => { settled = true; return value; }, error => { settled = true; return error; });
      try {
        await jest.advanceTimersByTimeAsync(11000);
        expect(f.state.rollbackWaiting).toBe(true); expect(settled).toBe(false);
        expect(f.state.transactions).toBe(2); expect(f.state.domainCounts).toBe(1);
        f.releaseRollback(); expect(await request).toMatchObject({ status: 503 });
        expect(f.state.cleaned).toBe(2);
      } finally { f.releaseRollback(); await jest.runAllTimersAsync(); await request; }
    });
  },
);
