/** Durable storage boundary for the composed extraction artifact bytes. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Bytes } from '../contracts/canonical-json.js';
import type { ParserArtifactObjectStoreV1 } from './parser-artifact-store.js';

export interface ExtractionArtifactStoreV1 {
  putImmutable(input: { bytes: Buffer }): Promise<{ locator: string; byteSha256: string }>;
  readVerified(input: { locator: string; expectedByteSha256: string }): Promise<Buffer>;
  materializeForLocalConsumer(input: { locator: string; expectedByteSha256: string }): Promise<{ localPath: string; cleanup: () => Promise<void> }>;
}

async function materialize(store: ExtractionArtifactStoreV1, input: { locator: string; expectedByteSha256: string }) {
  const bytes = await store.readVerified(input);
  const directory = await mkdtemp(join(tmpdir(), 'capiro-extraction-artifact-'));
  const localPath = join(directory, 'artifact.extraction-v1.json');
  await writeFile(localPath, bytes);
  return { localPath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

/** Local/dev/test implementation only; its root is not durable across containers. */
export class FilesystemExtractionArtifactStore implements ExtractionArtifactStoreV1 {
  constructor(private readonly rootDir: string) {}
  async putImmutable({ bytes }: { bytes: Buffer }) {
    const byteSha256 = sha256Bytes(bytes);
    await mkdir(this.rootDir, { recursive: true });
    const locator = join(this.rootDir, `${byteSha256}.extraction-v1.json`);
    try { await readFile(locator); } catch { await writeFile(locator, bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; }); }
    return { locator, byteSha256 };
  }
  async readVerified(input: { locator: string; expectedByteSha256: string }) {
    const bytes = await readFile(input.locator);
    const actual = sha256Bytes(bytes);
    if (actual !== input.expectedByteSha256) throw new Error(`extraction artifact byte SHA mismatch: expected ${input.expectedByteSha256}, got ${actual}`);
    return bytes;
  }
  materializeForLocalConsumer(input: { locator: string; expectedByteSha256: string }) { return materialize(this, input); }
}

function parseLocator(locator: string) {
  const url = new URL(locator);
  if (url.protocol !== 's3:' || !url.hostname || url.pathname.length < 2) throw new Error(`invalid S3 extraction artifact locator: ${locator}`);
  return { bucket: url.hostname, key: url.pathname.slice(1), ...(url.searchParams.get('versionId') ? { versionId: url.searchParams.get('versionId')! } : {}) };
}

export class S3ExtractionArtifactStore implements ExtractionArtifactStoreV1 {
  constructor(private readonly bucket: string, private readonly keyPrefix: string, private readonly objects: ParserArtifactObjectStoreV1, private readonly requireVersionId = true) {}
  async putImmutable({ bytes }: { bytes: Buffer }) {
    const byteSha256 = sha256Bytes(bytes);
    const key = `${this.keyPrefix.replace(/^\/+|\/+$/g, '')}/${byteSha256}`;
    const existing = this.objects.headObject ? await this.objects.headObject({ bucket: this.bucket, key }) : await this.objects.getObject({ bucket: this.bucket, key });
    let versionId = existing?.versionId;
    if (!existing) {
      try {
        versionId = (await this.objects.putObject({ bucket: this.bucket, key, bytes, contentType: 'application/json', ifNoneMatch: '*' })).versionId;
      } catch (error) {
        const raced = this.objects.headObject ? await this.objects.headObject({ bucket: this.bucket, key }) : null;
        if (!raced) throw error;
        versionId = raced.versionId;
      }
    }
    if (this.requireVersionId && !versionId) throw new Error('S3 extraction artifact requires bucket versioning and an immutable VersionId');
    const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
    return { locator: `s3://${this.bucket}/${key}${query}`, byteSha256 };
  }
  async readVerified(input: { locator: string; expectedByteSha256: string }) {
    const parsed = parseLocator(input.locator);
    if (parsed.bucket !== this.bucket) throw new Error('extraction artifact bucket mismatch');
    if (this.requireVersionId && !parsed.versionId) throw new Error('extraction artifact locator is missing immutable S3 VersionId');
    const object = await this.objects.getObject(parsed);
    if (!object) throw new Error(`extraction artifact object missing: ${input.locator}`);
    const bytes = Buffer.from(object.bytes);
    const actual = sha256Bytes(bytes);
    if (actual !== input.expectedByteSha256) throw new Error(`extraction artifact byte SHA mismatch: expected ${input.expectedByteSha256}, got ${actual}`);
    return bytes;
  }
  materializeForLocalConsumer(input: { locator: string; expectedByteSha256: string }) { return materialize(this, input); }
}
