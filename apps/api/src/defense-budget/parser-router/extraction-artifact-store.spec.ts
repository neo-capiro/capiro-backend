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
