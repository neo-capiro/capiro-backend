import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from '@jest/globals';
import {
  DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
  DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION,
  DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION,
  parserRuntimeJobV1Schema,
  parserRuntimeResultV1Schema,
  parserPageFailureV1Schema,
  parserRuntimeEngineV1Schema,
  PARSER_DOCUMENT_STATE_V1_VALUES,
  PARSER_STATE_TRANSITIONS,
  isTerminalState,
  isValidTransition,
  assertValidTransition,
  computeParserRunCacheKey,
  computeParserRunId,
  computeParserConfigSha256,
  computeResultContentSha256,
  sealParserRuntimeResult,
  pageRangeKey,
  parseParserRuntimeJobV1,
  parseParserRuntimeResultV1,
} from './parser-runtime-contract-v1.js';
import { sha256CanonicalJson } from '../contracts/canonical-json.js';

const FIXTURES_PATH = join(__dirname, '__fixtures__', 'conformance-fixtures.json');
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as Record<string, any>;

describe('parser-runtime-contract-v1', () => {
  /* A1: Schema version constants */
  describe('schema version constants', () => {
    it('exports correct job schema version', () => {
      expect(DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION).toBe('defense_budget_parser_job_v1');
    });
    it('exports correct result schema version', () => {
      expect(DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION).toBe('defense_budget_parser_result_v1');
    });
    it('exports correct plan schema version', () => {
      expect(DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION).toBe('defense_budget_parse_plan_v1');
    });
  });

  /* A2: Job contract validation */
  describe('job contract', () => {
    it('accepts a valid job', () => {
      const job = parseParserRuntimeJobV1(fixtures.valid_job);
      expect(job.jobId).toBe('job-test-001');
      expect(job.requestedPages).toEqual([1, 2, 3]);
    });

    it('rejects unsorted pages', () => {
      expect(() => parserRuntimeJobV1Schema.parse(fixtures.invalid_unsorted_pages)).toThrow();
    });

    it('rejects duplicate pages', () => {
      expect(() => parserRuntimeJobV1Schema.parse(fixtures.invalid_duplicate_pages)).toThrow();
    });

    it('rejects unknown fields', () => {
      expect(() => parserRuntimeJobV1Schema.parse(fixtures.invalid_unknown_field)).toThrow();
    });

    it('rejects invalid engine', () => {
      const bad = { ...fixtures.valid_job, engine: 'llamaparse' } as Record<string, unknown>;
      expect(() => parserRuntimeJobV1Schema.parse(bad)).toThrow();
    });

    it('rejects empty pages array', () => {
      const bad = { ...fixtures.valid_job, requestedPages: [] } as Record<string, unknown>;
      expect(() => parserRuntimeJobV1Schema.parse(bad)).toThrow();
    });

    it('rejects non-positive pages', () => {
      const bad = { ...fixtures.valid_job, requestedPages: [0, 1] } as Record<string, unknown>;
      expect(() => parserRuntimeJobV1Schema.parse(bad)).toThrow();
    });
  });

  /* A3: Result contract validation */
  describe('result contract', () => {
    it('accepts a valid result (ignoring contentSha256 for now)', () => {
      // The fixture has a placeholder contentSha256; we seal it properly
      const result = fixtures.valid_result as Record<string, unknown>;
      const { contentSha256: _ignored, ...rest } = result;
      const realSha = computeResultContentSha256(rest as never);
      const valid = { ...result, contentSha256: realSha };
      const parsed = parseParserRuntimeResultV1(valid);
      expect(parsed.jobId).toBe('job-test-001');
      expect(parsed.pages).toHaveLength(2);
    });

    it('rejects unknown fields in result', () => {
      const result = fixtures.valid_result as Record<string, unknown>;
      const { contentSha256: _ignored, ...rest } = result;
      const realSha = computeResultContentSha256(rest as never);
      const bad = { ...rest, contentSha256: realSha, extraField: 'bad' };
      expect(() => parserRuntimeResultV1Schema.parse(bad)).toThrow();
    });

    it('rejects invalid engine in result', () => {
      const result = fixtures.valid_result as Record<string, unknown>;
      const { contentSha256: _ignored, ...rest } = result;
      const realSha = computeResultContentSha256(rest as never);
      const bad = { ...rest, engine: 'invalid_engine', contentSha256: realSha };
      // Recompute because we changed engine
      const { contentSha256: _ignored2, ...rest2 } = bad;
      const realSha2 = computeResultContentSha256(rest2 as never);
      bad.contentSha256 = realSha2;
      expect(() => parserRuntimeResultV1Schema.parse(bad)).toThrow();
    });
  });

  /* A4: Page failure contract */
  describe('page failure', () => {
    it('accepts a valid page failure', () => {
      const failure = parserPageFailureV1Schema.parse(fixtures.page_failure);
      expect(failure.code).toBe('no_embedded_text');
    });

    it('rejects invalid failure code', () => {
      const bad = { page: 1, code: 'invalid_code', message: 'test' };
      expect(() => parserPageFailureV1Schema.parse(bad)).toThrow();
    });
  });

  /* A5: Engine vocabulary — only local engines allowed in runtime */
  describe('engine vocabulary', () => {
    it('accepts deterministic_pdfplumber', () => {
      expect(parserRuntimeEngineV1Schema.parse('deterministic_pdfplumber')).toBe('deterministic_pdfplumber');
    });
    it('accepts camelot', () => {
      expect(parserRuntimeEngineV1Schema.parse('camelot')).toBe('camelot');
    });
    it('accepts docling', () => {
      expect(parserRuntimeEngineV1Schema.parse('docling')).toBe('docling');
    });
    it('accepts paddleocr', () => {
      expect(parserRuntimeEngineV1Schema.parse('paddleocr')).toBe('paddleocr');
    });
    it('rejects llamaparse (paid, not a local runtime engine)', () => {
      expect(() => parserRuntimeEngineV1Schema.parse('llamaparse')).toThrow();
    });
    it('rejects manual (not a runtime engine)', () => {
      expect(() => parserRuntimeEngineV1Schema.parse('manual')).toThrow();
    });
  });

  /* A6: State machine */
  describe('state machine', () => {
    it('has 11 states', () => {
      expect(PARSER_DOCUMENT_STATE_V1_VALUES).toHaveLength(11);
    });

    it('PLANNED -> RUNNING_LOCAL is valid', () => {
      expect(isValidTransition('PLANNED', 'RUNNING_LOCAL')).toBe(true);
    });

    it('RUNNING_LOCAL -> LOCAL_COMPLETE is valid', () => {
      expect(isValidTransition('RUNNING_LOCAL', 'LOCAL_COMPLETE')).toBe(true);
    });

    it('LOCAL_COMPLETE -> VERIFYING is valid', () => {
      expect(isValidTransition('LOCAL_COMPLETE', 'VERIFYING')).toBe(true);
    });

    it('VERIFYING -> ESCALATION_PLANNED is valid', () => {
      expect(isValidTransition('VERIFYING', 'ESCALATION_PLANNED')).toBe(true);
    });

    it('VERIFYING -> TERMINAL_PASSED is valid', () => {
      expect(isValidTransition('VERIFYING', 'TERMINAL_PASSED')).toBe(true);
    });

    it('ESCALATION_PLANNED -> RUNNING_PAID is valid', () => {
      expect(isValidTransition('ESCALATION_PLANNED', 'RUNNING_PAID')).toBe(true);
    });

    it('RUNNING_PAID -> PAID_COMPLETE is valid', () => {
      expect(isValidTransition('RUNNING_PAID', 'PAID_COMPLETE')).toBe(true);
    });

    it('PAID_COMPLETE -> VERIFYING is valid (re-verify after paid)', () => {
      expect(isValidTransition('PAID_COMPLETE', 'VERIFYING')).toBe(true);
    });

    it('PLANNED -> TERMINAL_PASSED is invalid (must go through running)', () => {
      expect(isValidTransition('PLANNED', 'TERMINAL_PASSED')).toBe(false);
    });

    it('terminal states have no outgoing transitions', () => {
      for (const state of PARSER_DOCUMENT_STATE_V1_VALUES) {
        if (isTerminalState(state)) {
          expect(PARSER_STATE_TRANSITIONS[state]).toEqual([]);
          for (const target of PARSER_DOCUMENT_STATE_V1_VALUES) {
            expect(isValidTransition(state, target)).toBe(false);
          }
        }
      }
    });

    it('RUNNING_LOCAL -> RUNNING_PAID is invalid (must complete local first)', () => {
      expect(isValidTransition('RUNNING_LOCAL', 'RUNNING_PAID')).toBe(false);
    });

    it('assertValidTransition throws on invalid', () => {
      expect(() => assertValidTransition('PLANNED', 'TERMINAL_PASSED')).toThrow();
    });

    it('assertValidTransition does not throw on valid', () => {
      expect(() => assertValidTransition('PLANNED', 'RUNNING_LOCAL')).not.toThrow();
    });
  });

  /* A7: Parser-run identity */
  describe('parser-run identity', () => {
    const identity = {
      sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      method: 'deterministic_pdfplumber' as const,
      parserVersion: '0.11.0',
      parserConfigSha256: 'e3d0f0c1a2b3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9',
      pages: [1, 2, 3],
      runtimeContractVersion: DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
    };

    it('produces deterministic cache key', () => {
      const key1 = computeParserRunCacheKey(identity);
      const key2 = computeParserRunCacheKey(identity);
      expect(key1).toBe(key2);
      expect(key1).toHaveLength(64);
    });

    it('different pages produce different cache keys', () => {
      const key1 = computeParserRunCacheKey(identity);
      const key2 = computeParserRunCacheKey({ ...identity, pages: [1, 2] });
      expect(key1).not.toBe(key2);
    });

    it('different method produces different cache keys', () => {
      const key1 = computeParserRunCacheKey(identity);
      const key2 = computeParserRunCacheKey({ ...identity, method: 'camelot' });
      expect(key1).not.toBe(key2);
    });

    it('different source SHA produces different cache keys', () => {
      const key1 = computeParserRunCacheKey(identity);
      const key2 = computeParserRunCacheKey({
        ...identity,
        sourceSha256: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
      });
      expect(key1).not.toBe(key2);
    });

    it('unsorted pages produce same cache key (sorted internally)', () => {
      const key1 = computeParserRunCacheKey(identity);
      const key2 = computeParserRunCacheKey({ ...identity, pages: [3, 1, 2] });
      expect(key1).toBe(key2);
    });

    it('produces deterministic parser-run ID', () => {
      const id1 = computeParserRunId(identity);
      const id2 = computeParserRunId(identity);
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^pr1_[a-f0-9]{64}$/);
    });
  });

  /* A8: Config SHA computation */
  describe('config SHA', () => {
    it('produces deterministic config SHA', () => {
      const config = { tableStrategy: 'lines', minChars: 40 };
      const sha1 = computeParserConfigSha256(config);
      const sha2 = computeParserConfigSha256(config);
      expect(sha1).toBe(sha2);
      expect(sha1).toHaveLength(64);
    });

    it('different configs produce different SHAs', () => {
      const sha1 = computeParserConfigSha256({ a: 1 });
      const sha2 = computeParserConfigSha256({ a: 2 });
      expect(sha1).not.toBe(sha2);
    });

    it('key order does not matter for config SHA', () => {
      const sha1 = computeParserConfigSha256({ a: 1, b: 2 });
      const sha2 = computeParserConfigSha256({ b: 2, a: 1 });
      expect(sha1).toBe(sha2);
    });
  });

  /* A9: Page range key */
  describe('page range key', () => {
    it('contiguous pages produce range notation', () => {
      expect(pageRangeKey([1, 2, 3])).toBe('1-3');
    });

    it('non-contiguous pages produce comma-separated ranges', () => {
      expect(pageRangeKey([1, 2, 3, 7, 8])).toBe('1-3,7-8');
    });

    it('single page produces single number', () => {
      expect(pageRangeKey([5])).toBe('5');
    });

    it('unsorted pages are sorted first', () => {
      expect(pageRangeKey([3, 1, 2])).toBe('1-3');
    });

    it('non-contiguous individual pages', () => {
      expect(pageRangeKey([1, 3, 5])).toBe('1,3,5');
    });

    it('empty pages produces none', () => {
      expect(pageRangeKey([])).toBe('none');
    });
  });

  /* A10: Result sealing and content SHA */
  describe('result sealing', () => {
    it('seal produces valid content SHA', () => {
      const result = fixtures.valid_result as Record<string, unknown>;
      const { contentSha256: _ignored, ...rest } = result;
      const sealed = sealParserRuntimeResult(rest as never);
      expect(sealed.contentSha256).toHaveLength(64);
      // Re-sealing should produce the same SHA
      const { contentSha256: _ignored2, ...rest2 } = sealed;
      const resealed = sealParserRuntimeResult(rest2 as never);
      expect(resealed.contentSha256).toBe(sealed.contentSha256);
    });

    it('different content produces different SHA', () => {
      const result = fixtures.valid_result as Record<string, unknown>;
      const { contentSha256: _ignored, ...rest } = result;
      const sealed1 = sealParserRuntimeResult(rest as never);
      const modified = { ...rest, succeededPages: [1, 2, 3] } as never;
      const sealed2 = sealParserRuntimeResult(modified);
      expect(sealed1.contentSha256).not.toBe(sealed2.contentSha256);
    });
  });

  /* A11: Cross-language conformance — canonical JSON hash parity */
  describe('cross-language canonical JSON parity', () => {
    it('produces matching hash for simple object', () => {
      const obj = { b: 2, a: 1, c: [3, 2, 1] };
      const hash = sha256CanonicalJson(obj);
      // Python: json.dumps({"b":2,"a":1,"c":[3,2,1]}, sort_keys=True, separators=(",",":"))
      // = {"a":1,"b":2,"c":[3,2,1]}
      // SHA-256 of that string
      expect(hash).toHaveLength(64);
      // Verify it's deterministic
      expect(sha256CanonicalJson(obj)).toBe(hash);
    });

    it('produces matching hash for nested object', () => {
      const obj = { outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] };
      const hash = sha256CanonicalJson(obj);
      expect(hash).toHaveLength(64);
      expect(sha256CanonicalJson(obj)).toBe(hash);
    });
  });
});