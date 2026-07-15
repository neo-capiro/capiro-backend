import {
  LlamaParseClient,
  type FetchLike,
  type MultipartForm,
  type SubmitOptions,
} from './llamaparse.client.js';

class FakeForm implements MultipartForm {
  fields: Record<string, string> = {};
  files: Array<{ name: string; filename: string; contentType: string; size: number }> = [];
  appendField(name: string, value: string): void {
    this.fields[name] = value;
  }
  appendFile(name: string, data: Buffer, filename: string, contentType: string): void {
    this.files.push({ name, filename, contentType, size: data.byteLength });
  }
  headers(): Record<string, string> {
    return {};
  }
  body(): unknown {
    return { fields: this.fields, files: this.files };
  }
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeFetch(script: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const step = script[i++] ?? {};
    return {
      ok: step.ok ?? true,
      status: step.status ?? 200,
      text: async () => step.text ?? (typeof step.json === 'string' ? (step.json as string) : JSON.stringify(step.json)),
      json: async () => step.json,
    };
  };
  return { fetchImpl, calls };
}

const KEY = 'llx-secret-value-should-never-leak';
const submitOpts = (): SubmitOptions => ({
  file: Buffer.from('%PDF-1.7 test'),
  filename: 'RDTE Vol 1.pdf',
  mode: 'pdf_fast',
  resultType: 'both',
});

describe('LlamaParseClient', () => {
  it('requires an api key', () => {
    const { fetchImpl } = makeFetch([]);
    expect(() => new LlamaParseClient({ apiKey: '', baseUrl: 'https://x' }, fetchImpl)).toThrow(/apiKey/);
  });

  it('submits a PDF as multipart with a Bearer header and returns the job id', async () => {
    const { fetchImpl, calls } = makeFetch([{ json: { id: 'job-123' } }]);
    let form: FakeForm | undefined;
    const client = new LlamaParseClient({ apiKey: KEY, baseUrl: 'https://api.cloud.llamaindex.ai' }, fetchImpl, () => {
      form = new FakeForm();
      return form;
    });
    const id = await client.submit(submitOpts());
    expect(id).toBe('job-123');
    expect(calls[0]!.url).toBe('https://api.cloud.llamaindex.ai/api/v1/parsing/upload');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    // The PDF file is attached as application/pdf.
    expect(form!.files[0]!.contentType).toBe('application/pdf');
    expect(form!.fields.result_type).toBe('markdown');
  });

  it('passes target_pages when a page range is provided', async () => {
    const { fetchImpl } = makeFetch([{ json: { id: 'j' } }]);
    let form: FakeForm | undefined;
    const client = new LlamaParseClient({ apiKey: KEY, baseUrl: 'https://x' }, fetchImpl, () => {
      form = new FakeForm();
      return form;
    });
    await client.submit({ ...submitOpts(), targetPages: [0, 1, 2] });
    expect(form!.fields.target_pages).toBe('0,1,2');
  });

  it('polls until SUCCESS then fetches markdown + json', async () => {
    const { fetchImpl, calls } = makeFetch([
      { json: { id: 'job-9' } }, // submit
      { json: { status: 'PENDING' } }, // poll 1
      { json: { status: 'SUCCESS' } }, // poll 2
      { text: '# R-2 Exhibit\n| PE | FY27 |', json: '# R-2 Exhibit\n| PE | FY27 |' }, // markdown
      { json: { pages: [{ page: 1, md: 'x' }] } }, // json
    ]);
    const client = new LlamaParseClient(
      { apiKey: KEY, baseUrl: 'https://x', pollIntervalMs: 1 },
      fetchImpl,
      () => new FakeForm(),
      async () => {},
    );
    const res = await client.parse(submitOpts());
    expect(res.status).toBe('SUCCESS');
    expect(res.jobId).toBe('job-9');
    expect(res.markdown).toContain('R-2 Exhibit');
    expect(res.json).toEqual({ pages: [{ page: 1, md: 'x' }] });
    // submit + 2 polls + markdown + json = 5 calls.
    expect(calls).toHaveLength(5);
  });

  it('returns ERROR status without fetching results when the job fails', async () => {
    const { fetchImpl, calls } = makeFetch([
      { json: { id: 'job-err' } },
      { json: { status: 'ERROR' } },
    ]);
    const client = new LlamaParseClient(
      { apiKey: KEY, baseUrl: 'https://x', pollIntervalMs: 1 },
      fetchImpl,
      () => new FakeForm(),
      async () => {},
    );
    const res = await client.parse(submitOpts());
    expect(res.status).toBe('ERROR');
    expect(res.markdown).toBeUndefined();
    expect(calls).toHaveLength(2); // no result fetch
  });

  it('NEVER leaks the api key in a thrown error', async () => {
    const { fetchImpl } = makeFetch([{ ok: false, status: 401, text: `bad key ${KEY}` }]);
    const client = new LlamaParseClient({ apiKey: KEY, baseUrl: 'https://x' }, fetchImpl, () => new FakeForm());
    let msg = '';
    try {
      await client.submit(submitOpts());
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('HTTP 401');
    expect(msg).not.toContain(KEY);
    expect(msg).toContain('***REDACTED***');
  });

  it('times out if the job never reaches a terminal state', async () => {
    const { fetchImpl } = makeFetch([
      { json: { id: 'job-slow' } },
      ...Array.from({ length: 20 }, () => ({ json: { status: 'PENDING' } })),
    ]);
    const client = new LlamaParseClient(
      { apiKey: KEY, baseUrl: 'https://x', pollIntervalMs: 1, pollTimeoutMs: 5 },
      fetchImpl,
      () => new FakeForm(),
      async () => {
        await new Promise((r) => setTimeout(r, 3));
      },
    );
    await expect(client.parse(submitOpts())).rejects.toThrow(/timed out/);
  });
});
