import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { WorkspaceReadBudget, workspaceReadTimedOut } from './workspace-read-budget.js';
import { savedWorkCount } from '../drafts/saved-work-count.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';

const tenant = '11111111-1111-4111-8111-111111111111', client = '22222222-2222-4222-8222-222222222222';
const actor = 'owner', prospect = '33333333-3333-4333-8333-333333333333';
const incomplete = () => new ServiceUnavailableException({ code: 'WORKSPACE_SAVED_WORK_INCOMPLETE' });

/** Synthetic Prisma/PG boundary: SET LOCAL arms the executing server statement.
 * A pending read has no automatic success path. Only its configured timeout or
 * explicit test cleanup can end it; rollback takes50ms and must be awaited.
 * This is source-level cancellation coverage, not a live Postgres claim. */
function database(blocked: string | null) {
  const row = { id: '44444444-4444-4444-8444-444444444444', tenantId: tenant,
    ownerId: blocked === 'collaborator' ? 'another-owner' : actor,
    clientId: client, prospectId: ['prospect', 'prospect-parent', 'brief-receipts'].includes(blocked ?? '') ? prospect : null,
    config: { clientId: client }, status: 'draft', updatedAt: new Date('2026-01-01') };
  const state = { blocked, activeQueries: 0, activeTransactions: 0, rollbacks: 0,
    reads: [] as Array<{ phase: string; at: number; timeout: number }>, options: [] as any[],
    localSettings: [] as number[], released: false };
  let enter!: () => void, release: (() => void) | undefined;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const prisma: any = Object.create(PrismaService.prototype);
  prisma.$transaction = jest.fn(async (operation, options) => {
    state.options.push(options); state.activeTransactions++;
    const slot = state.localSettings.push(0) - 1;
    const read = async (phase: string, value: unknown) => {
      const timeout = state.localSettings[slot]!;
      state.reads.push({ phase, at: Date.now(), timeout });
      if (phase !== state.blocked) return value;
      state.activeQueries++; enter();
      return new Promise((resolve, reject) => {
        const timer = timeout > 0 ? setTimeout(() => {
          state.activeQueries--; release = undefined;
          reject({ code: 'P2010', meta: { code: '57014' } });
        }, timeout) : undefined;
        release = () => { if (timer) clearTimeout(timer); state.activeQueries--; state.released = true; resolve(value); };
      });
    };
    const raw = async (parts: TemplateStringsArray | string, ...values: unknown[]) => {
      const sql = typeof parts === 'string' ? parts : parts.join('?');
      if (sql.includes("set_config('statement_timeout'")) { state.localSettings[slot] = Number.parseInt(String(values[0]), 10); return 1; }
      if (sql.includes('FROM users')) return read('scope', [{ id: client }]);
      if (sql.includes('SELECT (NOT c.memory_wall')) return read('client-wall', [{ allowed: true }]);
      if (sql.includes('FROM clients')) return read('client', [{ id: client, name: 'Saved client' }]);
      if (sql.includes('FROM business_development_prospects')) return read('prospect', [{ linkedClientId: null, status: 'active', dismissedAt: null }]);
      if (sql.includes('FROM tenants')) return read('prospect-tenant', [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true } } }]);
      if (sql.includes('FROM tenant_memberships')) return read('prospect-member', [{ userId: client, clerkUserId: actor }]);
      if (sql.includes('FROM ws_draft')) return read('prospect-parent', [{ ownerId: row.ownerId, prospectId: prospect }]);
      if (sql.includes('FROM ws_document')) return read('brief-receipts', []);
      if (sql.includes('FROM ws_source_action')) return read('source-receipt', []);
      return read('scope-setting', 1);
    };
    const tx: any = { $executeRaw: raw, $executeRawUnsafe: raw, $queryRaw: raw, $queryRawUnsafe: raw,
      wsDraft: { findMany: () => read('population', [row]),
        findFirst: ({ select }: any) => read(select.config ? 'origin' : 'role', row) },
      wsCollaborator: { findFirst: () => read('collaborator', { role: 'viewer' }) } };
    try { return await operation(tx); }
    catch (error) { state.rollbacks++; await new Promise(resolve => setTimeout(resolve, 50)); throw error; }
    finally { state.localSettings[slot] = 0; state.activeTransactions--; }
  });
  // Count must never issue a root/pool query outside its bounded transaction.
  const unbounded = jest.fn(() => { throw new Error('Unbounded database read'); });
  prisma.wsDraft = { findMany: unbounded, findFirst: unbounded };
  prisma.wsCollaborator = { findFirst: unbounded }; prisma.$queryRaw = unbounded;
  const collaborators = new CollaboratorsService(prisma, {} as never);
  return { prisma, state, entered, unbounded, cleanup: () => release?.(),
    run: () => savedWorkCount(prisma, collaborators, tenant, actor, {}) };
}

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('Workspace saved-work remaining SQL budget', () => {
  it.each(['scope', 'population', 'role', 'origin', 'collaborator', 'client', 'client-wall', 'source-receipt', 'prospect', 'prospect-parent', 'brief-receipts'])
  ('cancels a pending %s read at expiry, awaits rollback and issues no further reads', async phase => {
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-31T00:00:00Z'));
    const signal = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(signal.signal);
    const f = database(phase); let outcome: any;
    const pending = f.run().then(value => { outcome = value; }, error => { outcome = error; });
    await f.entered;
    expect(timeout).toHaveBeenCalledWith(10000);
    setTimeout(() => signal.abort(), 10000);
    await jest.advanceTimersByTimeAsync(9999);
    expect(outcome).toBeUndefined(); expect(f.state.activeQueries).toBe(1);
    const countAtExpiry = f.state.reads.length;
    await jest.advanceTimersByTimeAsync(1);
    expect(f.state.activeQueries).toBe(0); expect(outcome).toBeUndefined(); // rollback is still pending
    await jest.advanceTimersByTimeAsync(200); await pending;
    expect(outcome.getResponse()).toEqual({ code: 'WORKSPACE_SAVED_WORK_INCOMPLETE' });
    expect(outcome.getResponse()).not.toHaveProperty('count');
    expect(f.state.reads).toHaveLength(countAtExpiry); expect(f.state.activeTransactions).toBe(0);
    expect(f.state.localSettings.every(setting => setting === 0)).toBe(true);
    expect(f.state.released).toBe(false); expect(f.unbounded).not.toHaveBeenCalled();
    expect(f.state.rollbacks).toBeGreaterThan(0);
    for (const options of f.state.options) expect(options).toEqual({ maxWait: 1000, timeout: 11000 });
    for (const read of f.state.reads) expect(read.timeout).toBeGreaterThan(0);
    // The same pool is reusable; LOCAL settings and expired signals do not leak.
    f.state.blocked = null; timeout.mockImplementation(() => new AbortController().signal);
    expect(await f.run()).toMatchObject({ count: 1, complete: true });
    expect(f.state.activeTransactions).toBe(0); f.cleanup();
  });

  it('uses one decreasing budget across statements and transaction acquisition', async () => {
    jest.useFakeTimers(); jest.setSystemTime(1000);
    const remaining = () => { const value = 11000 - Date.now(); if (value <= 0) throw incomplete(); return value; };
    const settings: number[] = [], options: any[] = [];
    const tx: any = { $executeRaw: async (_parts: unknown, value: string) => { settings.push(parseInt(value, 10)); },
      $queryRawUnsafe: async () => { jest.setSystemTime(Date.now() + 2000); return []; } };
    const db: any = { $transaction: async (fn: any, opts: any) => {
      options.push(opts); jest.setSystemTime(Date.now() + 500); return fn(tx);
    } };
    const budget = new WorkspaceReadBudget(remaining);
    await budget.transaction(db, async scoped => { await scoped.$queryRawUnsafe('SELECT 1'); await scoped.$queryRawUnsafe('SELECT 2'); });
    await budget.transaction(db, scoped => scoped.$queryRawUnsafe('SELECT 3'));
    expect(settings).toEqual([9500, 7500, 5000]);
    expect(options).toEqual([{ maxWait: 1000, timeout: 11000 }, { maxWait: 1000, timeout: 6500 }]);
  });

  it('never starts a transaction after expiry or sends an unlimited zero timeout', async () => {
    const db: any = { $transaction: jest.fn() };
    await expect(new WorkspaceReadBudget(() => { throw incomplete(); }).transaction(db, async () => 1)).rejects.toThrow();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('preserves the existing system reader defaults when no observation budget is supplied', async () => {
    const f = database(null);
    await f.prisma.withSystem((tx: any) => tx.$queryRaw`SELECT id FROM users`);
    expect(f.state.options).toEqual([undefined]);
    expect(f.state.reads.map(read => read.timeout)).toEqual([0, 0]);
    expect(f.state.activeTransactions).toBe(0);
  });

  it.each(['P2024', 'P2028'])('maps bounded acquisition/transaction failure %s without a count', async code => {
    const f = database(null); f.prisma.$transaction.mockRejectedValueOnce({ code });
    await expect(f.run()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_INCOMPLETE' } });
    expect(f.unbounded).not.toHaveBeenCalled();
  });

  it('recognizes server cancellation without misclassifying unrelated database errors', () => {
    expect(workspaceReadTimedOut({ code: 'P2010', meta: { code: '57014' } })).toBe(true);
    expect(workspaceReadTimedOut({ code: 'P2010', meta: { code: '42P01' } })).toBe(false);
  });
});
