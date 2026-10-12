import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';
import { canonicalDocumentNumber, dateOnly, FR_API } from './effective-date-evidence.js';
import { statusFromCounts } from '../ingestion/embed-watermark.js';

const source = readFileSync(resolve(__dirname, '../../scripts/sync-federal-register.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function rule(n: number) {
  const document_number = `2026-${String(n).padStart(5, '0')}`;
  return { document_number, type: 'Rule', title: 'Synthetic public rule', publication_date: '2026-10-12',
    effective_on: '2026-11-12', correction_of: null, corrections: [],
    pdf_url: `https://www.govinfo.gov/content/pkg/FR-2026-10-12/pdf/${document_number}.pdf` };
}
async function execute(options: {
  argv?: string[];
  response: (url: URL, call: number) => any;
  upper?: string | null;
  batches?: Array<Array<{ documentNumber: string }>>;
  observation?: (doc: any) => 'updated' | 'stale';
}) {
  const runs: any[] = []; const observations: any[] = []; const requests: any[] = [];
  const logs: any[] = []; const batches: any[] = []; let batchIndex = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolveDone => { finish = resolveDone; });
  const db = {
    federalRegisterDocument: {
      findFirst: async () => options.upper ? { documentNumber: options.upper } : null,
      findMany: async (args: any) => { batches.push(args); return options.batches?.[batchIndex++] ?? []; },
    },
    $disconnect: async () => { finish(); },
  };
  function PrismaClient() { return db; }
  const modules: Record<string, unknown> = {
    dotenv: { config: () => {} }, '@prisma/client': { PrismaClient },
    '../src/federal-register/effective-date-evidence.js': { canonicalDocumentNumber, dateOnly, FR_API },
    '../src/federal-register/federal-register-observation.js': {
      persistFederalRegisterObservation: async (_prisma: unknown, doc: any, observedAt: Date, metadata: any) => {
        observations.push({ doc, observedAt, metadata });
        return options.observation?.(doc) ?? 'updated';
      },
    },
    '../src/ingestion/sync-run.helper.js': {
      runWithSyncRun: async (_prisma: unknown, name: string, fn: any) => {
        const counts = await fn({ since: null, sinceDate: null });
        runs.push({ source: name, counts, status: statusFromCounts(counts) }); return counts;
      },
    },
  };
  runInNewContext(compiled, {
    exports: {}, require: (name: string) => {
      if (!(name in modules)) throw new Error(`Forbidden unmocked dependency ${name}`);
      return modules[name];
    },
    process: { argv: ['node', 'sync-federal-register.ts', ...(options.argv ?? [])], env: {},
      exit: (code: number) => { logs.push(['exit', code]); finish(); } },
    URL, Date, Set, Error, Promise,
    setTimeout: (fn: () => void) => { fn(); },
    console: Object.fromEntries(['log', 'warn', 'error'].map(method => [method, (...args: unknown[]) => logs.push([method, ...args])])),
    fetch: async (raw: string, init: unknown) => {
      const url = new URL(raw); requests.push({ url: raw, init });
      const body = options.response(url, requests.length);
      return { ok: body !== null, status: body === null ? 503 : 200, statusText: body === null ? 'synthetic failure' : 'OK',
        json: async () => body };
    },
  }, { timeout: 1000 });
  await done;
  return { runs, observations, requests, logs, batches };
}

describe('independent synthetic execution of actual Federal Register sync script', () => {
  it('marks an exhausted unique publication window successful, with deliberately limited coverage', async () => {
    const docs = Array.from({ length: 101 }, (_, i) => rule(i + 1));
    const r = await execute({ response: url => ({ count: 101, results: url.searchParams.get('page') === '1' ? docs.slice(0, 100) : docs.slice(100) }) });
    expect(r.runs[0]).toMatchObject({ source: 'sync-federal-register', status: 'success',
      counts: { updated: 101, errors: 0, complete: true,
        stats: { expectedDocuments: 101, observedDocuments: 101, allFederalRules: false, historicalCorrectionRefresh: false } } });
    expect(r.requests).toHaveLength(2);
    const fields = new URL(r.requests[0].url).searchParams.getAll('fields[]');
    expect(fields).toEqual(expect.arrayContaining(['effective_on', 'correction_of', 'corrections', 'pdf_url']));
    expect(r.observations[0].observedAt).toBeInstanceOf(Date);
  });
  it.each(['duplicate', 'changed_count', 'missing_page'])('prevents %s publication window from advancing success watermark', async mode => {
    const docs = Array.from({ length: 101 }, (_, i) => rule(i + 1));
    const r = await execute({ response: url => {
      if (url.searchParams.get('page') === '1') return { count: 101, results: docs.slice(0, 100) };
      if (mode === 'missing_page') return null;
      return { count: mode === 'changed_count' ? 102 : 101, results: [mode === 'duplicate' ? docs[0] : docs[100]] };
    } });
    expect(r.runs[0].status).toBe('partial'); expect(r.runs[0].counts.complete).toBe(false);
    if (mode === 'duplicate') expect(r.runs[0].counts.errors).toBe(1);
    if (mode === 'missing_page') expect(r.requests).toHaveLength(6);
  });
  it('prevents a row persistence failure from advancing a clean success watermark', async () => {
    const r = await execute({ response: () => ({ count: 1, results: [rule(1)] }),
      observation: () => { throw new Error('synthetic database failure'); } });
    expect(r.runs[0]).toMatchObject({ status: 'success_with_errors', counts: { errors: 1, updated: 0 } });
  });
  it('refreshes exact bounded existing identities without a publication-date watermark', async () => {
    const docs = [rule(1), rule(2)];
    const r = await execute({ argv: ['--refresh-effective-dates'], upper: docs[1].document_number,
      batches: [[{ documentNumber: docs[0].document_number }, { documentNumber: docs[1].document_number }], []],
      response: url => docs.find(doc => url.pathname.endsWith(`/${doc.document_number}.json`)),
      observation: doc => doc.document_number === docs[0].document_number ? 'stale' : 'updated' });
    expect(r.runs[0]).toMatchObject({ source: 'sync-federal-register-effective-dates', status: 'success',
      counts: { updated: 1, skipped: 1, errors: 0, stats: { scope: 'existing_rule_catalog',
        upperDocumentNumber: docs[1].document_number, allFederalRules: false, separatelyIssuedCorrectionsResolved: false } } });
    expect(r.batches[0].where).toEqual({ type: 'RULE', documentNumber: { gt: '', lte: docs[1].document_number } });
    expect(r.batches[1].where.documentNumber.gt).toBe(docs[1].document_number);
    expect(r.requests).toHaveLength(2);
    for (const request of r.requests) {
      expect(request.url).toMatch(/^https:\/\/www\.federalregister\.gov\/api\/v1\/documents\/2026-\d{5}\.json$/);
      expect(request.init).toMatchObject({ redirect: 'error' });
      expect(new URL(request.url).search).toBe('');
    }
  });
  it.each(['foreign_identity', 'invalid_publication', 'failed_response'])('refuses %s detail and preserves a retryable refresh error', async mode => {
    const doc = rule(1);
    const r = await execute({ argv: ['--refresh-effective-dates'], upper: doc.document_number,
      batches: [[{ documentNumber: doc.document_number }], []], response: () => {
        if (mode === 'failed_response') return null;
        return { ...doc, ...(mode === 'foreign_identity' ? { document_number: '2026-99999' } : { publication_date: '2026-02-30' }) };
      } });
    expect(r.observations).toEqual([]);
    expect(r.runs[0]).toMatchObject({ status: 'success_with_errors', counts: { updated: 0, errors: 1 } });
  });
});
