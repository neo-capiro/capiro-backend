import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('client revision lookup: real SQL identity and ethical-wall boundaries', () => {
  it('passes all twelve PostgreSQL membership, actor, grant, revocation and revision cases', () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        [
          'PATH',
          'SYSTEMROOT',
          'WINDIR',
          'COMSPEC',
          'PATHEXT',
          'TEMP',
          'TMP',
          'NODE_OPTIONS',
        ].includes(key.toUpperCase()),
      ),
    );
    const output = execFileSync(
      process.execPath,
      [join(__dirname, '../../scripts/verify-news-wall-postgres.cjs')],
      {
        env,
        encoding: 'utf8',
        timeout: 45_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const result = JSON.parse(output) as {
      complete: boolean;
      checks: string[];
      sourceSha256: string;
    };
    expect(result.complete).toBe(true);
    expect(result.checks).toHaveLength(12);
    expect(new Set(result.checks).size).toBe(12);
    expect(result.sourceSha256).toBe(
      createHash('sha256')
        .update(readFileSync(join(__dirname, 'memory-wall.helpers.ts')))
        .digest('hex'),
    );
  }, 60_000);
});
