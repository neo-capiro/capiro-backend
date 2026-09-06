/**
 * Phase 5 (District Nexus R4 operational hardening): sync-tango-subawards.ts
 * was fully built and tested (sync-tango-subawards.spec.ts, plus the
 * client/mapper/types module specs) but was never registered in the
 * container entrypoint — the entire reason `tango_subaward` stayed empty in
 * production was that this command could never be invoked, not a broken
 * ingestion path. This spec proves the registration, mirroring the existing
 * sync-gsa-frpp-entrypoint.spec.ts convention.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');
const runner = readFileSync(join(__dirname, 'sync-tango-subawards.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('District Nexus Tango subaward sync container command', () => {
  test('sync-tango-subawards dispatches to sync-tango-subawards.ts', () => {
    expect(dispatcher).toContain('exec ./node_modules/.bin/tsx scripts/sync-tango-subawards.ts');
  });

  test('sync-tango-subawards is listed in the unknown-command usage message', () => {
    expect(dispatcher).toMatch(/expected:.*\bsync-tango-subawards\b/);
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

  test('package script sync:tango-subawards resolves to the runner', () => {
    expect(pkg.scripts['sync:tango-subawards']).toBe('tsx scripts/sync-tango-subawards.ts');
  });

  test('runner is DRY-RUN BY DEFAULT and requires --allow-full for a first unbounded commit', () => {
    expect(runner).toContain('DRY-RUN BY DEFAULT');
    expect(runner).toMatch(/--allow-full/);
    // `--commit` itself is built dynamically (flag(argv, 'commit') ->
    // `--${name}`), not written as a literal '--commit' string in this file
    // — assert on the actual mechanism instead of the literal substring.
    expect(runner).toMatch(/commit:\s*flag\(argv,\s*'commit'\)/);
  });

  test('runner is not (yet) referenced by any recurring schedule in this PR', () => {
    // Phase 8 adds a disabled schedule entry for this command in a SEPARATE
    // PR; this PR only fixes reachability, so no schedule reference should
    // exist yet at this specific commit's dispatcher comment for the verb.
    expect(dispatcher).not.toMatch(/sync-tango-subawards[^\n]*\b(cron|EventBridge)\b/i);
  });
});
