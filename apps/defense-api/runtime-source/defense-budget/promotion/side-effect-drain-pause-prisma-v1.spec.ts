/**
 * Phase 7 Workstream L — the drain pause state.
 *
 * Small, but the properties are load-bearing: the rollback path and the drainer
 * both go through this module, and the whole point of that is that they cannot
 * disagree about whether a scope is paused.
 */
import {
  isDrainPausedV1,
  pauseDrainV1,
  resumeDrainV1,
  type DrainPauseDelegateV1,
} from './side-effect-drain-pause-prisma-v1.js';

function delegate(initial: Record<string, unknown> | null = null): DrainPauseDelegateV1 & {
  row: Record<string, unknown> | null;
  upserts: Record<string, unknown>[];
} {
  const state = {
    row: initial,
    upserts: [] as Record<string, unknown>[],
    async findUnique() {
      return state.row;
    },
    async upsert(args: Record<string, unknown>) {
      state.upserts.push(args);
      const create = args.create as Record<string, unknown>;
      const update = args.update as Record<string, unknown>;
      state.row = state.row == null ? create : { ...state.row, ...update };
      return state.row;
    },
    async updateMany(args: Record<string, unknown>) {
      const where = args.where as Record<string, unknown>;
      if (state.row?.paused !== where.paused) return { count: 0 };
      state.row = { ...state.row, ...(args.data as Record<string, unknown>) };
      return { count: 1 };
    },
  };
  return state;
}

describe('Phase 7 WS L — drain pause state', () => {
  it('treats a scope with no row as not paused', async () => {
    // A database nobody has ever rolled back must still drain.
    expect(await isDrainPausedV1(delegate(), 'defense_budget', 'prod')).toBe(false);
  });

  it('reports paused once a pause is recorded', async () => {
    const d = delegate();
    await pauseDrainV1(d, {
      domain: 'defense_budget',
      environment: 'prod',
      reason: 'rollback to snap-7',
      pausedBy: 'operator-1',
    });
    expect(await isDrainPausedV1(d, 'defense_budget', 'prod')).toBe(true);
  });

  it('carries who paused it and why', async () => {
    const d = delegate();
    await pauseDrainV1(d, {
      domain: 'defense_budget',
      environment: 'prod',
      reason: 'rollback to snap-7: bad conference mark',
      pausedBy: 'promotion-task/rollback',
    });
    expect(d.row).toMatchObject({
      reason: 'rollback to snap-7: bad conference mark',
      pausedBy: 'promotion-task/rollback',
      paused: true,
    });
  });

  it('pauses an already-paused scope without failing', async () => {
    // A rollback can follow a rollback. Failing on the second one would break
    // the pause at exactly the moment an operator needs it.
    const d = delegate();
    const input = {
      domain: 'defense_budget',
      environment: 'prod',
      reason: 'first',
      pausedBy: 'a',
    };
    await pauseDrainV1(d, input);
    await expect(
      pauseDrainV1(d, { ...input, reason: 'second', pausedBy: 'b' }),
    ).resolves.toBeUndefined();
    expect(d.row).toMatchObject({ reason: 'second', pausedBy: 'b' });
  });

  it('clears the resume fields when re-pausing, because the check constraint refuses both', async () => {
    const d = delegate();
    await pauseDrainV1(d, { domain: 'd', environment: 'e', reason: 'r', pausedBy: 'a' });
    await resumeDrainV1(d, { domain: 'd', environment: 'e', resumedBy: 'b' });
    await pauseDrainV1(d, { domain: 'd', environment: 'e', reason: 'again', pausedBy: 'c' });
    expect(d.row).toMatchObject({ paused: true, resumedBy: null, resumedAt: null });
  });

  it('records who resumed and when', async () => {
    const d = delegate();
    await pauseDrainV1(d, { domain: 'd', environment: 'e', reason: 'r', pausedBy: 'a' });
    const result = await resumeDrainV1(d, {
      domain: 'd',
      environment: 'e',
      resumedBy: 'operator-2',
    });
    expect(result.resumed).toBe(true);
    expect(d.row).toMatchObject({ paused: false, resumedBy: 'operator-2' });
    expect(await isDrainPausedV1(d, 'd', 'e')).toBe(false);
  });

  it('makes resuming an unpaused scope a no-op rather than an error', async () => {
    const result = await resumeDrainV1(delegate(), {
      domain: 'd',
      environment: 'e',
      resumedBy: 'x',
    });
    expect(result.resumed).toBe(false);
  });
});
