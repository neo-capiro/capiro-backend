import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');
const runner = readFileSync(join(__dirname, 'sync-gsa-frpp.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

describe('District Nexus Release 4 GSA FRPP container command', () => {
  test('sync-gsa-frpp dispatches to sync-gsa-frpp.ts', () => {
    expect(dispatcher).toContain('exec ./node_modules/.bin/tsx scripts/sync-gsa-frpp.ts');
  });

  test('sync-gsa-frpp is listed in the unknown-command usage message', () => {
    expect(dispatcher).toMatch(/expected:.*\bsync-gsa-frpp\b/);
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

  test('package script sync:gsa-frpp resolves to the runner', () => {
    expect(pkg.scripts['sync:gsa-frpp']).toBe('tsx scripts/sync-gsa-frpp.ts');
  });

  test('runner is DRY RUN BY DEFAULT and persists only with explicit --commit', () => {
    expect(runner).toContain('DRY RUN BY DEFAULT');
    // dryRun is the negation of the explicit --commit opt-in.
    expect(runner).toContain('dryRun: !commit');
    expect(runner).toMatch(/--commit/);
  });

  test('runner is a bounded manual entrypoint with NO recurring schedule', () => {
    // The deliberate no-schedule posture is documented in the runner header;
    // no scheduler/EventBridge reference may exist for this verb.
    expect(runner).toContain('NO recurring schedule');
    expect(dispatcher).not.toMatch(/sync-gsa-frpp[^\n]*\b(schedule|cron|rule)\b/i);
  });
});
