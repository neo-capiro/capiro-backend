/**
 * Parse runner — orchestrates a LlamaParse (PDF) parse over a registered SourceDocument
 * and writes the immutable DocumentParseJob audit record + derived S3 outputs.
 *
 * Satisfies the "record of the PDF AND the parse job" requirement: the PDF record is the
 * SourceDocument (with archive columns); the parse-job record is DocumentParseJob.
 *
 * Idempotent: keyed on (sourceDocumentId, inputSha256, provider, pageStart, pageEnd). A
 * rerun with the same input returns the existing succeeded job without re-calling
 * LlamaParse or re-billing credits.
 */
import type { LlamaParseClient, ParseMode, ResultType } from './llamaparse.client.js';
import type { RawArchiveService, ArchiveDescriptor } from './raw-archive.service.js';

export interface ParseJobRow {
  id: string;
  sourceDocumentId: string;
  provider: string;
  inputSha256: string;
  pageStart: number | null;
  pageEnd: number | null;
  status: string;
  [key: string]: unknown;
}

export interface ParseJobDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<ParseJobRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<ParseJobRow>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<ParseJobRow>;
}

export interface ParseJobClient {
  documentParseJob: ParseJobDelegate;
}

export interface RunParseInput {
  sourceDocumentId: string;
  /** The archived original: bytes + sha + descriptor for derived-key layout. */
  file: Buffer;
  filename: string;
  inputSha256: string;
  archiveDescriptor: ArchiveDescriptor;
  mode: ParseMode;
  resultType: ResultType;
  pageStart?: number | null;
  pageEnd?: number | null;
  /** 0-based page indices passed to LlamaParse (target_pages). */
  targetPages?: number[];
}

export interface RunParseResult {
  parseJob: ParseJobRow;
  reused: boolean;
  markdownS3Key?: string;
  jsonS3Key?: string;
  markdown?: string;
  json?: unknown;
}

export class ParseRunner {
  constructor(
    private readonly llama: LlamaParseClient,
    private readonly archiveSvc: RawArchiveService,
    private readonly client: ParseJobClient,
    private readonly clock: () => Date = () => new Date(),
    private readonly provider = 'llamaparse',
  ) {}

  async run(input: RunParseInput): Promise<RunParseResult> {
    const pageStart = input.pageStart ?? null;
    const pageEnd = input.pageEnd ?? null;

    // 1. Idempotency: a succeeded job for this exact input is reused, no LlamaParse call.
    const existing = await this.client.documentParseJob.findFirst({
      where: {
        sourceDocumentId: input.sourceDocumentId,
        inputSha256: input.inputSha256,
        provider: this.provider,
        pageStart,
        pageEnd,
      },
    });
    if (existing && existing.status === 'succeeded') {
      return {
        parseJob: existing,
        reused: true,
        markdownS3Key: existing.outputMarkdownS3Key as string | undefined,
        jsonS3Key: existing.outputJsonS3Key as string | undefined,
      };
    }

    // 2. Open (or reopen) a running job record.
    const job =
      existing ??
      (await this.client.documentParseJob.create({
        data: {
          sourceDocumentId: input.sourceDocumentId,
          provider: this.provider,
          mode: input.mode,
          resultType: input.resultType,
          pageStart,
          pageEnd,
          inputSha256: input.inputSha256,
          status: 'running',
          startedAt: this.clock(),
        },
      }));
    if (existing) {
      await this.client.documentParseJob.update({
        where: { id: job.id },
        data: { status: 'running', error: null, startedAt: this.clock() },
      });
    }

    // 3. Parse the PDF (never TXT).
    try {
      const result = await this.llama.parse({
        file: input.file,
        filename: input.filename,
        mode: input.mode,
        resultType: input.resultType,
        targetPages: input.targetPages,
      });

      if (result.status !== 'SUCCESS') {
        const failed = await this.client.documentParseJob.update({
          where: { id: job.id },
          data: {
            status: 'failed',
            providerJobId: result.jobId,
            error: `LlamaParse returned ${result.status}`,
            completedAt: this.clock(),
          },
        });
        return { parseJob: failed, reused: false };
      }

      // 4. Archive derived outputs to the derived/ prefix (same bucket + KMS).
      let markdownS3Key: string | undefined;
      let jsonS3Key: string | undefined;
      if (result.markdown != null) {
        const md = await this.archiveSvc.archiveDerived(
          input.archiveDescriptor,
          input.inputSha256,
          pageRangeName('parsed', pageStart, pageEnd, 'md'),
          result.markdown,
          'text/markdown',
        );
        markdownS3Key = md.key;
      }
      if (result.json != null) {
        const js = await this.archiveSvc.archiveDerived(
          input.archiveDescriptor,
          input.inputSha256,
          pageRangeName('parsed', pageStart, pageEnd, 'json'),
          JSON.stringify(result.json),
          'application/json',
        );
        jsonS3Key = js.key;
      }

      // 5. Finalize the immutable parse-job record.
      const done = await this.client.documentParseJob.update({
        where: { id: job.id },
        data: {
          status: 'succeeded',
          providerJobId: result.jobId,
          outputMarkdownS3Key: markdownS3Key ?? null,
          outputJsonS3Key: jsonS3Key ?? null,
          creditsUsed: result.creditsUsed ?? null,
          completedAt: this.clock(),
        },
      });

      return {
        parseJob: done,
        reused: false,
        markdownS3Key,
        jsonS3Key,
        markdown: result.markdown,
        json: result.json,
      };
    } catch (err) {
      await this.client.documentParseJob.update({
        where: { id: job.id },
        data: { status: 'failed', error: String((err as Error).message).slice(0, 4000), completedAt: this.clock() },
      });
      throw err;
    }
  }
}

function pageRangeName(prefix: string, start: number | null, end: number | null, ext: string): string {
  const range = start == null && end == null ? 'all' : `${start ?? 0}-${end ?? 'end'}`;
  return `${prefix}.pages-${range}.${ext}`;
}
