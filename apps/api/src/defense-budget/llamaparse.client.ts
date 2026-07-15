/**
 * LlamaParse (LlamaCloud) REST client — PDF-mode parsing for DoD budget books.
 *
 * Per Neo's ingestion rule: budget books (R-1/R-2/R-2A/R-3/P-1/P-40/OP-5/committee/
 * conference/public-law) are ALWAYS parsed from the original PDF, never TXT — layout,
 * merged table cells, page numbers, exhibit headers and cross-references must survive.
 *
 * Flow:
 *   1. POST /api/v1/parsing/upload   (multipart: the PDF file + parsing options) -> { id }
 *   2. GET  /api/v1/parsing/job/{id} (poll) -> { status: PENDING|SUCCESS|ERROR|... }
 *   3. GET  /api/v1/parsing/job/{id}/result/markdown  and  /result/json
 *
 * Security: the API key is read from config and sent ONLY as a Bearer header. It is
 * never logged and is redacted from any thrown error. Injected fetch keeps unit tests
 * offline.
 */

export type ParseMode = 'pdf_fast' | 'pdf_premium' | 'pdf_ocr';
export type ResultType = 'markdown' | 'json' | 'both';

export interface LlamaParseConfig {
  apiKey: string;
  baseUrl: string;
  /** Poll interval (ms) while a job is running. */
  pollIntervalMs?: number;
  /** Hard cap on total polling time (ms) before we abort with a timeout error. */
  pollTimeoutMs?: number;
}

export interface LlamaParseJobResult {
  jobId: string;
  status: 'SUCCESS' | 'ERROR' | 'CANCELED';
  markdown?: string;
  json?: unknown;
  creditsUsed?: number;
  raw?: Record<string, unknown>;
}

export interface SubmitOptions {
  /** Raw PDF bytes. */
  file: Buffer;
  filename: string;
  mode: ParseMode;
  resultType: ResultType;
  /** 0-based page indices to restrict parsing to (LlamaParse `target_pages`, comma list). */
  targetPages?: number[];
  /** Extra LlamaParse form fields (e.g. parsing_instruction) — never secrets. */
  extraFields?: Record<string, string>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/** Map our stable ParseMode onto LlamaParse form options. Always PDF input. */
function modeToFormFields(mode: ParseMode): Record<string, string> {
  switch (mode) {
    case 'pdf_premium':
      // Premium mode = best table/layout fidelity for dense R-2A / P-40 exhibits.
      return { premium_mode: 'true' };
    case 'pdf_ocr':
      // Force OCR for scanned / image-only pages (no embedded text layer).
      return { disable_ocr: 'false', skip_diagonal_text: 'false' };
    case 'pdf_fast':
    default:
      // Fast, accurate default for text-layer PDFs; still layout-aware.
      return { fast_mode: 'false' };
  }
}

const TERMINAL = new Set(['SUCCESS', 'ERROR', 'CANCELED', 'PARTIAL_SUCCESS']);

export class LlamaParseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;

  constructor(
    config: LlamaParseConfig,
    private readonly fetchImpl: FetchLike,
    private readonly makeForm: () => MultipartForm = () => new NodeMultipartForm(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => {
        const t = setTimeout(r, ms);
        // Don't let a pending poll delay hold the process/event loop open.
        (t as { unref?: () => void }).unref?.();
      }),
  ) {
    if (!config.apiKey) throw new Error('LlamaParseClient: apiKey is required');
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.pollIntervalMs = config.pollIntervalMs ?? 3000;
    this.pollTimeoutMs = config.pollTimeoutMs ?? 15 * 60 * 1000;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  /** Redact the key from any string so it can never leak into logs/errors. */
  private redact(s: string): string {
    return this.apiKey ? s.split(this.apiKey).join('***REDACTED***') : s;
  }

  /** Submit a PDF for parsing. Returns the LlamaParse job id. */
  async submit(opts: SubmitOptions): Promise<string> {
    const form = this.makeForm();
    form.appendFile('file', opts.file, opts.filename, 'application/pdf');
    form.appendField('result_type', opts.resultType === 'both' ? 'markdown' : opts.resultType);
    for (const [k, v] of Object.entries(modeToFormFields(opts.mode))) form.appendField(k, v);
    if (opts.targetPages && opts.targetPages.length > 0) {
      form.appendField('target_pages', opts.targetPages.join(','));
    }
    for (const [k, v] of Object.entries(opts.extraFields ?? {})) form.appendField(k, v);

    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/parsing/upload`, {
      method: 'POST',
      headers: this.authHeaders(form.headers()),
      body: form.body(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(this.redact(`LlamaParse upload failed: HTTP ${res.status} ${body}`));
    }
    const parsed = (await res.json()) as { id?: string };
    if (!parsed?.id) throw new Error('LlamaParse upload returned no job id');
    return parsed.id;
  }

  /** Poll a job until it reaches a terminal state or the timeout elapses. */
  async waitForJob(jobId: string): Promise<string> {
    const deadline = Date.now() + this.pollTimeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await this.fetchImpl(`${this.baseUrl}/api/v1/parsing/job/${jobId}`, {
        method: 'GET',
        headers: this.authHeaders(),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(this.redact(`LlamaParse job poll failed: HTTP ${res.status} ${body}`));
      }
      const status = ((await res.json()) as { status?: string })?.status ?? 'UNKNOWN';
      if (TERMINAL.has(status)) return status;
      if (Date.now() > deadline) {
        throw new Error(`LlamaParse job ${jobId} timed out after ${this.pollTimeoutMs}ms (last status ${status})`);
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async fetchResult(jobId: string, kind: 'markdown' | 'json'): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1/parsing/job/${jobId}/result/${kind}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(this.redact(`LlamaParse result(${kind}) failed: HTTP ${res.status} ${body}`));
    }
    return kind === 'markdown' ? await res.text() : await res.json();
  }

  /** End-to-end: submit -> poll -> fetch result(s). Always PDF input. */
  async parse(opts: SubmitOptions): Promise<LlamaParseJobResult> {
    const jobId = await this.submit(opts);
    const status = await this.waitForJob(jobId);
    if (status === 'ERROR' || status === 'CANCELED') {
      return { jobId, status: status as 'ERROR' | 'CANCELED' };
    }
    const out: LlamaParseJobResult = { jobId, status: 'SUCCESS' };
    if (opts.resultType === 'markdown' || opts.resultType === 'both') {
      out.markdown = (await this.fetchResult(jobId, 'markdown')) as string;
    }
    if (opts.resultType === 'json' || opts.resultType === 'both') {
      out.json = await this.fetchResult(jobId, 'json');
    }
    return out;
  }
}

/** Minimal multipart abstraction so specs don't depend on a concrete FormData impl. */
export interface MultipartForm {
  appendField(name: string, value: string): void;
  appendFile(name: string, data: Buffer, filename: string, contentType: string): void;
  headers(): Record<string, string>;
  body(): unknown;
}

/** Real implementation backed by the global (Node 18+/undici) FormData/Blob. */
export class NodeMultipartForm implements MultipartForm {
  private readonly form = new FormData();
  appendField(name: string, value: string): void {
    this.form.append(name, value);
  }
  appendFile(name: string, data: Buffer, filename: string, contentType: string): void {
    const bytes = new Uint8Array(data);
    const blob = new Blob([bytes], { type: contentType });
    this.form.append(name, blob, filename);
  }
  headers(): Record<string, string> {
    // fetch sets the multipart boundary Content-Type automatically for a FormData body.
    return {};
  }
  body(): unknown {
    return this.form;
  }
}
