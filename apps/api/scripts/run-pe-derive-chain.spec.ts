/**
 * run-pe-derive-chain — launcher regression for the legacy budget-writer removal.
 *
 * Production observed the nightly PE derive chain fail seven times out of seven
 * at `derive-budget-actions` exit 64. That is the shipped containment policy,
 * not a bug in the writer: `derive-budget-actions --commit` is one of the
 * legacy dispatcher verbs gated behind `PE_LEGACY_BUDGET_WRITES`
 * (legacy-budget-write-gate-v1), the gate is enforced inside the script itself,
 * and the chain spawns it directly — so the chain aborted on its own second
 * step. The chain must not run that step at all.
 *
 * This spec drives the REAL launcher — the committed `run-pe-derive-chain.ts`,
 * compiled by the repository's own TypeScript compiler — rather than asserting
 * against a copy of its STEPS array. A future edit that re-adds the legacy step,
 * reorders the DAG, drops the curated seed artifact argument or stops
 * propagating --commit fails here.
 *
 * The four modules the launcher imports are replaced with fakes, and the fake
 * children never execute anything: no tsx subprocess, no child script, no
 * database connection, no provider or email call. The fake legacy child models
 * the shipped gate exactly — `derive-budget-actions --commit` exits 64.
 *
 * The launcher exports nothing and runs main() only under
 * `require.main === module`, so the compiled source is evaluated in a CommonJS
 * wrapper whose `require.main` is that same module — exactly the condition Node
 * itself satisfies when the script is run as a CLI entry. Its exports stay
 * unchanged.
 */
import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const LAUNCHER = path.join(__dirname, 'run-pe-derive-chain.ts');
const LEGACY_WRITER = 'derive-budget-actions';
const SEED_ARTIFACT = 'scripts/__data__/corrected_json/capabilities_seed.json';

/** The retained executable order, as the arguments the launcher hands to tsx. */
const RETAINED_STEPS = [
  'compute-budget-deltas',
  'derive-relationships',
  'seed-capabilities',
  'derive-intelligence-cache',
  'generate-actions',
  'send-pe-alert-emails',
].map((script) => path.join('scripts', `${script}.ts`));

const LEGACY_STEP = path.join('scripts', `${LEGACY_WRITER}.ts`);

interface SpawnCall {
  bin: string;
  args: string[];
  options: { stdio?: string; shell?: boolean };
}

interface FakeFailure {
  /** Substring of the child script name this rule applies to. */
  script: string;
  code: number;
  /** When set, the rule fires only for a run whose arguments do (not) carry --commit. */
  requiresCommit?: boolean;
}

interface Run {
  spawns: SpawnCall[];
  syncRuns: string[];
  syncRunsCompleted: string[];
  prisma: { constructed: number; connects: number; disconnects: number };
  counts: { updated: number; errors: number } | null;
  log: string;
  stderr: string;
  exitCodes: number[];
}

/** Let the launcher's own async chain run to completion (no timers, no I/O). */
async function settle(done: () => boolean, turns = 500): Promise<void> {
  for (let i = 0; i < turns && !done(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Execute the launcher as its own CLI entry with fakes for its module graph.
 *
 * `failures` models an uncooperative child. The default model is the shipped
 * production gate: `derive-budget-actions --commit` refuses with exit 64.
 */
async function runLauncher(argv: string[], failures: readonly FakeFailure[] = []): Promise<Run> {
  const spawns: SpawnCall[] = [];
  const syncRuns: string[] = [];
  const syncRunsCompleted: string[] = [];
  const prisma = { constructed: 0, connects: 0, disconnects: 0 };
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  let counts: { updated: number; errors: number } | null = null;

  const exitCodeFor = (script: string, args: readonly string[]): number => {
    const forced = failures.find(
      (rule) => script.includes(rule.script)
        && (rule.requiresCommit === undefined || rule.requiresCommit === args.includes('--commit')),
    );
    if (forced) return forced.code;
    return script.includes(LEGACY_WRITER) && args.includes('--commit') ? 64 : 0;
  };

  const childProcessFake = {
    spawn(bin: string, args: string[], options: { stdio?: string; shell?: boolean }) {
      spawns.push({ bin, args: [...args], options: { ...options } });
      const closeHandlers: Array<(code: number) => void> = [];
      const child = {
        on(event: string, handler: (code: number) => void) {
          if (event === 'close') closeHandlers.push(handler);
          return child;
        },
      };
      const code = exitCodeFor(args[0] ?? '', args);
      queueMicrotask(() => {
        for (const handler of closeHandlers) handler(code);
      });
      return child;
    },
  };

  class FakePrismaClient {
    constructor() {
      prisma.constructed += 1;
    }

    async $connect(): Promise<void> {
      prisma.connects += 1;
    }

    async $disconnect(): Promise<void> {
      prisma.disconnects += 1;
    }
  }

  const syncRunHelperFake = {
    emptyCounts: () => ({ updated: 0, errors: 0 }),
    runWithSyncRun: async (
      _client: unknown,
      job: string,
      fn: () => Promise<{ updated: number; errors: number }>,
    ) => {
      syncRuns.push(job);
      try {
        const result = await fn();
        counts = result;
        return result;
      } finally {
        syncRunsCompleted.push(job);
      }
    },
  };

  const requireFake = ((id: string): unknown => {
    if (id === 'node:child_process') return childProcessFake;
    if (id === 'node:path') return path;
    if (id === 'dotenv') return { config: () => undefined };
    if (id === '@prisma/client') return { PrismaClient: FakePrismaClient };
    if (id === '../src/ingestion/sync-run.helper.js') return syncRunHelperFake;
    throw new Error(`run-pe-derive-chain imported an unexpected module: ${id}`);
  }) as ((id: string) => unknown) & { main?: unknown };

  const compiled = ts.transpileModule(readFileSync(LAUNCHER, 'utf8'), {
    fileName: LAUNCHER,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;

  const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
  requireFake.main = moduleShim;

  const realArgv = process.argv;
  const realDatabaseUrl = process.env.DATABASE_URL;
  const realExit = process.exit;
  const logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  const errorSpy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });

  try {
    process.argv = ['node', LAUNCHER, ...argv];
    // The launcher refuses to start without database configuration even for a
    // dry run; nothing here ever connects, so a placeholder is enough.
    process.env.DATABASE_URL = 'postgresql://pe-chain-test.invalid:5432/pe-chain';
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as typeof process.exit;

    const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', compiled);
    wrapper(moduleShim.exports, requireFake, moduleShim, LAUNCHER, path.dirname(LAUNCHER));

    const commit = argv.includes('--commit');
    await settle(
      () => exitCodes.length > 0
        || syncRunsCompleted.length > 0
        || (prisma.disconnects > 0 && commit)
        || logs.some((line) => /dry run complete/i.test(line)),
    );
  } finally {
    process.argv = realArgv;
    if (realDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = realDatabaseUrl;
    process.exit = realExit;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }

  return {
    spawns,
    syncRuns,
    syncRunsCompleted,
    prisma,
    counts,
    log: logs.join('\n'),
    stderr: errors.join('\n'),
    exitCodes,
  };
}

describe('run-pe-derive-chain launcher', () => {
  test('dry run runs exactly the six retained steps in order and never the blocked legacy writer', async () => {
    const run = await runLauncher([]);

    expect(run.spawns.map((call) => call.args[0])).toEqual(RETAINED_STEPS);
    expect(run.spawns.map((call) => call.args[0])).not.toContain(LEGACY_STEP);

    // seed-capabilities keeps its curated artifact; no other step takes one.
    expect(run.spawns[2].args).toEqual([RETAINED_STEPS[2], '--artifact', SEED_ARTIFACT]);
    expect(run.spawns.flatMap((call) => call.args.filter((arg) => arg === '--artifact'))).toEqual([
      '--artifact',
    ]);

    // Every child goes through the same tsx invocation the entrypoint dispatch uses.
    for (const call of run.spawns) {
      expect(call.bin).toBe(path.join('node_modules', '.bin', 'tsx'));
      expect(call.options.stdio).toBe('inherit');
      expect(call.options.shell).toBe(process.platform === 'win32');
    }

    // A dry run forwards no --commit and stays out of SyncRun entirely.
    expect(run.spawns.every((call) => !call.args.includes('--commit'))).toBe(true);
    expect(run.syncRuns).toEqual([]);
    expect(run.prisma).toEqual({ constructed: 0, connects: 0, disconnects: 0 });
    expect(run.log).toMatch(/dry run complete \(no SyncRun row written\)/);
    expect(run.exitCodes).toEqual([]);
  });

  test('--commit reaches every retained child and the run stays wrapped in the pe-derive-chain SyncRun', async () => {
    const run = await runLauncher(['--commit']);

    expect(run.spawns.map((call) => call.args[0])).toEqual(RETAINED_STEPS);
    expect(run.spawns.every((call) => call.args.includes('--commit'))).toBe(true);
    expect(run.spawns[2].args).toEqual([
      RETAINED_STEPS[2],
      '--artifact',
      SEED_ARTIFACT,
      '--commit',
    ]);

    expect(run.prisma).toEqual({ constructed: 1, connects: 1, disconnects: 1 });
    expect(run.syncRuns).toEqual(['pe-derive-chain']);
    expect(run.syncRunsCompleted).toEqual(['pe-derive-chain']);
    expect(run.counts).toEqual({ updated: RETAINED_STEPS.length, errors: 0 });
    expect(run.exitCodes).toEqual([]);
    expect(run.stderr).not.toMatch(/FAILED/);
  });

  test('the legacy writer exiting 64 is no longer reachable, and other failures still abort the chain', async () => {
    // The production symptom, reproduced against the fake gate: nothing in the
    // chain runs `derive-budget-actions --commit`, so exit 64 never fires.
    const healthy = await runLauncher(['--commit']);
    expect(healthy.log).not.toMatch(new RegExp(LEGACY_WRITER));
    expect(healthy.exitCodes).toEqual([]);

    // Abort-on-first-nonzero-child behaviour is still in place for the steps
    // that remain: a failing step stops the chain instead of running on.
    const aborted = await runLauncher(['--commit'], [{ script: 'derive-intelligence-cache', code: 64 }]);
    expect(aborted.spawns.map((call) => call.args[0])).toEqual(RETAINED_STEPS.slice(0, 4));
    expect(aborted.stderr).toMatch(/derive-intelligence-cache FAILED exit=64/);
    expect(aborted.exitCodes).toEqual([1]);
    expect(aborted.syncRuns).toEqual(['pe-derive-chain']);
    // The SyncRun still closes in `finally`, so a failed chain never leaves the
    // ingestion watermark open.
    expect(aborted.prisma.disconnects).toBe(1);
  });
});
