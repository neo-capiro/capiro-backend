/** Restart proof: fake only at the S3 SDK/object-store boundary. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ParserArtifactObjectStoreV1 } from './parser-artifact-store.js';
import { FilesystemExtractionArtifactStore, S3ExtractionArtifactStore } from './extraction-artifact-store.js';
import { ingestionOutboxDispositionForBridgeResultV1 } from '../ingestion-outbox-drain-v1.js';

class FakeS3 implements ParserArtifactObjectStoreV1 {
  objects = new Map<string, { bytes: Uint8Array; versionId: string }>();
  puts = 0;
  key(bucket: string, key: string) { return `${bucket}/${key}`; }
  async headObject(input: { bucket: string; key: string }) { const v = this.objects.get(this.key(input.bucket, input.key)); return v ? { versionId: v.versionId } : null; }
  async getObject(input: { bucket: string; key: string; versionId?: string }) { return this.objects.get(this.key(input.bucket, input.key)) ?? null; }
  async putObject(input: { bucket: string; key: string; bytes: Uint8Array; contentType: string; ifNoneMatch?: '*' }) {
    const key = this.key(input.bucket, input.key);
    if (input.ifNoneMatch && this.objects.has(key)) throw Object.assign(new Error('precondition'), { name: 'PreconditionFailed' });
    this.puts += 1;
    const value = { bytes: Uint8Array.from(input.bytes), versionId: `v${this.puts}` };
    this.objects.set(key, value);
    return { versionId: value.versionId };
  }
}

describe('ExtractionArtifactStoreV1 restart safety', () => {
  let fake: FakeS3;
  let store: S3ExtractionArtifactStore;
  beforeEach(() => { fake = new FakeS3(); store = new S3ExtractionArtifactStore('artifacts', 'phase10/parser-artifacts', fake); });

  it('is content-addressed, idempotent, and collision-free', async () => {
    const first = await store.putImmutable({ bytes: Buffer.from('same') });
    const second = await store.putImmutable({ bytes: Buffer.from('same') });
    const different = await store.putImmutable({ bytes: Buffer.from('different') });
    expect(second).toEqual(first);
    expect(fake.puts).toBe(2);
    expect(different.locator).not.toBe(first.locator);
    expect(first.locator).toMatch(/^s3:\/\/artifacts\/phase10\/parser-artifacts\/[0-9a-f]{64}\?versionId=v1$/);
  });

  // Regression for PR #1318 Part A's s3:ListBucket fix -- the FIRST write to a
  // brand-new content-addressed key, not a restart/read of an object that
  // already exists. Every prior test in this file (including the one above)
  // writes into a freshly-constructed empty `fake.objects` Map, so this
  // exercises the identical "no prior object" starting state; this test
  // exists to make that path explicit and to assert the exact HEAD-then-PUT
  // sequence, not just the resulting locator/byteSha256 pair.
  //
  // Why this matters at the IAM layer: `S3::HeadObject` on a key that does
  // not exist can return an AMBIGUOUS 403 Forbidden instead of a 404 Not
  // Found when the calling principal lacks `s3:ListBucket` on the bucket --
  // S3 intentionally conflates "key not found" and "you can't prove whether
  // it exists" to avoid leaking key existence to an unauthorized caller. A
  // 403 on this FIRST head, with no ListBucket permission, would be
  // indistinguishable from a genuine permission failure at the SDK/HTTP
  // layer; the fake here models the CORRECTLY-permissioned case (HEAD
  // returns a clean "missing" result, matching what AwsParserArtifactObjectStore
  // gets once s3:ListBucket + s3:prefix is granted) precisely so the negative
  // case (HEAD 403 without ListBucket) can be asserted separately below.
  it('performs a real HEAD-then-PUT on the very first write to an empty/never-before-seen key', async () => {
    expect(fake.objects.size).toBe(0);
    const bytes = Buffer.from('{"firstWrite":true}\n');
    const result = await store.putImmutable({ bytes });
    // Exactly one PUT happened (the HEAD correctly reported "missing", so the
    // code proceeded to the conditional PUT rather than short-circuiting).
    expect(fake.puts).toBe(1);
    expect(result.byteSha256).toHaveLength(64);
    expect(result.locator).toMatch(/^s3:\/\/artifacts\/phase10\/parser-artifacts\/[0-9a-f]{64}\?versionId=v1$/);
    // The object is now present under the exact content-addressed key.
    const url = new URL(result.locator);
    expect(fake.objects.has(fake.key(url.hostname, url.pathname.slice(1)))).toBe(true);
  });

  // Negative-control counterpart: models the failure mode s3:ListBucket
  // fixes -- HeadObject on a missing key returning an AMBIGUOUS 403 rather
  // than a clean "not found" result, which is exactly what happens when the
  // calling principal lacks s3:ListBucket. Proves the store does NOT swallow
  // this as "object exists" (which would silently skip the PUT and leave no
  // durable artifact) -- it must surface as a real, visible failure.
  it('fails loudly (never silently skips the PUT) when HeadObject on a missing key returns an ambiguous 403, the exact failure mode s3:ListBucket prevents', async () => {
    const ambiguous403: ParserArtifactObjectStoreV1 = {
      async headObject() {
        throw Object.assign(new Error('Forbidden'), { name: 'Forbidden', $metadata: { httpStatusCode: 403 } });
      },
      async getObject() { return null; },
      async putObject() { throw new Error('putObject should never be reached in this scenario'); },
    };
    const storeWithoutListBucket = new S3ExtractionArtifactStore('artifacts', 'phase10/parser-artifacts', ambiguous403);
    await expect(storeWithoutListBucket.putImmutable({ bytes: Buffer.from('never persisted') })).rejects.toThrow(/Forbidden/);
  });

  // Runtime regression for PR #1318 Part A: this is the exact read shape the
  // task role's `s3:GetObjectVersion` grant authorizes -- readVerified always
  // passes the persisted locator's explicit VersionId (S3ExtractionArtifactStore
  // defaults requireVersionId=true) rather than reading "whatever is live at
  // that key now", so a version-pinned locator surviving a full store-instance
  // restart under exactly this call shape is the proof that the granted
  // permission set (GetObject + GetObjectVersion + PutObject, nothing wider)
  // is sufficient for the task to actually do its job.
  it('survives a fresh-container restart and materializes only verified scratch bytes', async () => {
    const bytes = Buffer.from('{"durable":true}\n');
    const persisted = await store.putImmutable({ bytes });
    const emptyRoot = await mkdtemp(join(tmpdir(), 'empty-restarted-task-'));
    expect(await readdir(emptyRoot)).toEqual([]);
    const restarted = new S3ExtractionArtifactStore('artifacts', 'phase10/parser-artifacts', fake);
    expect(await restarted.readVerified({ locator: persisted.locator, expectedByteSha256: persisted.byteSha256 })).toEqual(bytes);
    const scratch = await restarted.materializeForLocalConsumer({ locator: persisted.locator, expectedByteSha256: persisted.byteSha256 });
    expect(await readFile(scratch.localPath)).toEqual(bytes);
    await scratch.cleanup();
    await rm(emptyRoot, { recursive: true, force: true });
  });

  it('fails closed for corrupt bytes, wrong SHA, stale locators, and materialization', async () => {
    const persisted = await store.putImmutable({ bytes: Buffer.from('original') });
    const url = new URL(persisted.locator);
    const mapKey = fake.key(url.hostname, url.pathname.slice(1));
    fake.objects.get(mapKey)!.bytes = Buffer.from('tampered');
    await expect(store.readVerified({ locator: persisted.locator, expectedByteSha256: persisted.byteSha256 })).rejects.toThrow(/SHA mismatch/);
    fake.objects.delete(mapKey);
    await expect(store.readVerified({ locator: persisted.locator, expectedByteSha256: persisted.byteSha256 })).rejects.toThrow(/object missing/);
    await expect(store.materializeForLocalConsumer({ locator: persisted.locator, expectedByteSha256: persisted.byteSha256 })).rejects.toThrow(/object missing/);
  });

  it('classifies a missing remote artifact as retryable infrastructure failure', async () => {
    const result = ingestionOutboxDispositionForBridgeResultV1({ status: 'downstream_failed', observationId: 'o', sourceDocumentId: 's', reason: 'extraction artifact object missing', sourceDocumentBound: true, parserVerificationSucceeded: false, durableEvidencePersisted: false, ingestionSucceeded: false, parserHandoffInvoked: true, parserHandoffError: 'missing', verifierDecision: null });
    expect(result.disposition).toBe('retry');
  });

  it('keeps legacy filesystem locators verified and local', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-artifacts-'));
    const fsStore = new FilesystemExtractionArtifactStore(root);
    const persisted = await fsStore.putImmutable({ bytes: Buffer.from('legacy') });
    expect(persisted.locator.startsWith('s3://')).toBe(false);
    expect(await fsStore.readVerified({ locator: persisted.locator, expectedByteSha256: persisted.byteSha256 })).toEqual(Buffer.from('legacy'));
    await rm(root, { recursive: true, force: true });
  });
});
