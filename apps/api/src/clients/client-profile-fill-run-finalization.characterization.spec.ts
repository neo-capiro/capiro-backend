import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';

interface Candidate {
  runId: string;
  tenantId: string;
}
interface Options {
  candidates?: Candidate[];
  lockFound?: boolean;
  statuses?: string[];
  summaryError?: Error;
}
interface Call {
  operation: string;
  sql: string;
  args: unknown[];
  transaction: number;
}
function harness(options: Options = {}) {
  const calls: Call[] = [];
  const events: string[] = [];
  let current = 0;
  let next = 0;
  const record = (operation: string, sql: string, args: unknown[]) => {
    calls.push({ operation, sql, args, transaction: current });
    events.push(`${current}:${operation}`);
  };
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      const operation = sql.includes('GROUP BY kind')
        ? 'summary'
        : sql.includes('UNION ALL')
          ? 'statuses'
          : sql.includes('FOR UPDATE')
            ? 'run-lock'
            : 'candidates';
      record(operation, sql, args);
      if (operation === 'candidates')
        return options.candidates ?? [{ runId: 'run-one', tenantId: 'tenant-one' }];
      if (operation === 'run-lock') return options.lockFound === false ? [] : [{ id: args[0] }];
      if (operation === 'statuses')
        return (options.statuses ?? ['completed']).map((status) => ({ status }));
      if (options.summaryError) throw options.summaryError;
      return [
        { kind: 'profile_field', state: 'accepted', count: 2 },
        { kind: 'profile_field', state: 'pending', count: '3' },
        { kind: 'facility', state: 'accepted', count: 1 },
      ];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      record('terminal-write', sql, args);
      return 1;
    }),
  };
  const prisma = {
    withSystem: jest.fn(async (fn: (value: typeof tx) => unknown) => {
      if (current) throw new Error('Unexpected nested transaction');
      current = ++next;
      try {
        const result = await fn(tx);
        events.push(`${current}:commit`);
        return result;
      } catch (error) {
        events.push(`${current}:rollback`);
        throw error;
      } finally {
        current = 0;
      }
    }),
  };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const finalize = () => (service as unknown as { finalizeRuns(): Promise<void> }).finalizeRuns();
  return { service, prisma, tx, calls, events, finalize };
}

describe('Completion run finalization — terminal classification matrix', () => {
  test.each([
    { statuses: ['failed', 'skipped'], status: 'partial' },
    { statuses: ['failed', 'cancelled'], status: 'failed' },
    { statuses: ['skipped', 'cancelled'], status: 'completed' },
    { statuses: [], status: 'completed' },
  ])(
    'classifies $statuses as $status and builds the exact finding summary under its run lock',
    async ({ statuses, status }) => {
      const h = harness({ statuses });
      await h.finalize();
      const write = h.calls.find((call) => call.operation === 'terminal-write')!;
      expect(write.args.slice(0, 3)).toEqual(['run-one', 'tenant-one', status]);
      expect(JSON.parse(String(write.args[3]))).toEqual({
        total: 6,
        byKind: { profile_field: 5, facility: 1 },
        byStatus: { accepted: 3, pending: 3 },
      });
      expect(write.sql).toContain(
        "stage = CASE WHEN $3 = 'failed' THEN 'failed' ELSE 'review_ready' END",
      );
      expect(write.sql).toContain(
        "error = CASE WHEN $3 = 'failed' THEN 'All Fill with Meri tasks failed' ELSE NULL END",
      );
      expect(write.sql).toContain("status <> 'cancelled'");
      expect(h.events).toEqual([
        '1:candidates',
        '1:commit',
        '2:run-lock',
        '2:statuses',
        '2:summary',
        '2:terminal-write',
        '2:commit',
      ]);
      expect(h.prisma.withSystem).toHaveBeenCalledTimes(2);
    },
  );
});

describe('Completion run finalization — stale candidate and nonterminal guards', () => {
  test.each(['queued', 'running', 'unknown-status'])(
    'skips a selected candidate whose locked task snapshot contains %s',
    async (pending) => {
      const h = harness({ statuses: ['completed', pending] });
      await h.finalize();
      expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(h.calls.map((call) => call.operation)).toEqual(['candidates', 'run-lock', 'statuses']);
      const recheck = h.calls.at(-1)!;
      expect(recheck.sql).toContain('UNION ALL');
      expect(recheck.sql).toContain('FROM client_profile_fill_task');
      expect(recheck.sql).toContain('FROM client_profile_fill_extension_task');
      expect(recheck.args).toEqual(['run-one', 'tenant-one']);
    },
  );
  test('skips a run removed or cancelled before its lock without summary or status reads', async () => {
    const h = harness({ lockFound: false });
    await h.finalize();
    expect(h.calls.map((call) => call.operation)).toEqual(['candidates', 'run-lock']);
    expect(h.calls[1]!.sql).toContain("status <> 'cancelled' FOR UPDATE");
    expect(h.calls[1]!.args).toEqual(['run-one', 'tenant-one']);
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
  test('does not open a locked finalization transaction when candidate scan is empty', async () => {
    const h = harness({ candidates: [] });
    await h.finalize();
    expect(h.events).toEqual(['1:candidates', '1:commit']);
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('Completion run finalization — per-run scope and summary failure', () => {
  test('keeps each run and tenant lock, status recheck, summary and terminal write in its own transaction', async () => {
    const candidates = [
      { runId: 'run-one', tenantId: 'tenant-one' },
      { runId: 'run-two', tenantId: 'tenant-two' },
    ];
    const h = harness({ candidates });
    await h.finalize();
    expect(h.prisma.withSystem).toHaveBeenCalledTimes(3);
    candidates.forEach((candidate, index) => {
      const scoped = h.calls.filter((call) => call.transaction === index + 2);
      expect(scoped.map((call) => call.operation)).toEqual([
        'run-lock',
        'statuses',
        'summary',
        'terminal-write',
      ]);
      expect(scoped.slice(0, 3).map((call) => call.args)).toEqual(
        Array(3).fill([candidate.runId, candidate.tenantId]),
      );
      expect(scoped[3]!.args.slice(0, 2)).toEqual([candidate.runId, candidate.tenantId]);
    });
    expect(h.events.indexOf('2:commit')).toBeLessThan(h.events.indexOf('3:run-lock'));
  });
  test('propagates a canonical summary read failure and never writes a false terminal result', async () => {
    const h = harness({ summaryError: new Error('summary unavailable') });
    await expect(h.finalize()).rejects.toThrow('summary unavailable');
    expect(h.events.at(-1)).toBe('2:rollback');
    expect(h.tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
