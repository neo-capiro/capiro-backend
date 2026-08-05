import {
  S3ParserArtifactStore,
  type ParserArtifactObjectStoreV1,
} from './parser-artifact-store.js';
import {
  sealParserRuntimeResult,
  type ParserRunIdentityV1,
} from './parser-runtime-contract-v1.js';
import { canonicalJsonStringify, type JsonValue } from '../contracts/canonical-json.js';

class MemoryObjectStore implements ParserArtifactObjectStoreV1 {
  private sequence = 0;
  readonly objects = new Map<string, { bytes: Uint8Array; versionId: string }>();

  async getObject(input: { bucket: string; key: string; versionId?: string }) {
    const object = this.objects.get(`${input.bucket}/${input.key}`);
    if (!object) return null;
    if (input.versionId && input.versionId !== object.versionId) return null;
    return object;
  }

  async putObject(input: {
    bucket: string;
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }) {
    void input.contentType;
    const versionId = `version-${++this.sequence}`;
    this.objects.set(`${input.bucket}/${input.key}`, { bytes: input.bytes, versionId });
    return { versionId };
  }
}

const identity: ParserRunIdentityV1 = {
  sourceSha256: 'a'.repeat(64),
  method: 'deterministic_pdfplumber',
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'b'.repeat(64),
  pages: [1, 2],
  runtimeContractVersion: 'defense_budget_parser_job_v1',
};

function result() {
  return sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'job-1',
    engine: identity.method,
    parserVersion: identity.parserVersion,
    parserConfigSha256: identity.parserConfigSha256,
    inputSourceSha256: identity.sourceSha256,
    requestedPages: [1, 2],
    succeededPages: [1, 2],
    failedPages: [],
    pages: [1, 2].map((page) => ({
      page,
      blocks: [],
      tables: [],
      images: [],
      evidencePrecision: 'page_only' as const,
      warnings: [],
    })),
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 2,
      pagesSucceeded: 2,
      pagesFailed: 0,
      engineVersion: identity.parserVersion,
    },
  });
}

describe('S3ParserArtifactStore', () => {
  it('stores and replays the exact VersionId with full SHA verification', async () => {
    const objects = new MemoryObjectStore();
    const store = new S3ParserArtifactStore('bucket', 'derived/parser-runs', objects);
    const parserResult = result();
    const descriptor = await store.putVerified({
      identity,
      result: parserResult,
      resultJson: canonicalJsonStringify(parserResult as unknown as JsonValue),
    });
    expect(descriptor.resultLocator).toContain('versionId=version-1');
    expect(await store.findExact(identity)).toEqual(descriptor);
    expect(await store.readVerified(descriptor)).toEqual(parserResult);
  });

  it('rejects an unversioned result locator when immutable replay is required', async () => {
    const objects = new MemoryObjectStore();
    const store = new S3ParserArtifactStore('bucket', 'prefix', objects);
    const parserResult = result();
    const descriptor = await store.putVerified({
      identity,
      result: parserResult,
      resultJson: canonicalJsonStringify(parserResult as unknown as JsonValue),
    });
    await expect(
      store.readVerified({ ...descriptor, resultLocator: descriptor.resultLocator.split('?')[0]! }),
    ).rejects.toThrow(/VersionId/);
  });

  it('rejects mutated result bytes', async () => {
    const objects = new MemoryObjectStore();
    const store = new S3ParserArtifactStore('bucket', 'prefix', objects);
    const parserResult = result();
    const descriptor = await store.putVerified({
      identity,
      result: parserResult,
      resultJson: canonicalJsonStringify(parserResult as unknown as JsonValue),
    });
    const locator = new URL(descriptor.resultLocator);
    const key = `bucket/${locator.pathname.slice(1)}`;
    const original = objects.objects.get(key)!;
    objects.objects.set(key, {
      ...original,
      bytes: Buffer.from('{"tampered":true}', 'utf8'),
    });
    await expect(store.readVerified(descriptor)).rejects.toThrow();
  });
});
