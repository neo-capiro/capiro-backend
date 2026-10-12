import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { canonicalDocumentNumber, dateOnly, FR_API } from './effective-date-evidence.js';
import { statusFromCounts } from '../ingestion/embed-watermark.js';

const selectedSource = process.env.FR_CHECKPOINT_REVIEW_SOURCE ?? resolve(__dirname, '../../scripts/sync-federal-register.ts');
const compiled = ts.transpileModule(readFileSync(selectedSource, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const NOW = new Date('2026-10-12T07:00:00.000Z');
function rule(n = 1, publication_date = '2026-10-12') {
  const document_number = `2026-${String(n).padStart(5, '0')}`;
  return { document_number, type: 'Rule', title: 'Synthetic public rule', publication_date,
    effective_on: '2026-11-12', correction_of: null, corrections: [],
    pdf_url: `https://www.govinfo.gov/content/pkg/FR-${publication_date}/pdf/${document_number}.pdf` };
}
function receipt(patch: Record<string, any> = {}) {
  return { source: 'sync-federal-register', status: 'success', startedAt: new Date('2026-10-01T23:00:00.000Z'),
    stats: { schemaVersion: 1, scope: 'publication_window', incrementalCheckpointEligible: true }, ...patch };
}
async function execute(options: {
  argv?: string[]; env?: Record<string, string>; receipts?: Array<ReturnType<typeof receipt>>;
  catalogMaximum?: Date; response?: (url: URL, call: number) => any;
  observation?: (doc: any) => 'updated' | 'stale'; checkpointError?: boolean;
} = {}) {
  const runs: any[] = []; const requests: Array<{ url: string }> = []; const observations: any[] = [];
  const queries: any[] = []; const catalogQueries: any[] = []; const logs: any[] = [];
  let finish!: () => void;
  const done = new Promise<void>(resolveDone => { finish = resolveDone; });
  const db = {
    syncRun: { findFirst: async (args: any) => {
      queries.push(args);
      if (options.checkpointError) throw new Error('synthetic checkpoint read failure');
      const matching = (options.receipts ?? []).filter(row => {
        if (row.source !== args.where.source || row.status !== args.where.status) return false;
        return (args.where.AND ?? []).every((predicate: any) => {
          const key: string = predicate.stats.path[0];
          return (row.stats as Record<string, unknown> | undefined)?.[key] === predicate.stats.equals;
        });
      }).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return matching[0] ? { startedAt: matching[0].startedAt } : null;
    } },
    federalRegisterDocument: {
      findFirst: async (args: any) => {
        catalogQueries.push(args);
        return options.catalogMaximum ? { publicationDate: options.catalogMaximum } : null;
      },
      findMany: async () => [],
    },
    $disconnect: async () => { finish(); },
  };
  function PrismaClient() { return db; }
  const modules: Record<string, unknown> = {
    dotenv: { config: () => {} }, '@prisma/client': { PrismaClient },
    '../src/federal-register/effective-date-evidence.js': { canonicalDocumentNumber, dateOnly, FR_API },
    '../src/federal-register/federal-register-observation.js': {
      persistFederalRegisterObservation: async (_prisma: unknown, doc: any) => {
        observations.push(doc); return options.observation?.(doc) ?? 'updated';
      },
    },
    '../src/ingestion/sync-run.helper.js': {
      runWithSyncRun: async (_prisma: unknown, name: string, fn: any, runOptions: unknown) => {
        try {
          const counts = await fn({ since: null, sinceDate: null });
          runs.push({ source: name, counts, status: statusFromCounts(counts), options: runOptions });
          return counts;
        } catch (error) {
          runs.push({ source: name, status: 'error', error }); throw error;
        }
      },
    },
  };
  class ClockDate extends Date {
    constructor(value?: string | number | Date) { super(value ?? NOW.getTime()); }
    static now() { return NOW.getTime(); }
  }
  runInNewContext(compiled, {
    exports: {}, require: (name: string) => {
      if (!(name in modules)) throw new Error(`Forbidden unmocked dependency ${name}`);
      return modules[name];
    },
    process: { argv: ['node', 'sync-federal-register.ts', ...(options.argv ?? [])], env: options.env ?? {},
      exit: (code: number) => { logs.push(['exit', code]); finish(); } },
    URL, Date: ClockDate, Set, Error, Promise, setTimeout: (fn: () => void) => { fn(); },
    console: Object.fromEntries(['log', 'warn', 'error'].map(method => [method, (...args: unknown[]) => logs.push([method, ...args])])),
    fetch: async (raw: string) => {
      const url = new URL(raw); requests.push({ url: raw });
      const body = options.response ? options.response(url, requests.length) : { count: 1, results: [rule()] };
      return { ok: body !== null, status: body === null ? 503 : 200, statusText: 'synthetic', json: async () => body };
    },
  }, { timeout: 1000 });
  await done;
  // main().catch runs after its finally disconnect; observe the terminal catch too.
  await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
  return { runs, requests, observations, queries, catalogQueries, logs };
}
function floor(r: Awaited<ReturnType<typeof execute>>) {
  expect(r.requests.length).toBeGreaterThan(0);
  return new URL(r.requests[0]!.url).searchParams.get('conditions[publication_date][gte]');
}

describe('independent actual-script automatic-checkpoint regressions', () => {
  it('does not let a partial catalog max skip the unseen older publication tail', async () => {
    const unseen = rule(1, '2021-01-07');
    const r = await execute({ argv: ['--incremental'], catalogMaximum: new Date('2026-10-12'),
      receipts: [receipt({ status: 'partial', startedAt: NOW })],
      response: url => url.searchParams.get('conditions[publication_date][gte]')! <= unseen.publication_date
        ? { count: 1, results: [unseen] } : { count: 0, results: [] } });
    expect(floor(r)).toBe('2021-01-01');
    expect(r.observations.map(doc => doc.document_number)).toEqual([unseen.document_number]);
    expect(r.catalogQueries).toEqual([]);
  });
  it('does not trust legacy successful receipts or their newer local catalog max', async () => {
    const r = await execute({ argv: ['--incremental'], catalogMaximum: new Date('2026-10-12'),
      receipts: [receipt({ stats: {}, startedAt: NOW })] });
    expect(floor(r)).toBe('2021-01-01'); expect(r.catalogQueries).toEqual([]);
  });
  it('asks the canonical receipt owner for only successful protocol-qualified ordinary windows', async () => {
    const r = await execute({ argv: ['--incremental'] });
    expect(r.queries).toEqual([{ where: { source: 'sync-federal-register', status: 'success', AND: [
      { stats: { path: ['schemaVersion'], equals: 1 } },
      { stats: { path: ['scope'], equals: 'publication_window' } },
      { stats: { path: ['incrementalCheckpointEligible'], equals: true } },
    ] }, orderBy: { startedAt: 'desc' }, select: { startedAt: true } }]);
    expect(floor(r)).toBe('2021-01-01');
  });
  it.each([
    ['partial', { status: 'partial' }], ['error', { status: 'error' }], ['row_errors', { status: 'success_with_errors' }],
    ['legacy', { stats: {} }], ['old_protocol', { stats: { schemaVersion: 0, scope: 'publication_window', incrementalCheckpointEligible: true } }],
    ['string_protocol', { stats: { schemaVersion: '1', scope: 'publication_window', incrementalCheckpointEligible: true } }],
    ['missing_eligibility', { stats: { schemaVersion: 1, scope: 'publication_window' } }],
    ['string_eligibility', { stats: { schemaVersion: 1, scope: 'publication_window', incrementalCheckpointEligible: 'true' } }],
    ['manual_override', { stats: { schemaVersion: 1, scope: 'publication_window', incrementalCheckpointEligible: false } }],
    ['refresh_scope', { stats: { schemaVersion: 1, scope: 'existing_rule_catalog', incrementalCheckpointEligible: true } }],
    ['other_source', { source: 'sync-federal-register-effective-dates' }],
  ] as const)('ignores newer %s receipt and falls back without catalog-derived authority', async (_kind, patch) => {
    const r = await execute({ argv: ['--incremental'], receipts: [receipt({ ...patch, startedAt: NOW })] });
    expect(floor(r)).toBe('2021-01-01');
  });
  it('uses the newest qualified complete receipt despite later partial/manual/legacy attempts', async () => {
    const accepted = receipt({ startedAt: new Date('2026-10-02T23:45:00.000Z') });
    const r = await execute({ env: { FR_SYNC_INCREMENTAL: '1' }, receipts: [receipt(), accepted,
      receipt({ status: 'partial', startedAt: NOW }), receipt({ stats: {}, startedAt: NOW }),
      receipt({ stats: { schemaVersion: 1, scope: 'publication_window', incrementalCheckpointEligible: false }, startedAt: NOW })] });
    expect(floor(r)).toBe('2026-10-02');
    expect(r.runs[0].options).toMatchObject({ overrideSince: '2026-10-02' });
  });
  it.each([{ argv: [] as string[] }, { argv: ['--incremental'] }])('marks exhausted ordinary window %p eligible', async ({ argv }) => {
    const r = await execute({ argv, receipts: [receipt()] });
    expect(r.runs[0]).toMatchObject({ status: 'success', counts: { complete: true, errors: 0,
      stats: { schemaVersion: 1, scope: 'publication_window', incrementalCheckpointEligible: true } } });
    if (!argv.length) expect(r.queries).toEqual([]);
  });
  it.each(['cli', 'environment'])('explicit %s since override wins and can never become an automatic checkpoint', async mode => {
    const r = await execute({ argv: mode === 'cli' ? ['--incremental', '--since', '2026-10-10'] : ['--incremental'],
      env: mode === 'environment' ? { FR_SYNC_SINCE: '2026-10-10' } : {}, receipts: [receipt()] });
    expect(floor(r)).toBe('2026-10-10'); expect(r.queries).toEqual([]);
    expect(r.runs[0]).toMatchObject({ status: 'success', counts: { complete: true,
      stats: { publicationFrom: '2026-10-10', incrementalCheckpointEligible: false } } });
  });
  it.each(['row_failure', 'duplicate', 'missing_identity', 'count_drift'])('cannot mark %s source window checkpoint-eligible', async mode => {
    const docs = Array.from({ length: 101 }, (_, i) => rule(i + 1));
    const r = await execute({ response: url => {
      if (mode === 'duplicate') return { count: 1, results: [rule(), rule()] };
      if (mode === 'missing_identity') return { count: 1, results: [] };
      if (mode === 'row_failure') return { count: 1, results: [rule()] };
      return { count: url.searchParams.get('page') === '1' ? 101 : 102,
        results: url.searchParams.get('page') === '1' ? docs.slice(0, 100) : docs.slice(100) };
    }, observation: () => { if (mode === 'row_failure') throw new Error('synthetic persistence failure'); return 'updated'; } });
    expect(r.runs[0].status).not.toBe('success');
    expect(r.runs[0].counts.stats.incrementalCheckpointEligible).toBe(false);
  });
  it('keeps checkpoint eligibility false when an older page fails after a newer page was persisted', async () => {
    const r = await execute({ response: url => url.searchParams.get('page') === '1'
      ? { count: 101, results: Array.from({ length: 100 }, (_, i) => rule(i + 1)) } : null });
    expect(r.observations).toHaveLength(100);
    expect(r.runs[0]).toMatchObject({ status: 'partial', counts: { complete: false,
      stats: { observedDocuments: 100, expectedDocuments: 101, incrementalCheckpointEligible: false } } });
  });
  it('refuses checkpoint read failure before fetching or opening a publication run', async () => {
    const r = await execute({ argv: ['--incremental'], checkpointError: true });
    expect(r.requests).toEqual([]); expect(r.runs).toEqual([]); expect(r.logs).toContainEqual(['exit', 1]);
  });
  it('never acknowledges an eligible window when the first page fails', async () => {
    const r = await execute({ response: () => null });
    expect(r.runs[0]).toMatchObject({ status: 'error' });
    expect(r.runs[0].counts).toBeUndefined(); expect(r.logs).toContainEqual(['exit', 1]);
  });
  it('rejects invalid explicit date before provider requests or receipt queries', async () => {
    const r = await execute({ argv: ['--incremental', '--since', '2026-02-30'] });
    expect(r.requests).toEqual([]); expect(r.queries).toEqual([]); expect(r.logs).toContainEqual(['exit', 1]);
  });
});
