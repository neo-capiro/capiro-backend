import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RawArchiveService,
  buildKeyPrefix,
  sha256OfBuffer,
  type S3Like,
  type S3CommandFactory,
  type ArchiveDescriptor,
} from './raw-archive.service.js';

/** In-memory S3 fake: records the command inputs the factory produced. */
function makeFake() {
  const sent: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const store = new Map<string, { versionId: string }>();
  const commands: S3CommandFactory = {
    head: (input) => ({ kind: 'head', input }),
    put: (input) => ({ kind: 'put', input }),
  };
  const s3: S3Like = {
    async send(command: unknown) {
      const c = command as { kind: string; input: Record<string, unknown> };
      sent.push({ kind: c.kind, input: c.input });
      if (c.kind === 'head') {
        const hit = store.get(c.input.Key as string);
        if (!hit) {
          const err = new Error('not found') as Error & { name: string };
          err.name = 'NotFound';
          throw err;
        }
        return { VersionId: hit.versionId };
      }
      // put
      const vid = `v-${store.size + 1}`;
      store.set(c.input.Key as string, { versionId: vid });
      return { VersionId: vid };
    },
  };
  return { s3, commands, sent, store };
}

describe('buildKeyPrefix', () => {
  it('produces the documented content-addressed layout', () => {
    const d: ArchiveDescriptor = {
      documentId: 'doc1',
      fiscalYear: 2027,
      sourceAuthority: 'dod-comptroller',
      family: 'rdte',
      localPath: '/tmp/x.pdf',
    };
    expect(buildKeyPrefix(d, 'abc123')).toBe(
      'raw/public/dod-budget/fiscal_year=2027/source_authority=dod-comptroller/family=rdte/document_id=doc1/sha256=abc123',
    );
  });
});

describe('RawArchiveService.archiveOriginal', () => {
  let tmp: string;
  let pdf: string;
  let bytes: Buffer;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rawarch-'));
    pdf = path.join(tmp, 'RDTE Vol 1.pdf');
    bytes = Buffer.from('%PDF-1.7 fake budget book bytes');
    fs.writeFileSync(pdf, bytes);
  });

  const descriptor = (): ArchiveDescriptor => ({
    documentId: 'doc-rdte-1',
    fiscalYear: 2027,
    sourceAuthority: 'dod-comptroller',
    family: 'rdte',
    localPath: pdf,
    retrievalAliases: ['https://comptroller.defense.gov/rdte_vol1.pdf'],
    manifest: { stage: 'pb', component: 'ARMY' },
  });

  it('archives original FIRST with If-None-Match, SSE-KMS and Object-Lock retention, then sidecars', async () => {
    const { s3, commands, sent } = makeFake();
    const svc = new RawArchiveService(s3, commands, {
      bucket: 'capiro-defense-budget-raw-dev-000',
      kmsKeyArn: 'arn:aws:kms:us-east-1:000:key/abc',
      retentionYears: 7,
    }, () => new Date('2026-07-14T00:00:00Z'));

    const res = await svc.archiveOriginal(descriptor());

    // Order: HEAD, PUT original, PUT retrieval, PUT manifest.
    expect(sent.map((s) => s.kind)).toEqual(['head', 'put', 'put', 'put']);
    const originalPut = sent[1]!.input;
    expect(originalPut.IfNoneMatch).toBe('*');
    expect(originalPut.ServerSideEncryption).toBe('aws:kms');
    expect(originalPut.SSEKMSKeyId).toBe('arn:aws:kms:us-east-1:000:key/abc');
    expect(originalPut.ObjectLockMode).toBe('GOVERNANCE');
    expect((originalPut.ObjectLockRetainUntilDate as Date).getUTCFullYear()).toBe(2033); // 2026 + 7
    expect(String(originalPut.Key)).toMatch(/\/original\.pdf$/);
    // sha256 checksum accompanies the body.
    expect(originalPut.ChecksumSHA256).toBeTruthy();

    // original is written BEFORE either sidecar.
    expect(String(sent[2]!.input.Key)).toMatch(/\/retrieval\.json$/);
    expect(String(sent[3]!.input.Key)).toMatch(/\/manifest\.json$/);

    expect(res.created).toBe(true);
    expect(res.versionId).toBe('v-1');
    expect(res.sha256).toBe(sha256OfBuffer(bytes));
    expect(res.retainUntil.getUTCFullYear()).toBe(2033);
  });

  it('is idempotent: identical bytes already present => no re-PUT of the original', async () => {
    const { s3, commands, sent, store } = makeFake();
    const svc = new RawArchiveService(s3, commands, {
      bucket: 'b',
      kmsKeyArn: 'arn:key',
      retentionYears: 7,
    });
    // Pre-seed the content-addressed original key as if a prior run archived it.
    const sha = sha256OfBuffer(bytes);
    const key = `${buildKeyPrefix(descriptor(), sha)}/original.pdf`;
    store.set(key, { versionId: 'pre-existing' });

    const res = await svc.archiveOriginal(descriptor());

    expect(res.created).toBe(false);
    expect(res.versionId).toBe('pre-existing');
    // HEAD hit, then only the two sidecars are PUT — the original is NOT re-uploaded.
    const puts = sent.filter((s) => s.kind === 'put');
    expect(puts.every((p) => !String(p.input.Key).endsWith('original.pdf'))).toBe(true);
  });

  it('records distinct retrieval aliases without a second raw object', async () => {
    const { s3, commands, sent } = makeFake();
    const svc = new RawArchiveService(s3, commands, { bucket: 'b', retentionYears: 7 });
    const d = descriptor();
    d.retrievalAliases = ['https://a/x.pdf', 'https://b/y.pdf'];
    await svc.archiveOriginal(d);
    const retrieval = JSON.parse(String(sent.find((s) => String(s.input.Key).endsWith('retrieval.json'))!.input.Body));
    expect(retrieval.aliases).toContain('https://a/x.pdf');
    expect(retrieval.aliases).toContain('https://b/y.pdf');
    expect(retrieval.aliases).toContain(d.localPath);
  });

  it('propagates a non-404 HEAD error instead of masking it', async () => {
    const commands: S3CommandFactory = { head: (i) => ({ kind: 'head', input: i }), put: (i) => ({ kind: 'put', input: i }) };
    const s3: S3Like = {
      async send() {
        const err = new Error('access denied') as Error & { name: string };
        err.name = 'AccessDenied';
        throw err;
      },
    };
    const svc = new RawArchiveService(s3, commands, { bucket: 'b', retentionYears: 7 });
    await expect(svc.archiveOriginal(descriptor())).rejects.toThrow(/access denied/);
  });
});
