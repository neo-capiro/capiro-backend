import { ParseRunner, type ParseJobClient, type ParseJobRow, type RunParseInput } from './parse-runner.js';
import type { LlamaParseClient, LlamaParseJobResult } from './llamaparse.client.js';
import type { RawArchiveService } from './raw-archive.service.js';

function makeJobClient() {
  const rows: ParseJobRow[] = [];
  const client: ParseJobClient = {
    documentParseJob: {
      async findFirst({ where }) {
        return (
          rows.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null
        );
      },
      async create({ data }) {
        const row = { id: `pj-${rows.length + 1}`, ...data } as ParseJobRow;
        rows.push(row);
        return row;
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { client, rows };
}

function makeArchive() {
  const derived: Array<{ filename: string; key: string }> = [];
  const svc = {
    async archiveDerived(_d: unknown, _sha: string, filename: string) {
      const key = `derived/public/dod-budget/.../${filename}`;
      derived.push({ filename, key });
      return { bucket: 'b', key, versionId: 'dv1' };
    },
  } as unknown as RawArchiveService;
  return { svc, derived };
}

function makeLlama(result: LlamaParseJobResult, calls: { n: number }): LlamaParseClient {
  return {
    async parse() {
      calls.n += 1;
      return result;
    },
  } as unknown as LlamaParseClient;
}

const input = (): RunParseInput => ({
  sourceDocumentId: 'sd-1',
  file: Buffer.from('%PDF-1.7'),
  filename: 'af_rdte_v1.pdf',
  inputSha256: 'a'.repeat(64),
  archiveDescriptor: {
    documentId: 'sd-1',
    fiscalYear: 2027,
    sourceAuthority: 'dod-comptroller',
    family: 'rdte',
    localPath: '/tmp/af_rdte_v1.pdf',
  },
  mode: 'pdf_fast',
  resultType: 'both',
});

describe('ParseRunner', () => {
  it('parses the PDF, archives derived outputs, and records a succeeded DocumentParseJob', async () => {
    const calls = { n: 0 };
    const llama = makeLlama(
      { jobId: 'job-1', status: 'SUCCESS', markdown: '# R-2', json: { pages: [] }, creditsUsed: 12 },
      calls,
    );
    const { svc, derived } = makeArchive();
    const { client, rows } = makeJobClient();
    const runner = new ParseRunner(llama, svc, client, () => new Date('2026-07-14T00:00:00Z'));

    const res = await runner.run(input());

    expect(res.reused).toBe(false);
    expect(res.parseJob.status).toBe('succeeded');
    expect(res.parseJob.providerJobId).toBe('job-1');
    expect(res.parseJob.creditsUsed).toBe(12);
    expect(res.markdownS3Key).toMatch(/\.md$/);
    expect(res.jsonS3Key).toMatch(/\.json$/);
    expect(derived).toHaveLength(2);
    expect(rows).toHaveLength(1);
  });

  it('is idempotent: a succeeded job for the same input is reused without re-calling LlamaParse', async () => {
    const calls = { n: 0 };
    const llama = makeLlama({ jobId: 'job-1', status: 'SUCCESS', markdown: '# R-2', json: {} }, calls);
    const { svc } = makeArchive();
    const { client, rows } = makeJobClient();
    const runner = new ParseRunner(llama, svc, client, () => new Date());

    await runner.run(input());
    const second = await runner.run(input());

    expect(calls.n).toBe(1); // LlamaParse called only once
    expect(second.reused).toBe(true);
    expect(rows).toHaveLength(1); // no duplicate job row
  });

  it('records a failed job when LlamaParse returns ERROR (no derived outputs)', async () => {
    const calls = { n: 0 };
    const llama = makeLlama({ jobId: 'job-err', status: 'ERROR' }, calls);
    const { svc, derived } = makeArchive();
    const { client } = makeJobClient();
    const runner = new ParseRunner(llama, svc, client, () => new Date());

    const res = await runner.run(input());
    expect(res.parseJob.status).toBe('failed');
    expect(res.parseJob.error).toMatch(/ERROR/);
    expect(derived).toHaveLength(0);
  });

  it('marks the job failed and rethrows when the parse call throws', async () => {
    const llama = {
      async parse() {
        throw new Error('network down');
      },
    } as unknown as LlamaParseClient;
    const { svc } = makeArchive();
    const { client, rows } = makeJobClient();
    const runner = new ParseRunner(llama, svc, client, () => new Date());
    await expect(runner.run(input())).rejects.toThrow(/network down/);
    expect(rows[0]!.status).toBe('failed');
  });
});
