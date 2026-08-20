import { describe, expect, it } from '@jest/globals';
import {
  sealParserRuntimeResult,
  type ParserRuntimeResultV1,
} from '../parser-router/parser-runtime-contract-v1.js';
import {
  phase5ParserRunFromResult,
  Phase5SemanticArtifactError,
} from './non-rdte-semantic-artifact-factory-v1.js';

const SHA = 'a'.repeat(64);

function result(overrides: Partial<Omit<ParserRuntimeResultV1, 'contentSha256'>> = {}) {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'phase5-semantic-result',
    engine: 'deterministic_pdfplumber',
    parserVersion: '1.0.0',
    parserConfigSha256: SHA,
    inputSourceSha256: SHA,
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
    pages: [
      {
        page: 1,
        text: 'P-1 TEST',
        blocks: [],
        tables: [],
        images: [],
        evidencePrecision: 'page_only',
        warnings: [],
      },
    ],
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 1,
      pagesSucceeded: 1,
      pagesFailed: 0,
      engineVersion: '1.0.0',
    },
    ...overrides,
  });
}

describe('Phase 5 semantic parser-result boundary', () => {
  it('accepts a complete single-parser result', () => {
    const parsed = phase5ParserRunFromResult(result());
    expect(parsed.run.pageRanges).toEqual([{ startPage: 1, endPage: 1 }]);
    expect(parsed.run.outputArtifactSha256).toBe(parsed.result.contentSha256);
  });

  it('rejects a partial result instead of silently dropping failed pages', () => {
    const partial = result({
      requestedPages: [1, 2],
      succeededPages: [1],
      failedPages: [{ page: 2, code: 'no_table_detected', message: 'no table' }],
      metrics: {
        durationMillis: 1,
        pagesProcessed: 2,
        pagesSucceeded: 1,
        pagesFailed: 1,
        engineVersion: '1.0.0',
      },
    });

    try {
      phase5ParserRunFromResult(partial);
      throw new Error('expected phase5ParserRunFromResult to reject partial output');
    } catch (error) {
      expect(error).toBeInstanceOf(Phase5SemanticArtifactError);
      expect((error as Phase5SemanticArtifactError).code).toBe('parser_result_partial');
    }
  });

  it('rejects a result whose page payload does not equal succeededPages', () => {
    const inconsistent = result({
      requestedPages: [1, 2],
      succeededPages: [1, 2],
      failedPages: [],
      pages: [
        {
          page: 1,
          text: 'only page one',
          blocks: [],
          tables: [],
          images: [],
          evidencePrecision: 'page_only',
          warnings: [],
        },
      ],
      metrics: {
        durationMillis: 1,
        pagesProcessed: 2,
        pagesSucceeded: 2,
        pagesFailed: 0,
        engineVersion: '1.0.0',
      },
    });

    expect(() => phase5ParserRunFromResult(inconsistent)).toThrow(Phase5SemanticArtifactError);
  });
});
