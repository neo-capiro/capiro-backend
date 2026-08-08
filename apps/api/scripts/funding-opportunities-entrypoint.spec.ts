import { describe, expect, test } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');

describe('Funding Opportunities container commands', () => {
  test.each([
    ['generate-funding-grant-candidates', 'generate-funding-grant-candidates.ts'],
    ['generate-sam-opportunity-candidates', 'generate-sam-opportunity-candidates.ts'],
    ['process-funding-opportunity-lifecycle', 'process-funding-opportunity-lifecycle.ts'],
    ['backfill-sam-opportunity-fields', 'backfill-sam-opportunity-fields.ts'],
    ['backfill-funding-mapping-review', 'backfill-funding-mapping-review.ts'],
    ['match-contractor-identifiers', 'match-contractor-identifiers.ts'],
    ['sync-sam-opportunities-all-federal', 'sync-sam-opportunities.ts'],
    // P47. Forwarding ALL arguments matters more than usual here: --commit,
    // --endpoint-id and --confirm-callback are the safety interlocks, and a
    // dispatcher that dropped them would silently downgrade a commit to a dry
    // run — or, far worse, drop --confirm-callback from a real commit.
    ['reconcile-tango-webhook-alerts', 'reconcile-tango-webhook-alerts.ts'],
    // P48. Same reasoning: --commit is the interlock between a dry run and
    // real alert writes, and a dispatcher that dropped it would silently turn
    // a scheduled drain into a no-op nobody noticed.
    ['process-tango-events', 'process-tango-events.ts'],
    // P49. Read-only, but still argument-forwarding: --tenant and
    // --window-days change what a canary reviewer is actually looking at.
    ['diag-funding-opportunities-makegov', 'diag-funding-opportunities-makegov.ts'],
    ['diag-tango-webhook-contract', 'diag-tango-webhook-contract.ts'],
  ])('%s dispatches to %s and forwards all arguments', (verb, script) => {
    if (verb === 'sync-sam-opportunities-all-federal') {
      expect(dispatcher).toContain(
        `${verb}) shift; exec ./node_modules/.bin/tsx scripts/${script} --all-federal --commit "$@" ;;`,
      );
      return;
    }
    expect(dispatcher).toContain(
      `${verb}) shift; exec ./node_modules/.bin/tsx scripts/${script} "$@" ;;`,
    );
  });
});

describe('the dispatcher is valid shell', () => {
  /**
   * The tests above assert that a dispatch LINE appears in the file. That is
   * worth having, but it cannot catch the failure that matters most: a syntax
   * error anywhere in this file makes EVERY scheduled job fail to start, not
   * just the verb somebody edited. `sh -n` parses without executing, so this
   * costs nothing and needs no database, no network, and no fake binaries.
   *
   * Skipped rather than failed where no POSIX shell exists (a Windows dev box
   * without one), because a missing interpreter is not evidence about the file.
   */
  const dispatcherPath = join(__dirname, 'entrypoint-dispatcher.inc');
  const entrypointPath = join(__dirname, 'entrypoint.sh');

  function parses(file: string): 'ok' | 'no-shell' | string {
    try {
      execFileSync('sh', ['-n', file], { stdio: 'pipe' });
      return 'ok';
    } catch (err) {
      const e = err as { code?: string; stderr?: Buffer };
      if (e.code === 'ENOENT') return 'no-shell';
      return e.stderr?.toString().trim() || 'parse failed';
    }
  }

  test('entrypoint-dispatcher.inc parses', () => {
    const result = parses(dispatcherPath);
    if (result === 'no-shell') return;
    expect(result).toBe('ok');
  });

  test('entrypoint.sh parses', () => {
    const result = parses(entrypointPath);
    if (result === 'no-shell') return;
    expect(result).toBe('ok');
  });
});
