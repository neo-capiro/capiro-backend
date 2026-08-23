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

describe('LegiWatch Phase 9 — CloudWatch alarm/metrics Environment contract (observability hotfix)', () => {
  test('alarm dimension and rule/task-family naming derive from the SAME ENVIRONMENT value', () => {
    expect(activateCode).toMatch(/ENVIRONMENT="\$\{CAPIRO_ENV:-dev\}"/);
    // Alarms are dimensioned on $ENVIRONMENT, not a hardcoded literal.
    expect(activateCode).toMatch(/--dimensions "Name=Environment,Value=\$\{ENVIRONMENT\}"/);
    // Rule/task-family names use the same $ENVIRONMENT variable.
    expect(activateCode).toMatch(/PREFIX="capiro-\$\{ENVIRONMENT\}-legiwatch"/);
    expect(activateCode).toMatch(/API_FAMILY="capiro-\$\{ENVIRONMENT\}-legiwatch-phase9-api"/);
    expect(activateCode).toMatch(/INTEL_FAMILY="capiro-\$\{ENVIRONMENT\}-legiwatch-phase9-intel"/);
  });

  test('clone_td injects CAPIRO_ENV=$ENVIRONMENT onto the named container only', () => {
    expect(activateCode).toMatch(/--arg envName CAPIRO_ENV --arg envValue "\$ENVIRONMENT"/);
    // The injection is scoped to the one named container, not every container
    // in the task definition.
    expect(activateCode).toMatch(/if \.name == \$container then/);
    // Existing CAPIRO_ENV entries are replaced (not duplicated); every other
    // env var on that container is preserved verbatim.
    expect(activateCode).toMatch(
      /\.environment = \(\(\.environment \/\/ \[\]\) \| map\(select\(\.name != \$envName\)\) \+ \[\{name:\$envName,value:\$envValue\}\]\)/,
    );
  });

  test('register-dark passes the discovered container name into clone_td for both API and intel', () => {
    expect(activateCode).toMatch(
      /API_TD=\$\(clone_td "\$API_SOURCE_TD" "\$API_FAMILY" \/tmp\/legiwatch-phase9-api-td\.json "\$API_CONTAINER" CONGRESS_API_KEY "\$congress_arn"\)/,
    );
    expect(activateCode).toMatch(
      /INTEL_TD=\$\(clone_td "\$INTEL_SOURCE_TD" "\$INTEL_FAMILY" \/tmp\/legiwatch-phase9-intel-td\.json "\$INTEL_CONTAINER"\)/,
    );
  });

  test('clone_td is backward-compatible: an omitted container arg changes nothing (no crash, no forced mutation)', () => {
    // The 4th positional param defaults to empty, and the jq pipeline is a
    // no-op branch (`if $container == "" then . else ... end`) when it's
    // empty — this is what keeps any other clone_td caller safe.
    expect(activateCode).toMatch(/local source="\$1" family="\$2" outfile="\$3" container="\$\{4:-\}" secretName="\$\{5:-\}" secretArn="\$\{6:-\}"/);
    expect(activateCode).toMatch(/if \$container == "" then \. else/);
  });

  test('this code path never touches rules, capture policy, or cutover state', () => {
    // clone_td/register-dark's CAPIRO_ENV injection is scoped to task
    // definition JSON construction; it must not appear anywhere near the
    // rule-enable/disable or capture-policy code paths.
    const cloneTdBlockMatch = activateCode.match(/clone_td\(\)\{[\s\S]*?\n\}/);
    expect(cloneTdBlockMatch).not.toBeNull();
    const cloneTdBlock = cloneTdBlockMatch![0];
    expect(cloneTdBlock).not.toMatch(/events (enable|disable)-rule/);
    expect(cloneTdBlock).not.toMatch(/production_default/i);
    expect(cloneTdBlock).not.toMatch(/capture_all_public_events/i);
    expect(cloneTdBlock).not.toMatch(/kill_switch/i);
  });
});

describe('LegiWatch Phase 9 — Congress.gov credential wiring (secret contract)', () => {
  test('a canonical, existing-precedent secret ID is used — not a hardcoded plaintext value', () => {
    expect(activateCode).toMatch(
      /CONGRESS_API_KEY_SECRET_ID="\$\{CAPIRO_CONGRESS_API_KEY_SECRET_ID:-capiro\/\$\{ENVIRONMENT\}\/congress-gov-api-key\}"/,
    );
    // The underscored variant seen in Secrets Manager is NOT referenced by
    // any live task definition and must not become canonical here.
    expect(activateCode).not.toMatch(/congress_gov_api_key/);
  });

  test('resolve_secret_arn fails closed when the secret does not exist (never returns empty/plaintext)', () => {
    expect(activateCode).toMatch(/resolve_secret_arn\(\)\{/);
    expect(activateCode).toMatch(/die "Secret not found in Secrets Manager: \$secret_id"/);
    // The ARN is read via `secretsmanager describe-secret --query ARN`, never
    // `get-secret-value` — this script never touches the secret's value.
    expect(activateCode).toMatch(/secretsmanager describe-secret --secret-id "\$secret_id" --query ARN/);
    expect(activateCode).not.toMatch(/get-secret-value/);
  });

  test('clone_td attaches the secret by ARN reference only, scoped to the named container', () => {
    expect(activateCode).toMatch(
      /\.secrets = \(\s*if \$secretName == "" then \(\.secrets \/\/ \[\]\)\s*else \(\(\.secrets \/\/ \[\]\) \| map\(select\(\.name != \$secretName\)\) \+ \[\{name:\$secretName,valueFrom:\$secretArn\}\]\)\s*end\s*\)/,
    );
    // No plaintext secret value literal is ever interpolated — only the
    // ARN variable, which itself came from describe-secret, not from a
    // hardcoded string.
    expect(activateCode).not.toMatch(/secretsmanager get-secret-value/);
  });

  test('register-dark resolves and attaches CONGRESS_API_KEY on the API container only (intel already inherits it)', () => {
    expect(activateCode).toMatch(
      /congress_arn=\$\(resolve_secret_arn "\$CONGRESS_API_KEY_SECRET_ID"\)/,
    );
    // API clone_td call includes the secret name + resolved ARN variable.
    expect(activateCode).toMatch(/clone_td "\$API_SOURCE_TD" "\$API_FAMILY" [^\n]*CONGRESS_API_KEY "\$congress_arn"/);
    // Intel clone_td call has no secret args — it already inherits the
    // secret from the live intel-api service TD.
    expect(activateCode).toMatch(
      /INTEL_TD=\$\(clone_td "\$INTEL_SOURCE_TD" "\$INTEL_FAMILY" \/tmp\/legiwatch-phase9-intel-td\.json "\$INTEL_CONTAINER"\)/,
    );
  });

  test('refresh-api-td is a separate, additionally-gated command that never disables a rule', () => {
    expect(activateScript).toContain('CONFIRM=REFRESH_LEGIWATCH_PHASE9_API_TD');
    expect(activateCode).toMatch(/confirm REFRESH_LEGIWATCH_PHASE9_API_TD/);
    const refreshBlockMatch = activateCode.match(/cmd_refresh_api_td\(\)\{[\s\S]*?\n\}/);
    expect(refreshBlockMatch).not.toBeNull();
    const refreshBlock = refreshBlockMatch![0];
    // It must never call put-rule (which is how rules get created/DISABLED)
    // and never touch the DB runtime registry.
    expect(refreshBlock).not.toMatch(/events put-rule/);
    expect(refreshBlock).not.toMatch(/register-runtime/);
    expect(refreshBlock).not.toMatch(/production_default/i);
    expect(refreshBlock).not.toMatch(/capture_all_public_events/i);
    expect(refreshBlock).not.toMatch(/kill_switch/i);
    // It only repoints existing targets via put-targets, scoped to api-kind
    // rows, and preserves everything about the target except TaskDefinitionArn.
    expect(refreshBlock).toMatch(/events put-targets --rule "\$rule"/);
    expect(refreshBlock).toMatch(/\.EcsParameters\.TaskDefinitionArn=\$td/);
    expect(refreshBlock).toMatch(/\[ "\$kind" = api \] \|\| continue/);
  });

  test('refresh-api-td is wired into the command dispatcher and usage message', () => {
    expect(activateCode).toMatch(/refresh-api-td\) cmd_refresh_api_td ;;/);
    expect(activateCode).toMatch(/plan\|register-dark\|enable-shadow\|disable\|refresh-api-td\|smoke\|status/);
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
