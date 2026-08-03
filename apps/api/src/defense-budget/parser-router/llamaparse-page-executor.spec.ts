/**
 * Tests for Workstream J — Targeted LlamaParse executor.
 *
 * J8 mandatory test cases:
 * - no flag -> no client construction/call
 * - flag without cap -> fail
 * - plan above cap -> fail before call
 * - proven cache -> no call
 * - corrupt cache + no authorization -> fail, no call
 * - target page conversion exact
 * - API key redacted from errors
 *
 * Additional tests:
 * - J2: 1->0, 2->1, noncontiguous ranges
 * - J4: mode selection defaults and override
 * - J5: result normalization
 * - J6: archive and proof
 * - J7: failure behavior (provider error, partial success)
 * - J9: only unresolved authorized pages submitted, no whole-document call
 */
import { describe, it, expect, jest } from '@jest/globals';
import {
  toLlamaTargetPages,
  selectParseMode,
  buildLlamaParseConfig,
  computeLlamaParseConfigSha,
  normalizeLlamaParsePages,
  computeByteSha256,
  buildLlamaParseRunProof,
  validatePaidAuthorization,
  assertPaidPageCap,
  executeLlamaParsePages,
  type PaidAuthorization,
  type LlamaParsePageType,
  type PaidModeConfig,
} from './llamaparse-page-executor.js';
import type { ParserRuntimeResultV1 } from './parser-runtime-contract-v1.js';
import { sealParserRuntimeResult, computeResultContentSha256 } from './parser-runtime-contract-v1.js';
import type { LlamaParseJobResult, FetchLike } from '../llamaparse.client.js';
import { LlamaParseClient } from '../llamaparse.client.js';

// Helper: create a minimal valid ParserRuntimeResultV1
function makeValidResult(
  overrides: Partial<ParserRuntimeResultV1> = {},
): Omit<ParserRuntimeResultV1, 'contentSha256'> {
  return {
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'test-job',
    engine: 'llamaparse',
    parserVersion: 'llamaparse-v1',
    parserConfigSha256: 'a'.repeat(64),
    inputSourceSha256: 'b'.repeat(64),
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
    pages: [],
    warnings: [],
    metrics: {
      durationMillis: 100,
      pagesProcessed: 1,
      pagesSucceeded: 1,
      pagesFailed: 0,
      engineVersion: 'llamaparse-v1',
    },
    ...overrides,
  };
}

// Helper: mock fetch that returns a successful LlamaParse job
function makeMockFetchOk(jobResult: Partial<LlamaParseJobResult> = {}): FetchLike {
  const fullResult: LlamaParseJobResult = {
    jobId: 'lp-job-001',
    status: 'SUCCESS',
    markdown: '## Heading\n\nText content.',
    json: {
      pages: [
        {
          page: 1,
          md: '## Heading\n\nText content.',
          text: 'Text content.',
          items: [],
        },
      ],
    },
    creditsUsed: 5,
    ...jobResult,
  };

  return jest.fn(async (url: string, _init: { method: string }) => {
    if (url.includes('/api/v1/parsing/upload')) {
      return {
        ok: true,
        status: 200,
        text: async () => '{"id":"lp-job-001"}',
        json: async () => ({ id: 'lp-job-001' }),
      };
    }
    if (url.includes('/api/v1/parsing/job/lp-job-001') && url.includes('/result/')) {
      if (url.includes('/result/markdown')) {
        return {
          ok: true,
          status: 200,
          text: async () => fullResult.markdown ?? '',
          json: async () => fullResult.markdown,
        };
      }
      if (url.includes('/result/json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(fullResult.json),
          json: async () => fullResult.json,
        };
      }
    }
    if (url.includes('/api/v1/parsing/job/lp-job-001')) {
      return {
        ok: true,
        status: 200,
        text: async () => '{"status":"SUCCESS"}',
        json: async () => ({ status: 'SUCCESS' }),
      };
    }
    return {
      ok: false,
      status: 404,
      text: async () => 'Not Found',
      json: async () => ({ error: 'not found' }),
    };
  }) as unknown as FetchLike;
}

// Helper: mock fetch that returns a provider error
function makeMockFetchError(): FetchLike {
  return jest.fn(async (url: string, _init: { method: string }) => {
    if (url.includes('/api/v1/parsing/upload')) {
      return {
        ok: true,
        status: 200,
        text: async () => '{"id":"lp-job-001"}',
        json: async () => ({ id: 'lp-job-001' }),
      };
    }
    if (url.includes('/api/v1/parsing/job/lp-job-001')) {
      return {
        ok: true,
        status: 200,
        text: async () => '{"status":"ERROR"}',
        json: async () => ({ status: 'ERROR' }),
      };
    }
    return {
      ok: false,
      status: 500,
      text: async () => 'Internal Error',
      json: async () => ({ error: 'internal' }),
    };
  }) as unknown as FetchLike;
}

describe('llamaparse-page-executor', () => {
  /* ─── J2: toLlamaTargetPages ─── */
  describe('J2: toLlamaTargetPages', () => {
    it('converts page 1 -> 0', () => {
      expect(toLlamaTargetPages([1])).toEqual([0]);
    });

    it('converts page 2 -> 1', () => {
      expect(toLlamaTargetPages([2])).toEqual([1]);
    });

    it('converts noncontiguous ranges', () => {
      expect(toLlamaTargetPages([1, 3, 5, 7])).toEqual([0, 2, 4, 6]);
    });

    it('converts contiguous ranges', () => {
      expect(toLlamaTargetPages([1, 2, 3, 4, 5])).toEqual([0, 1, 2, 3, 4]);
    });

    it('rejects empty array', () => {
      expect(() => toLlamaTargetPages([])).toThrow('non-empty');
    });

    it('rejects non-positive pages', () => {
      expect(() => toLlamaTargetPages([0])).toThrow('positive integer');
      expect(() => toLlamaTargetPages([-1])).toThrow('positive integer');
    });

    it('rejects unsorted pages', () => {
      expect(() => toLlamaTargetPages([3, 1, 2])).toThrow('sorted ascending');
    });

    it('rejects duplicate pages', () => {
      expect(() => toLlamaTargetPages([1, 1, 2])).toThrow('duplicate');
    });

    it('rejects non-integer pages', () => {
      expect(() => toLlamaTargetPages([1.5])).toThrow('positive integer');
    });
  });

  /* ─── J4: mode selection ─── */
  describe('J4: selectParseMode', () => {
    it('defaults complex_digital to pdf_premium', () => {
      expect(selectParseMode('complex_digital')).toBe('pdf_premium');
    });

    it('defaults image_ocr to pdf_ocr', () => {
      expect(selectParseMode('image_ocr')).toBe('pdf_ocr');
    });

    it('defaults fast to pdf_fast', () => {
      expect(selectParseMode('fast')).toBe('pdf_fast');
    });

    it('uses operator override', () => {
      const config: PaidModeConfig = { operatorOverride: 'pdf_fast' };
      expect(selectParseMode('complex_digital', config)).toBe('pdf_fast');
    });

    it('uses custom page type map', () => {
      const config: PaidModeConfig = {
        pageTypeMap: { complex_digital: 'pdf_ocr' },
      };
      expect(selectParseMode('complex_digital', config)).toBe('pdf_ocr');
    });

    it('operator override takes precedence over page type map', () => {
      const config: PaidModeConfig = {
        operatorOverride: 'pdf_fast',
        pageTypeMap: { complex_digital: 'pdf_ocr' },
      };
      expect(selectParseMode('complex_digital', config)).toBe('pdf_fast');
    });
  });

  /* ─── J4: config hash ─── */
  describe('J4: config hash', () => {
    it('produces deterministic config SHA', () => {
      const sha1 = computeLlamaParseConfigSha('pdf_premium', [0, 1], 'complex_digital');
      const sha2 = computeLlamaParseConfigSha('pdf_premium', [0, 1], 'complex_digital');
      expect(sha1).toBe(sha2);
      expect(sha1).toHaveLength(64);
    });

    it('different mode produces different SHA', () => {
      const sha1 = computeLlamaParseConfigSha('pdf_premium', [0, 1], 'complex_digital');
      const sha2 = computeLlamaParseConfigSha('pdf_ocr', [0, 1], 'complex_digital');
      expect(sha1).not.toBe(sha2);
    });

    it('different pages produce different SHA', () => {
      const sha1 = computeLlamaParseConfigSha('pdf_premium', [0, 1], 'complex_digital');
      const sha2 = computeLlamaParseConfigSha('pdf_premium', [0, 1, 2], 'complex_digital');
      expect(sha1).not.toBe(sha2);
    });
  });

  /* ─── J5: result normalization ─── */
  describe('J5: normalizeLlamaParsePages', () => {
    it('normalizes pages with text and tables', () => {
      const pages = normalizeLlamaParsePages(
        [
          {
            pdfPage: 1,
            markdown: '## Budget Title\n\n| Col A | Col B |\n|---|---|\n| 1 | 2 |',
            tables: [
              {
                header: ['Col A', 'Col B'],
                rows: [['1', '2']],
              },
            ],
          },
        ],
        [1],
      );

      expect(pages).toHaveLength(1);
      expect(pages[0]!.page).toBe(1);
      expect(pages[0]!.text).toContain('Budget Title');
      expect(pages[0]!.tables).toHaveLength(1);
      expect(pages[0]!.tables[0]!.rowCount).toBe(2);
      expect(pages[0]!.tables[0]!.columnCount).toBe(2);
      expect(pages[0]!.tables[0]!.cells).toHaveLength(4);
    });

    it('evidence precision is page_only when no cell geometry', () => {
      const pages = normalizeLlamaParsePages(
        [{ pdfPage: 1, markdown: 'Text', tables: [] }],
        [1],
      );
      expect(pages[0]!.evidencePrecision).toBe('page_only');
    });

    it('evidence precision is page_only even with tables (no cell bbox)', () => {
      const pages = normalizeLlamaParsePages(
        [
          {
            pdfPage: 1,
            markdown: 'Text',
            tables: [{ header: ['A'], rows: [['1']] }],
          },
        ],
        [1],
      );
      expect(pages[0]!.evidencePrecision).toBe('page_only');
    });

    it('filters out pages not in requestedPages', () => {
      const pages = normalizeLlamaParsePages(
        [
          { pdfPage: 1, markdown: 'Page 1', tables: [] },
          { pdfPage: 2, markdown: 'Page 2', tables: [] },
          { pdfPage: 3, markdown: 'Page 3', tables: [] },
        ],
        [2],
      );
      expect(pages).toHaveLength(1);
      expect(pages[0]!.page).toBe(2);
    });
  });

  /* ─── J6: archive and proof ─── */
  describe('J6: buildLlamaParseRunProof', () => {
    it('records provider job ID, source SHA, pages, mode', () => {
      const result = sealParserRuntimeResult(makeValidResult());
      const proof = buildLlamaParseRunProof(
        'lp-job-001',
        'abc123',
        [1, 2, 3],
        'pdf_premium',
        'markdown content',
        { pages: [] },
        result,
      );
      expect(proof.providerJobId).toBe('lp-job-001');
      expect(proof.inputSourceSha256).toBe('abc123');
      expect(proof.selectedPages).toEqual([1, 2, 3]);
      expect(proof.mode).toBe('pdf_premium');
    });

    it('computes output byte SHA', () => {
      const result = sealParserRuntimeResult(makeValidResult());
      const proof = buildLlamaParseRunProof(
        'lp-job-001',
        'abc123',
        [1],
        'pdf_premium',
        'markdown',
        { pages: [] },
        result,
      );
      expect(proof.outputByteSha256).toHaveLength(64);
    });

    it('records credits when provider returns them', () => {
      const result = sealParserRuntimeResult(makeValidResult());
      const proof = buildLlamaParseRunProof(
        'lp-job-001',
        'abc123',
        [1],
        'pdf_premium',
        'markdown',
        { pages: [] },
        result,
        undefined,
        undefined,
        5,
      );
      expect(proof.creditsUsed).toBe(5);
    });

    it('records S3 locator and version', () => {
      const result = sealParserRuntimeResult(makeValidResult());
      const proof = buildLlamaParseRunProof(
        'lp-job-001',
        'abc123',
        [1],
        'pdf_premium',
        'markdown',
        { pages: [] },
        result,
        's3://bucket/key',
        'v1',
      );
      expect(proof.s3Locator).toBe('s3://bucket/key');
      expect(proof.s3Version).toBe('v1');
    });
  });

  /* ─── J8: paid authorization ─── */
  describe('J8: validatePaidAuthorization', () => {
    it('passes when not allowing paid parse', () => {
      expect(() =>
        validatePaidAuthorization({ allowPaidParse: false, maxPaidPages: 0 }),
      ).not.toThrow();
    });

    it('passes when allowing paid parse with positive cap', () => {
      expect(() =>
        validatePaidAuthorization({ allowPaidParse: true, maxPaidPages: 5 }),
      ).not.toThrow();
    });

    it('fails when flag set but no cap', () => {
      expect(() =>
        validatePaidAuthorization({ allowPaidParse: true, maxPaidPages: 0 }),
      ).toThrow('--allow-paid-parse requires --max-paid-pages');
    });

    it('fails when flag set but negative cap', () => {
      expect(() =>
        validatePaidAuthorization({ allowPaidParse: true, maxPaidPages: -1 }),
      ).toThrow('--allow-paid-parse requires --max-paid-pages');
    });
  });

  describe('J8: assertPaidPageCap', () => {
    it('passes when no paid pages and not authorized', () => {
      expect(() =>
        assertPaidPageCap([], { allowPaidParse: false, maxPaidPages: 0 }),
      ).not.toThrow();
    });

    it('fails when paid pages but not authorized', () => {
      expect(() =>
        assertPaidPageCap([1, 2], { allowPaidParse: false, maxPaidPages: 0 }),
      ).toThrow('not authorized');
    });

    it('passes when within cap', () => {
      expect(() =>
        assertPaidPageCap([1, 2, 3], { allowPaidParse: true, maxPaidPages: 5 }),
      ).not.toThrow();
    });

    it('fails when plan exceeds cap', () => {
      expect(() =>
        assertPaidPageCap([1, 2, 3, 4, 5, 6], { allowPaidParse: true, maxPaidPages: 5 }),
      ).toThrow('exceed cap');
    });
  });

  /* ─── J8: executeLlamaParsePages — no flag ─── */
  describe('J8: no flag -> no client construction/call', () => {
    it('throws when not authorized and no cache', async () => {
      await expect(
        executeLlamaParsePages({
          jobId: 'test',
          sourceSha256: 'a'.repeat(64),
          sourcePdfBuffer: Buffer.from('pdf'),
          sourceFilename: 'test.pdf',
          requestedPages: [1],
          pageType: 'complex_digital',
          authorization: { allowPaidParse: false, maxPaidPages: 0 },
        }),
      ).rejects.toThrow('not authorized');
    });
  });

  /* ─── J8: flag without cap ─── */
  it('flag without cap -> fail', async () => {
    await expect(
      executeLlamaParsePages({
        jobId: 'test',
        sourceSha256: 'a'.repeat(64),
        sourcePdfBuffer: Buffer.from('pdf'),
        sourceFilename: 'test.pdf',
        requestedPages: [1],
        pageType: 'complex_digital',
        authorization: { allowPaidParse: true, maxPaidPages: 0 },
      }),
    ).rejects.toThrow('--allow-paid-parse requires --max-paid-pages');
  });

  /* ─── J8: plan above cap -> fail before call ─── */
  it('plan above cap -> fail before call', async () => {
    let clientConstructed = false;
    await expect(
      executeLlamaParsePages({
        jobId: 'test',
        sourceSha256: 'a'.repeat(64),
        sourcePdfBuffer: Buffer.from('pdf'),
        sourceFilename: 'test.pdf',
        requestedPages: [1, 2, 3, 4, 5, 6],
        pageType: 'complex_digital',
        authorization: { allowPaidParse: true, maxPaidPages: 5 },
        clientConfig: {
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
        },
        fetchImpl: (() => {
          clientConstructed = true;
          return Promise.resolve() as any;
        }) as unknown as FetchLike,
      }),
    ).rejects.toThrow('exceed cap');
    // Client should not have been constructed (fetch never called)
    expect(clientConstructed).toBe(false);
  });

  /* ─── J8: proven cache -> no call ─── */
  it('proven cache -> no call', async () => {
    const cachedResult = sealParserRuntimeResult(
      makeValidResult({
        requestedPages: [1],
        succeededPages: [1],
      }),
    );

    // Even with authorization, proven cache should be returned without calling
    const { result, proof } = await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 5 },
      cachedResult,
    });

    expect(result).toBe(cachedResult);
    expect(proof).toBeNull();
  });

  /* ─── J8: proven cache without authorization -> no call ─── */
  it('proven cache with no authorization -> no call (reuse)', async () => {
    const cachedResult = sealParserRuntimeResult(
      makeValidResult({
        requestedPages: [1],
        succeededPages: [1],
      }),
    );

    const { result, proof } = await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: false, maxPaidPages: 0 },
      cachedResult,
    });

    expect(result).toBe(cachedResult);
    expect(proof).toBeNull();
  });

  /* ─── J8: corrupt cache + no authorization -> fail, no call ─── */
  it('corrupt cache + no authorization -> fail, no call', async () => {
    const cachedResult = sealParserRuntimeResult(
      makeValidResult({
        requestedPages: [1],
        succeededPages: [1],
      }),
    );
    // Corrupt the content SHA
    const corruptResult = { ...cachedResult, contentSha256: '0'.repeat(64) } as ParserRuntimeResultV1;

    await expect(
      executeLlamaParsePages({
        jobId: 'test',
        sourceSha256: 'b'.repeat(64),
        sourcePdfBuffer: Buffer.from('pdf'),
        sourceFilename: 'test.pdf',
        requestedPages: [1],
        pageType: 'complex_digital',
        authorization: { allowPaidParse: false, maxPaidPages: 0 },
        cachedResult: corruptResult,
      }),
    ).rejects.toThrow('corrupt');
  });

  /* ─── J8: corrupt cache + authorization -> proceed to paid call ─── */
  it('corrupt cache + authorization -> proceed to paid call', async () => {
    const cachedResult = sealParserRuntimeResult(
      makeValidResult({
        requestedPages: [1],
        succeededPages: [1],
      }),
    );
    const corruptResult = { ...cachedResult, contentSha256: '0'.repeat(64) } as ParserRuntimeResultV1;

    const mockFetch = makeMockFetchOk();
    const { result, proof } = await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 5 },
      cachedResult: corruptResult,
      clientConfig: {
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
        pollIntervalMs: 10,
        pollTimeoutMs: 5000,
      },
      fetchImpl: mockFetch,
    });

    // Should have made a new paid call
    expect(result.schemaVersion).toBe('defense_budget_parser_result_v1');
    expect(proof).not.toBeNull();
    expect(proof!.providerJobId).toBe('lp-job-001');
  });

  /* ─── J8: target page conversion exact ─── */
  it('target page conversion exact in execute', async () => {
    let capturedTargetPages: number[] | undefined;
    const mockClient = {
      parse: jest.fn(async (opts: { targetPages?: number[] }) => {
        capturedTargetPages = opts.targetPages;
        return {
          jobId: 'lp-job-001',
          status: 'SUCCESS' as const,
          markdown: '## Test',
          json: { pages: [{ page: 1, md: '## Test', items: [] }] },
          creditsUsed: 2,
        };
      }),
    } as unknown as LlamaParseClient;

    await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1, 3, 5],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 10 },
      client: mockClient,
    });

    expect(capturedTargetPages).toEqual([0, 2, 4]);
  });

  /* ─── J8: API key redacted from errors ─── */
  it('API key redacted from errors', async () => {
    const apiKey = 'secret-key-12345';
    const mockFetch = jest.fn(async (url: string, init: { method: string; headers: Record<string, string> }) => {
      if (url.includes('/api/v1/parsing/upload')) {
        // Return an error that includes the API key in the body
        return {
          ok: false,
          status: 401,
          text: async () => `Unauthorized: ${apiKey} is invalid`,
          json: async () => ({ error: 'unauthorized' }),
        };
      }
      return {
        ok: false,
        status: 500,
        text: async () => 'Error',
        json: async () => ({}),
      };
    }) as unknown as FetchLike;

    // The error is caught and turned into page failures (J7), not thrown
    const { result } = await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 5 },
      clientConfig: {
        apiKey,
        baseUrl: 'https://example.com',
      },
      fetchImpl: mockFetch,
    });

    // All pages should have failed
    expect(result.failedPages).toHaveLength(1);
    // The API key must be redacted from the error message
    expect(result.failedPages[0]!.message).not.toContain(apiKey);
    expect(result.failedPages[0]!.message).toContain('REDACTED');
    // Warnings should also have the redacted message
    expect(result.warnings[0]!.message).not.toContain(apiKey);
  });

  /* ─── J7: failure behavior — provider error ─── */
  describe('J7: failure behavior', () => {
    it('provider error -> explicit page failures', async () => {
      const { result, proof } = await executeLlamaParsePages({
        jobId: 'test',
        sourceSha256: 'b'.repeat(64),
        sourcePdfBuffer: Buffer.from('pdf'),
        sourceFilename: 'test.pdf',
        requestedPages: [1, 2, 3],
        pageType: 'complex_digital',
        authorization: { allowPaidParse: true, maxPaidPages: 10 },
        clientConfig: {
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
        },
        fetchImpl: makeMockFetchError(),
      });

      expect(result.failedPages).toHaveLength(3);
      expect(result.succeededPages).toHaveLength(0);
      expect(result.pages).toHaveLength(0);
      expect(result.metrics.pagesFailed).toBe(3);
      expect(result.metrics.pagesSucceeded).toBe(0);
      expect(proof).toBeNull();
    });
  });

  /* ─── J7: partial success ─── */
  it('partial success -> preserve successful pages and fail missing pages', async () => {
    const mockFetch = makeMockFetchOk({
      markdown: '---\nPage 1 content\n---\nPage 3 content',
      json: {
        pages: [
          { page: 1, md: 'Page 1 content', items: [] },
          { page: 3, md: 'Page 3 content', items: [] },
        ],
      },
    });

    const { result, proof } = await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1, 2, 3],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 10 },
      clientConfig: {
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
        pollIntervalMs: 10,
        pollTimeoutMs: 5000,
      },
      fetchImpl: mockFetch,
    });

    // Pages 1 and 3 succeeded, page 2 failed
    expect(result.succeededPages).toContain(1);
    expect(result.succeededPages).toContain(3);
    expect(result.failedPages).toHaveLength(1);
    expect(result.failedPages[0]!.page).toBe(2);
    expect(result.warnings.some((w) => w.code === 'partial_success')).toBe(true);
    expect(proof).not.toBeNull();
  });

  /* ─── J7: no automatic retry ─── */
  it('no automatic retry on failure', async () => {
    let callCount = 0;
    const mockFetch = jest.fn(async (url: string) => {
      if (url.includes('/api/v1/parsing/upload')) {
        callCount++;
        return {
          ok: true,
          status: 200,
          text: async () => '{"id":"lp-job-001"}',
          json: async () => ({ id: 'lp-job-001' }),
        };
      }
      if (url.includes('/api/v1/parsing/job/lp-job-001') && !url.includes('/result/')) {
        return {
          ok: true,
          status: 200,
          text: async () => '{"status":"ERROR"}',
          json: async () => ({ status: 'ERROR' }),
        };
      }
      return {
        ok: false,
        status: 500,
        text: async () => 'Error',
        json: async () => ({}),
      };
    }) as unknown as FetchLike;

    const { result } = await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 5 },
      clientConfig: {
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
        pollIntervalMs: 10,
        pollTimeoutMs: 5000,
      },
      fetchImpl: mockFetch,
    });

    // Upload should be called exactly once (no retry)
    expect(callCount).toBe(1);
    expect(result.failedPages).toHaveLength(1);
  });

  /* ─── J9: only unresolved authorized pages submitted ─── */
  it('only requested pages are submitted via targetPages', async () => {
    let capturedTargetPages: number[] | undefined;
    const mockClient = {
      parse: jest.fn(async (opts: { targetPages?: number[] }) => {
        capturedTargetPages = opts.targetPages;
        return {
          jobId: 'lp-job-001',
          status: 'SUCCESS' as const,
          markdown: '## Test',
          json: {
            pages: [
              { page: 7, md: 'Page 7', items: [] },
              { page: 8, md: 'Page 8', items: [] },
            ],
          },
          creditsUsed: 2,
        };
      }),
    } as unknown as LlamaParseClient;

    await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [7, 8],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 10 },
      client: mockClient,
    });

    // Only pages 7 and 8 should be submitted (converted to 0-based: 6, 7)
    expect(capturedTargetPages).toEqual([6, 7]);
  });

  /* ─── J9: no whole-document paid call ─── */
  it('no whole-document paid call in default path (no targetPages = all pages)', async () => {
    let capturedOpts: { targetPages?: number[] } | undefined;
    const mockClient = {
      parse: jest.fn(async (opts: { targetPages?: number[] }) => {
        capturedOpts = opts;
        return {
          jobId: 'lp-job-001',
          status: 'SUCCESS' as const,
          markdown: '## Test',
          json: { pages: [{ page: 1, md: 'Test', items: [] }] },
          creditsUsed: 1,
        };
      }),
    } as unknown as LlamaParseClient;

    await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 5 },
      client: mockClient,
    });

    // targetPages must be explicitly set (not undefined = whole document)
    expect(capturedOpts!.targetPages).toBeDefined();
    expect(capturedOpts!.targetPages).toEqual([0]);
  });

  /* ─── J6: output is stored and replayable ─── */
  it('output is stored and replayable (content SHA valid)', async () => {
    const mockFetch = makeMockFetchOk();
    const { result } = await executeLlamaParsePages({
      jobId: 'test',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 5 },
      clientConfig: {
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
        pollIntervalMs: 10,
        pollTimeoutMs: 5000,
      },
      fetchImpl: mockFetch,
    });

    // Content SHA must be valid
    const { contentSha256: _, ...rest } = result;
    const recomputed = computeResultContentSha256(rest);
    expect(recomputed).toBe(result.contentSha256);
  });

  /* ─── J6: artifact store called ─── */
  it('artifact store receives raw output', async () => {
    let writtenData: Buffer | undefined;
    let writtenJobId: string | undefined;
    const mockFetch = makeMockFetchOk();
    const { proof } = await executeLlamaParsePages({
      jobId: 'test-job-001',
      sourceSha256: 'b'.repeat(64),
      sourcePdfBuffer: Buffer.from('pdf'),
      sourceFilename: 'test.pdf',
      requestedPages: [1],
      pageType: 'complex_digital',
      authorization: { allowPaidParse: true, maxPaidPages: 5 },
      clientConfig: {
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
        pollIntervalMs: 10,
        pollTimeoutMs: 5000,
      },
      fetchImpl: mockFetch,
      artifactStore: {
        writeRaw: async (jobId: string, data: Buffer) => {
          writtenJobId = jobId;
          writtenData = data;
          return `s3://bucket/${jobId}/raw.json`;
        },
      },
    });

    expect(writtenJobId).toBe('test-job-001');
    expect(writtenData).toBeDefined();
    expect(proof!.s3Locator).toBe('s3://bucket/test-job-001/raw.json');
  });

  /* ─── computeByteSha256 ─── */
  describe('computeByteSha256', () => {
    it('produces 64-char hex SHA-256', () => {
      const sha = computeByteSha256('test data');
      expect(sha).toHaveLength(64);
      expect(sha).toMatch(/^[0-9a-f]+$/);
    });

    it('is deterministic', () => {
      expect(computeByteSha256('test')).toBe(computeByteSha256('test'));
    });

    it('differs for different input', () => {
      expect(computeByteSha256('test1')).not.toBe(computeByteSha256('test2'));
    });

    it('accepts Buffer input', () => {
      const sha = computeByteSha256(Buffer.from('test', 'utf8'));
      expect(sha).toBe(computeByteSha256('test'));
    });
  });
});
