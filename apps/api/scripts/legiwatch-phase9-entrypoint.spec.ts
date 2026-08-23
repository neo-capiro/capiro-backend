import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The API dispatcher (this app) and the repo-root activation script.
const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');
const activateScript = readFileSync(
  join(__dirname, '../../../scripts/activate-legiwatch-phase9.sh'),
  'utf8',
);

// Executable lines only (drop shell comments) so assertions can't pass on a
// comment that merely mentions a token.
function shellCode(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}
const activateCode = shellCode(activateScript);

describe('LegiWatch Phase 9 — API entrypoint dispatch (group A)', () => {
  test('legiwatch-phase9-job dispatches to the compiled Phase 9 job runner', () => {
    expect(dispatcher).toMatch(
      /legiwatch-phase9-job\)\s*shift;\s*exec node dist\/live-hearings\/phase9\/run-legiwatch-phase9-job\.js "\$@"/,
    );
  });

  test('legiwatch-phase9-operator dispatches to the compiled operator runner', () => {
    expect(dispatcher).toMatch(
      /legiwatch-phase9-operator\)\s*shift;\s*exec node dist\/live-hearings\/phase9\/run-legiwatch-phase9-operator\.js "\$@"/,
    );
  });

  test('both verbs appear in the unknown-command usage message', () => {
    expect(dispatcher).toMatch(/expected:.*\blegiwatch-phase9-job\b/);
    expect(dispatcher).toMatch(/expected:.*\blegiwatch-phase9-operator\b/);
  });

  test('an arbitrary leading `node` is still rejected (no generic passthrough)', () => {
    // The only `exec node` lines are the allowlisted serve + the two Phase 9
    // verbs + the migrate path. There is no `node)` case and no `"$@"`
    // fall-through that would run an arbitrary node command.
    expect(dispatcher).not.toMatch(/^\s*node\)\s/m);
    // The catch-all must remain the fail-closed "Unknown command ... exit 1".
    expect(dispatcher).toMatch(/\*\)\s*[\s\S]*Unknown command:[\s\S]*exit 1/);
  });

  test('entrypoint-dispatcher.inc still parses as valid shell', () => {
    try {
      execFileSync('sh', ['-n', join(__dirname, 'entrypoint-dispatcher.inc')], { stdio: 'pipe' });
    } catch (err) {
      const e = err as { code?: string; stderr?: Buffer };
      if (e.code === 'ENOENT') return; // no POSIX shell on this box
      throw new Error(e.stderr?.toString().trim() || 'parse failed');
    }
  });
});

describe('LegiWatch Phase 9 — activation script contract (group C)', () => {
  test('API rule/smoke target command begins with the verb, not `node`', () => {
    expect(activateCode).toMatch(/printf '%s\\n' legiwatch-phase9-job "\$1"/);
    expect(activateCode).not.toMatch(
      /node dist\/live-hearings\/phase9\/run-legiwatch-phase9-job\.js/,
    );
  });

  test('intel rule target commands use the intel verbs, not `node`', () => {
    expect(activateCode).toMatch(/legiwatch-phase9-capture both --limit=10/);
    expect(activateCode).toMatch(/legiwatch-phase9-intelligence --max-passes 20/);
    expect(activateCode).not.toMatch(/node dist\/hearing\/capture\/run-phase9-public-capture\.js/);
    expect(activateCode).not.toMatch(
      /node dist\/hearing\/intelligence\/run-phase9-hearing-intelligence\.js/,
    );
  });

  test('register-runtime uses the operator verb', () => {
    expect(activateCode).toMatch(/legiwatch-phase9-operator register-runtime/);
    expect(activateCode).not.toMatch(/node dist\/live-hearings\/phase9\/run-legiwatch-phase9-operator\.js/);
  });

  test('smoke uses the SAME entrypoint verbs as scheduled execution', () => {
    // capture-worker/intelligence-worker smokes route through the intel verbs;
    // the default api smoke routes through legiwatch-phase9-job.
    expect(activateCode).toMatch(/legiwatch-phase9-capture status --manual/);
    expect(activateCode).toMatch(/legiwatch-phase9-intelligence --manual --max-passes 1/);
    expect(activateCode).toMatch(/legiwatch-phase9-job "\$job" --manual --limit 10/);
  });

  test('register-dark still creates rules DISABLED', () => {
    expect(activateCode).toContain('events put-rule');
    expect(activateCode).toContain('--state DISABLED');
    // Executable gate uses the confirm() helper with the bare token; the
    // `CONFIRM=...` literal itself only appears in the header usage comment.
    expect(activateCode).toMatch(/confirm CREATE_LEGIWATCH_PHASE9_DARK/);
    expect(activateScript).toContain('CONFIRM=CREATE_LEGIWATCH_PHASE9_DARK');
  });

  test('enable-shadow remains separately confirmation-gated', () => {
    expect(activateScript).toContain('CONFIRM=ENABLE_LEGIWATCH_PHASE9_SHADOW');
    expect(activateCode).toMatch(/confirm ENABLE_LEGIWATCH_PHASE9_SHADOW/);
  });

  test('capture-all / production-default / cutover automation stay untouched', () => {
    expect(activateCode).not.toMatch(/enable.*capture.all/i);
    expect(activateCode).not.toMatch(/production_default\s*=\s*true/i);
    expect(activateCode).not.toMatch(/\baws\b[^\n]*\bcloudformation\b/i);
    expect(activateCode).not.toMatch(/LEGIWATCH_ALLOW_PRODUCTION_CUTOVER=true/);
  });

  test('script still parses as valid shell', () => {
    try {
      execFileSync('bash', ['-n', join(__dirname, '../../../scripts/activate-legiwatch-phase9.sh')], {
        stdio: 'pipe',
      });
    } catch (err) {
      const e = err as { code?: string; stderr?: Buffer };
      if (e.code === 'ENOENT') return;
      throw new Error(e.stderr?.toString().trim() || 'parse failed');
    }
  });
});

describe('LegiWatch Phase 9 — service discovery safety (group D)', () => {
  test('API lookup anchors to the exact api service and excludes web', () => {
    // find_service api prefers the exact name and its fallback denies web.
    expect(activateCode).toMatch(/exact="capiro-\$\{ENVIRONMENT\}-api"/);
    expect(activateCode).toMatch(/grep -viE 'web\|intel\|engagement/);
    // The old over-broad pattern must be gone.
    expect(activateCode).not.toMatch(/grep -i 'api' \| grep -viE 'intel\|onboard/);
  });

  test('intel lookup anchors to the exact intel-api service', () => {
    expect(activateCode).toMatch(/exact="capiro-\$\{ENVIRONMENT\}-intel-api"/);
  });

  test('explicit CAPIRO_*_SERVICE overrides win', () => {
    expect(activateCode).toMatch(/if \[ -n "\$override" \]; then echo "\$override"; return; fi/);
  });

  test('hard assertion refuses a resolved service that is not the expected one', () => {
    expect(activateCode).toMatch(/assert_service\(\)\{/);
    expect(activateCode).toMatch(/assert_service api "\$API_SERVICE"/);
    expect(activateCode).toMatch(/assert_service intel "\$INTEL_SERVICE"/);
    expect(activateCode).toMatch(/resolved \$kind service '\$resolved' != expected/);
  });
});
