import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function repoFile(path: string): string {
  return resolve(process.cwd(), '..', '..', path);
}

describe('Meri mobile v1 published contracts', () => {
  const openapi = JSON.parse(
    readFileSync(repoFile('docs/contracts/meri-mobile/v1/openapi.json'), 'utf8'),
  ) as { info: { version: string }; paths: Record<string, unknown> };

  it('publishes bootstrap, meeting concurrency, file, and token operations', () => {
    expect(openapi.info.version).toBe('1.0.0');
    expect(Object.keys(openapi.paths)).toEqual(
      expect.arrayContaining([
        '/bootstrap',
        '/meetings',
        '/meetings/{meetingId}',
        '/files/confirm',
        '/files/{fileId}/status',
        '/devices',
      ]),
    );
    expect(Object.keys(openapi.paths).some((path) => path.startsWith('/meri/'))).toBe(false);
    expect(JSON.stringify(openapi)).toContain('If-Match');
    expect(JSON.stringify(openapi)).toContain('stale_revision');
  });

  it('keeps deferred product decisions explicit', () => {
    const decisions = readFileSync(repoFile('docs/meri/mobile/phase1-decisions.md'), 'utf8');
    expect(decisions).toContain('Post-creation attendee editing');
    expect(decisions).toContain('Voice memos');
  });
});
