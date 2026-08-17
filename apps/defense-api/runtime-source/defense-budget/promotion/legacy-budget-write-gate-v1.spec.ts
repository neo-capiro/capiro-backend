/**
 * Phase 7 Workstream M — legacy canonical-write containment.
 *
 * Two halves: the policy, and the dispatcher that enforces it. The second half
 * is a gate over the shell file, because a policy nothing calls is not
 * containment — and the twelve verbs are exactly the list a future edit is
 * likely to add a thirteenth to without noticing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LEGACY_BUDGET_WRITE_MODE_V1,
  LEGACY_BUDGET_DISPATCHER_VERBS_V1,
  LEGACY_BUDGET_WRITE_ENV_VAR_V1,
  legacyBudgetCommitDecisionV1,
  legacyBudgetWriteModeFromEnvV1,
} from './legacy-budget-write-gate-v1.js';

const dispatcher = readFileSync(
  join(__dirname, '..', '..', '..', 'scripts', 'entrypoint-dispatcher.inc'),
  'utf8',
);

describe('Phase 7 WS M — the kill switch defaults off', () => {
  it('is off unless an operator says otherwise', () => {
    expect(DEFAULT_LEGACY_BUDGET_WRITE_MODE_V1).toBe('off');
    const decision = legacyBudgetCommitDecisionV1({
      verb: 'ingest-defense-budget',
      argv: ['--commit'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe('kill_switch_off');
  });

  it('fails closed on a near-miss value', () => {
    // PE_LEGACY_BUDGET_WRITES=allowed must not enable canonical writes because it
    // looked close enough.
    expect(legacyBudgetWriteModeFromEnvV1('allowed')).toBe('off');
    expect(legacyBudgetWriteModeFromEnvV1('ALLOW')).toBe('off');
    expect(legacyBudgetWriteModeFromEnvV1('true')).toBe('off');
    expect(legacyBudgetWriteModeFromEnvV1(undefined)).toBe('off');
    expect(legacyBudgetWriteModeFromEnvV1('allow')).toBe('allow');
  });
});

describe('Phase 7 WS M — inspect survives', () => {
  it('allows an invocation that does not ask to commit', () => {
    // Plan §M.14 keeps inspect and extract behaviour. When a promotion and a
    // legacy loader disagree, the first thing anyone needs is to see what the
    // loader would have done.
    const decision = legacyBudgetCommitDecisionV1({ verb: 'load-om', argv: ['--fy', '2027'] });
    expect(decision).toEqual({ allowed: true, reason: 'inspect_only' });
  });

  it('allows a commit under the explicit operator override', () => {
    expect(
      legacyBudgetCommitDecisionV1({ verb: 'load-om', argv: ['--commit'], writeMode: 'allow' }),
    ).toEqual({ allowed: true, reason: 'operator_override' });
  });
});

describe('Phase 7 WS M — the read mode can veto and cannot be vetoed', () => {
  it('refuses a commit once any tenant is served from a snapshot, override or not', () => {
    for (const readMode of ['snapshot_canary', 'snapshot'] as const) {
      const decision = legacyBudgetCommitDecisionV1({
        verb: 'repair-pe-thousands-as-millions',
        argv: ['--commit'],
        writeMode: 'allow',
        readMode,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.allowed === false && decision.reason).toBe('snapshot_reads_active');
    }
  });

  it('still allows the override while reads are legacy or shadow', () => {
    for (const readMode of ['legacy', 'shadow'] as const) {
      expect(
        legacyBudgetCommitDecisionV1({
          verb: 'load-om',
          argv: ['--commit'],
          writeMode: 'allow',
          readMode,
        }).allowed,
      ).toBe(true);
    }
  });

  it('tells the operator what to do instead, and says which rule applied', () => {
    const killed = legacyBudgetCommitDecisionV1({ verb: 'load-om', argv: ['--commit'] });
    const vetoed = legacyBudgetCommitDecisionV1({
      verb: 'load-om',
      argv: ['--commit'],
      writeMode: 'allow',
      readMode: 'snapshot',
    });
    for (const decision of [killed, vetoed]) {
      expect(decision.allowed).toBe(false);
      if (decision.allowed) continue;
      expect(decision.message).toContain('plan-defense-budget-promotion-v1');
      expect(decision.message).toContain('Re-run without --commit to inspect');
    }
    expect(killed.allowed === false && killed.message).toContain(LEGACY_BUDGET_WRITE_ENV_VAR_V1);
    // The snapshot veto must not advertise an override that will not work.
    expect(vetoed.allowed === false && vetoed.message).toContain('cannot be overridden');
  });
});

describe('Phase 7 WS M — the dispatcher enforces it', () => {
  // Comments are stripped first: this file explains the guard at length, and a
  // gate that matches its own prose proves nothing.
  const statements = dispatcher
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  it('defines the guard once', () => {
    expect(statements).toContain('refuse_legacy_budget_commit() {');
  });

  it('guards every verb in the containment list', () => {
    for (const verb of LEGACY_BUDGET_DISPATCHER_VERBS_V1) {
      expect(statements).toContain(`refuse_legacy_budget_commit ${verb} `);
    }
  });

  it('calls the guard before the exec on every guarded verb', () => {
    // A guard after the exec never runs: exec replaces the process.
    for (const verb of LEGACY_BUDGET_DISPATCHER_VERBS_V1) {
      const line = statements
        .split('\n')
        .find((candidate) => candidate.includes(`refuse_legacy_budget_commit ${verb} `));
      expect(line).toBeDefined();
      const guardAt = line!.indexOf('refuse_legacy_budget_commit');
      const execAt = line!.indexOf('exec ');
      expect(guardAt).toBeGreaterThanOrEqual(0);
      expect(execAt).toBeGreaterThan(guardAt);
    }
  });

  it('guards the one verb that commits unconditionally with an unconditional argument', () => {
    // sync-jbook-r2 passes --commit itself, so an argv scan of the caller's
    // arguments would never see it.
    expect(statements).toContain('refuse_legacy_budget_commit sync-jbook-r2 --commit;');
  });

  it('reads the same env var the policy names, and defaults it off', () => {
    expect(statements).toContain(`\${${LEGACY_BUDGET_WRITE_ENV_VAR_V1}:-off}`);
  });

  it('exits non-zero rather than continuing when it refuses', () => {
    expect(statements).toContain('exit 64');
  });

  it('still catches a real omission, so stripping comments has not blunted it', () => {
    const withoutGuard = statements.replace('refuse_legacy_budget_commit load-om "$@"; ', '');
    expect(withoutGuard).not.toContain('refuse_legacy_budget_commit load-om ');
  });

  it('leaves the alert emitters to the rollout rather than this switch', () => {
    // emit-changes and friends publish; they do not write canonical rows, and
    // they are frozen by the rollout's own final step.
    for (const verb of ['emit-changes', 'emit-bill-alerts', 'send-pe-alert-emails']) {
      expect(LEGACY_BUDGET_DISPATCHER_VERBS_V1).not.toContain(verb);
    }
  });
});
