import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');

describe('backfill-intel-article-encoding container command', () => {
  test('dispatches to backfill-intel-article-encoding.ts and forwards all arguments (--commit)', () => {
    expect(dispatcher).toContain(
      'exec ./node_modules/.bin/tsx scripts/backfill-intel-article-encoding.ts "$@"',
    );
  });

  test('is listed in the unknown-command usage message', () => {
    expect(dispatcher).toMatch(/expected:.*\bbackfill-intel-article-encoding\b/);
  });

  test('entrypoint-dispatcher.inc still parses as valid shell', () => {
    try {
      execFileSync('sh', ['-n', join(__dirname, 'entrypoint-dispatcher.inc')], { stdio: 'pipe' });
    } catch (err) {
      const e = err as { code?: string; stderr?: Buffer };
      if (e.code === 'ENOENT') return; // no POSIX shell on this box -- not evidence about the file
      throw new Error(e.stderr?.toString().trim() || 'parse failed');
    }
  });
});
