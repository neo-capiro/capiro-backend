import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from '@jest/globals';

const entrypointPath = join(__dirname, 'entrypoint.sh');
const dockerfilePath = join(__dirname, '..', 'Dockerfile');

describe('API entrypoint runtime temporary directory contract', () => {
  const entrypoint = readFileSync(entrypointPath, 'utf8');
  const dockerfile = readFileSync(dockerfilePath, 'utf8');

  test('selects and verifies writable scratch space before every dispatch path', () => {
    const selectorDefinition = entrypoint.indexOf('select_writable_tmpdir() {');
    const selectorCall = entrypoint.indexOf('\nselect_writable_tmpdir\n');
    const dispatcher = entrypoint.indexOf('\ncase "${1:-serve}" in');

    expect(selectorDefinition).toBeGreaterThanOrEqual(0);
    expect(selectorCall).toBeGreaterThan(selectorDefinition);
    expect(dispatcher).toBeGreaterThan(selectorCall);
    expect(entrypoint).toContain('for candidate in "${TMPDIR:-}" /dev/shm /tmp; do');
    expect(entrypoint).toContain('touch "$probe_path" 2>/dev/null');
    expect(entrypoint).toContain('rm -f "$probe_path" 2>/dev/null');
    expect(entrypoint).toContain(
      'No writable runtime temporary directory (tried TMPDIR, /dev/shm, /tmp)',
    );
    expect(entrypoint).toContain('exit 73');
  });

  test('does not restore the image-local read-only path after selection', () => {
    expect(entrypoint).not.toContain('export TMPDIR=/app/tmp');
    expect(dockerfile).toContain('ENV TMPDIR=/dev/shm');
    expect(dockerfile).not.toContain('ENV TMPDIR=/app/tmp');
  });

  test('remains valid POSIX shell', () => {
    try {
      execFileSync('sh', ['-n', entrypointPath], { stdio: 'pipe' });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
  });
});
