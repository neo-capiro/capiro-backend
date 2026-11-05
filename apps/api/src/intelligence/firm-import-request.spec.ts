import { createHash } from 'node:crypto';
import { importRequestSha256 } from './firm-import-job.contracts.js';
import { normalizeImportWebsites, readImportWebsites } from './firm-import-request.js';

describe('durable import website inputs', () => {
  it('normalizes selected websites before hashing and keeps the legacy digest unchanged', () => {
    const websites = normalizeImportWebsites(
      { '11': 'https://B.example/#research', '10': ' A.example ' },
      [10, 11],
    );
    expect(websites).toEqual({ '10': 'https://a.example/', '11': 'https://b.example/' });
    const legacy = createHash('sha256')
      .update('{"registrantId":7,"ldaClientIds":[10,11]}')
      .digest('hex');
    expect(importRequestSha256(7, [11, 10])).toBe(legacy);
    expect(importRequestSha256(7, [10, 11], {})).toBe(legacy);
    expect(importRequestSha256(7, [10, 11], websites)).not.toBe(legacy);
    expect(importRequestSha256(7, [11, 10], { ...websites })).toBe(
      importRequestSha256(7, [10, 11], websites),
    );
  });

  it.each([
    null,
    [],
    { '11': 'https://example.com' },
    { '010': 'https://example.com' },
    { '10': '' },
    { '10': 12 },
    { '10': 'x'.repeat(501) },
    { '10': 'https://exam\nple.com' },
    { '10': 'http://localhost' },
    { '10': 'http://127.1' },
    { '10': 'http://0x7f000001' },
    { '10': 'http://169.254.169.254/latest/meta-data' },
    { '10': 'https://[::ffff:127.0.0.1]' },
    { '10': 'https://company.internal' },
    { '10': 'https://company.local' },
    { '10': 'https://company.test' },
    { '10': 'https://user:secret@example.com' },
    { '10': 'file:///etc/passwd' },
    { '10': 'https://example.com:8080' },
  ])('rejects unsafe or unselected website input %p', (input) => {
    expect(() => normalizeImportWebsites(input, [10])).toThrow();
  });

  it('reads a saved request without deriving websites from current client data', () => {
    expect(readImportWebsites(null, [10])).toEqual({});
    expect(
      readImportWebsites(
        { schemaVersion: 1, websites: { '10': 'https://company.example/' } },
        [10],
      ),
    ).toEqual({ '10': 'https://company.example/' });
    for (const input of [
      { schemaVersion: 2, websites: {} },
      { schemaVersion: 1 },
      { schemaVersion: 1, websites: { '11': 'https://foreign.example/' } },
    ])
      expect(() => readImportWebsites(input, [10])).toThrow();
  });
});
