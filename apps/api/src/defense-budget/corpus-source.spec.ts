import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseS3Uri, isPdfKey, materializeS3Corpus, type CorpusS3 } from './corpus-source.js';

describe('parseS3Uri', () => {
  it('parses bucket + prefix', () => {
    expect(parseS3Uri('s3://my-bucket/some/prefix')).toEqual({ bucket: 'my-bucket', prefix: 'some/prefix' });
  });
  it('parses bucket-only URI (empty prefix)', () => {
    expect(parseS3Uri('s3://my-bucket')).toEqual({ bucket: 'my-bucket', prefix: '' });
  });
  it('is case-insensitive on the scheme', () => {
    expect(parseS3Uri('S3://b/p')).toEqual({ bucket: 'b', prefix: 'p' });
  });
  it('returns null for a local path', () => {
    expect(parseS3Uri('C:/Users/neoma/Downloads/x')).toBeNull();
    expect(parseS3Uri('/tmp/corpus')).toBeNull();
  });
  it('throws on a malformed s3 URI with no bucket', () => {
    expect(() => parseS3Uri('s3:///only/prefix')).toThrow(/no bucket/i);
  });
});

describe('isPdfKey', () => {
  it('accepts .pdf (any case)', () => {
    expect(isPdfKey('corpus/RDTE Vol 1.pdf')).toBe(true);
    expect(isPdfKey('corpus/RDTE.PDF')).toBe(true);
  });
  it('rejects non-pdf + directory markers', () => {
    expect(isPdfKey('corpus/notes.txt')).toBe(false);
    expect(isPdfKey('corpus/')).toBe(false);
    expect(isPdfKey('corpus/sub.pdf/')).toBe(false);
  });
});

describe('materializeS3Corpus', () => {
  function fakeS3(objs: Record<string, string>): CorpusS3 {
    return {
      async listKeys(_bucket, prefix) {
        return Object.keys(objs).filter((k) => k.startsWith(prefix));
      },
      async getObject(_bucket, key) {
        return new TextEncoder().encode(objs[key] ?? '');
      },
    };
  }

  it('downloads only PDFs, writing basenames into a scratch dir', async () => {
    const s3 = fakeS3({
      'corpus/RDTE Vol 1.pdf': 'A',
      'corpus/APN Book.pdf': 'B',
      'corpus/readme.txt': 'C',
      'corpus/': '',
    });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'test-corpus-'));
    const res = await materializeS3Corpus({ bucket: 'b', prefix: 'corpus/' }, s3, { destDir: dest });

    expect(res.files.length).toBe(2);
    expect(res.skipped).toBe(2); // readme.txt + the "corpus/" marker
    const names = res.files.map((f) => path.basename(f)).sort();
    expect(names).toEqual(['APN Book.pdf', 'RDTE Vol 1.pdf']);
    // bytes actually written
    for (const f of res.files) expect(fs.readFileSync(f).length).toBeGreaterThan(0);
  });

  it('preserves the original basename so the downstream classifier is unaffected', async () => {
    const s3 = fakeS3({ 'x/Missile Procurement Army.pdf': 'Z' });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'test-corpus-'));
    const res = await materializeS3Corpus({ bucket: 'b', prefix: 'x/' }, s3, { destDir: dest });
    expect(path.basename(res.files[0]!)).toBe('Missile Procurement Army.pdf');
  });

  it('de-collides identical basenames without losing either file', async () => {
    const s3 = fakeS3({
      'a/APN Book.pdf': '1',
      'b/APN Book.pdf': '2',
    });
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'test-corpus-'));
    const res = await materializeS3Corpus({ bucket: 'b', prefix: '' }, s3, { destDir: dest });
    expect(res.files.length).toBe(2);
    // both keep the classifier-relevant basename
    expect(res.files.every((f) => path.basename(f) === 'APN Book.pdf')).toBe(true);
    // but land on distinct paths
    expect(new Set(res.files).size).toBe(2);
  });
});
