import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FilesystemParserArtifactStore,
  NoOpParserRunRecorder,
  reuseOrCreate,
  type ParserArtifactStoreV1,
} from './parser-artifact-store.js';
import {
  type ParserRuntimeResultV1,
  type ParserRunIdentityV1,
  sealParserRuntimeResult,
  computeParserRunCacheKey,
  parseParserArtifactDescriptorV1,
  DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
} from './parser-runtime-contract-v1.js';
import { sha256Hex } from '../contracts/canonical-json.js';

function makeMinimalResult(): { result: Omit<ParserRuntimeResultV1, 'contentSha256'>; json: string } {
  const result = {
    schemaVersion: 'defense_budget_parser_result_v1' as const,
    jobId: 'job-test-001',
    engine: 'deterministic_pdfplumber' as const,
    parserVersion: 'pdfplumber-0.11.0',
    parserConfigSha256: 'e3d0f0c1a2b3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9',
    inputSourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    requestedPages: [1, 2],
    succeededPages: [1, 2],
    failedPages: [],
    pages: [],
    warnings: [],
    metrics: {
      durationMillis: 100,
      pagesProcessed: 2,
      pagesSucceeded: 2,
      pagesFailed: 0,
      engineVersion: 'pdfplumber-0.11.0',
    },
  };
  return { result, json: JSON.stringify(result) };
}

const IDENTITY: ParserRunIdentityV1 = {
  sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  method: 'deterministic_pdfplumber',
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'e3d0f0c1a2b3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9',
  pages: [1, 2],
  runtimeContractVersion: DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
};

describe('parser-artifact-store', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'parser-artifact-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('FilesystemParserArtifactStore', () => {
    it('stores and retrieves a valid artifact', async () => {
      const store = new FilesystemParserArtifactStore(tempDir);
      const { result, json } = makeMinimalResult();
      const sealed = sealParserRuntimeResult(result);
      const sealedJson = JSON.stringify(sealed);

      const descriptor = await store.putVerified({
        identity: IDENTITY,
        result: sealed,
        resultJson: sealedJson,
      });

      expect(descriptor.cacheKey).toHaveLength(64);
      expect(descriptor.sourceSha256).toBe(IDENTITY.sourceSha256);
      expect(descriptor.method).toBe('deterministic_pdfplumber');
      expect(descriptor.parserVersion).toBe('pdfplumber-0.11.0');

      // Find it
      const found = await store.findExact(IDENTITY);
      expect(found).not.toBeNull();
      expect(found!.cacheKey).toBe(descriptor.cacheKey);

      // Read and verify
      const readResult = await store.readVerified(found!);
      expect(readResult.jobId).toBe('job-test-001');
      expect(readResult.contentSha256).toBe(sealed.contentSha256);
    });

    it('returns null when artifact does not exist', async () => {
      const store = new FilesystemParserArtifactStore(tempDir);
      const found = await store.findExact(IDENTITY);
      expect(found).toBeNull();
    });

    it('rejects artifact with mutated byte content', async () => {
      const store = new FilesystemParserArtifactStore(tempDir);
      const { result, json } = makeMinimalResult();
      const sealed = sealParserRuntimeResult(result);
      const sealedJson = JSON.stringify(sealed);

      const descriptor = await store.putVerified({
        identity: IDENTITY,
        result: sealed,
        resultJson: sealedJson,
      });

      // Mutate the result file
      const resultPath = descriptor.resultLocator;
      const original = readFileSync(resultPath, 'utf8');
      const mutated = original.replace('job-test-001', 'job-tampered');
      require('node:fs').writeFileSync(resultPath, mutated);

      // Reading should fail
      await expect(store.readVerified(descriptor)).rejects.toThrow();
    });

    it('rejects artifact from different source SHA', async () => {
      const store = new FilesystemParserArtifactStore(tempDir);
      const { result } = makeMinimalResult();
      const sealed = sealParserRuntimeResult(result);
      const sealedJson = JSON.stringify(sealed);

      await store.putVerified({
        identity: IDENTITY,
        result: sealed,
        resultJson: sealedJson,
      });

      // Try to find with a different identity
      const wrongIdentity: ParserRunIdentityV1 = {
        ...IDENTITY,
        sourceSha256: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
      };
      const found = await store.findExact(wrongIdentity);
      expect(found).toBeNull();
    });

    it('config change produces a new cache identity', async () => {
      const store = new FilesystemParserArtifactStore(tempDir);
      const key1 = computeParserRunCacheKey(IDENTITY);
      const key2 = computeParserRunCacheKey({
        ...IDENTITY,
        parserConfigSha256: 'f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5',
      });
      expect(key1).not.toBe(key2);
    });

    it('parser version change produces a new cache identity', async () => {
      const key1 = computeParserRunCacheKey(IDENTITY);
      const key2 = computeParserRunCacheKey({
        ...IDENTITY,
        parserVersion: 'pdfplumber-0.12.0',
      });
      expect(key1).not.toBe(key2);
    });

    it('page set change produces a new cache identity', async () => {
      const key1 = computeParserRunCacheKey(IDENTITY);
      const key2 = computeParserRunCacheKey({
        ...IDENTITY,
        pages: [1, 2, 3],
      });
      expect(key1).not.toBe(key2);
    });
  });

  describe('reuseOrCreate', () => {
    it('reuses existing valid artifact', async () => {
      const store = new FilesystemParserArtifactStore(tempDir);
      let produceCount = 0;

      const { result } = makeMinimalResult();
      const sealed = sealParserRuntimeResult(result);
      const sealedJson = JSON.stringify(sealed);

      // First call produces
      const r1 = await reuseOrCreate(store, IDENTITY, async () => {
        produceCount++;
        return { result: sealed, resultJson: sealedJson };
      });

      expect(r1.reusedArtifact).toBe(false);
      expect(produceCount).toBe(1);

      // Second call reuses
      const r2 = await reuseOrCreate(store, IDENTITY, async () => {
        produceCount++;
        return { result: sealed, resultJson: sealedJson };
      });

      expect(r2.reusedArtifact).toBe(true);
      expect(produceCount).toBe(1); // Not called again
      expect(r2.result.contentSha256).toBe(r1.result.contentSha256);
    });

    it('produces new artifact when none exists', async () => {
      const store = new FilesystemParserArtifactStore(tempDir);
      let produceCount = 0;

      const { result } = makeMinimalResult();
      const sealed = sealParserRuntimeResult(result);
      const sealedJson = JSON.stringify(sealed);

      const r = await reuseOrCreate(store, IDENTITY, async () => {
        produceCount++;
        return { result: sealed, resultJson: sealedJson };
      });

      expect(r.reusedArtifact).toBe(false);
      expect(produceCount).toBe(1);
    });

    it('produces new when cached artifact is corrupted', async () => {
      const store = new FilesystemParserArtifactStore(tempDir);
      let produceCount = 0;

      const { result } = makeMinimalResult();
      const sealed = sealParserRuntimeResult(result);
      const sealedJson = JSON.stringify(sealed);

      // First call: produce and store
      await reuseOrCreate(store, IDENTITY, async () => {
        produceCount++;
        return { result: sealed, resultJson: sealedJson };
      });
      expect(produceCount).toBe(1);

      // Corrupt the stored artifact
      const found = await store.findExact(IDENTITY);
      expect(found).not.toBeNull();
      require('node:fs').writeFileSync(found!.resultLocator, '{"tampered": true}');

      // Second call: should detect corruption and produce new
      const r2 = await reuseOrCreate(store, IDENTITY, async () => {
        produceCount++;
        return { result: sealed, resultJson: sealedJson };
      });

      expect(r2.reusedArtifact).toBe(false);
      expect(produceCount).toBe(2);
    });
  });

  describe('NoOpParserRunRecorder', () => {
    it('records without writing to DB', async () => {
      const recorder = new NoOpParserRunRecorder();
      const result = await recorder.record({
        method: 'deterministic_pdfplumber',
        inputSha256: IDENTITY.sourceSha256,
        outputLocator: '/tmp/result.json',
        outputByteSha256: 'abc',
        outputContentSha256: 'def',
        parserVersion: '0.11.0',
        parserConfigSha256: IDENTITY.parserConfigSha256,
        status: 'completed',
      });
      expect(result.parseJobId).toContain('noop-');
    });
  });
});