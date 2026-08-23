import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// intel-api container entrypoint (this app).
const entrypoint = readFileSync(join(__dirname, '../scripts/entrypoint.sh'), 'utf8');

describe('LegiWatch Phase 9 — intel-api entrypoint dispatch (group B)', () => {
  test('legiwatch-phase9-capture dispatches to the compiled capture runner', () => {
    expect(entrypoint).toMatch(
      /legiwatch-phase9-capture\)[\s\S]*?exec node dist\/hearing\/capture\/run-phase9-public-capture\.js "\$@"/,
    );
  });

  test('legiwatch-phase9-intelligence dispatches to the compiled intelligence runner', () => {
    expect(entrypoint).toMatch(
      /legiwatch-phase9-intelligence\)[\s\S]*?exec node dist\/hearing\/intelligence\/run-phase9-hearing-intelligence\.js "\$@"/,
    );
  });

  test('both verbs appear in the unknown-command usage message', () => {
    expect(entrypoint).toMatch(/expected:.*\blegiwatch-phase9-capture\b/);
    expect(entrypoint).toMatch(/expected:.*\blegiwatch-phase9-intelligence\b/);
  });

  test('existing public-capture-* and task verbs are preserved', () => {
    for (const verb of [
      'public-capture-preflight)',
      'public-capture-worker)',
      'public-capture-status)',
      'task)',
      'serve)',
      'migrate)',
      'enable-feature)',
    ]) {
      expect(entrypoint).toContain(verb);
    }
  });

  test('an arbitrary leading `node` is still rejected (no generic passthrough / eval / sh -c)', () => {
    expect(entrypoint).not.toMatch(/^\s*node\)\s/m);
    expect(entrypoint).not.toMatch(/\beval\b/);
    expect(entrypoint).not.toMatch(/\bsh -c\b/);
    // Fail-closed catch-all remains.
    expect(entrypoint).toMatch(/\*\)\s*[\s\S]*Unknown command:[\s\S]*exit 1/);
  });

  test('entrypoint.sh still parses as valid shell', () => {
    try {
      execFileSync('sh', ['-n', join(__dirname, '../scripts/entrypoint.sh')], { stdio: 'pipe' });
    } catch (err) {
      const e = err as { code?: string; stderr?: Buffer };
      if (e.code === 'ENOENT') return; // no POSIX shell on this box
      throw new Error(e.stderr?.toString().trim() || 'parse failed');
    }
  });
});
