/** Pure planning for the caller's current qualification steps; no verifier is imported. */
const OUTREACH_V3_PHASES = new Set(['phase1', 'phase3', 'phase4']);
const OUTREACH_V3_SCOPES = new Set(['full', 'backend-only', 'frontend-only']);
const INHERITED_ENGAGEMENT_PHASE3 = {
  phase1: 'Phase 3 regression',
  phase3: 'Engagement Phase 3 current-product regression',
  phase4: 'Phase 3 reasoning regression',
};
const SHARED_SOURCE_CONTROLS = {
  phase1: new Set(['Phase 1 whitespace']),
  phase3: new Set(['Phase 3 committed-diff whitespace']),
  phase4: new Set(['Diff whitespace', 'Current PR whitespace']),
};

export function outreachV3Scope(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('Outreach V3 requires explicit --run and at most one declared scope');
  }
  if (
    args.filter((arg) => arg === '--run').length !== 1 ||
    args.length < 1 ||
    args.length > 2 ||
    args.some((arg) => !['--run', '--backend-only', '--frontend-only'].includes(arg))
  ) {
    throw new Error('Outreach V3 requires explicit --run and at most one declared scope');
  }
  const modes = args.filter((arg) => arg !== '--run');
  return modes[0]?.slice(2) ?? 'full';
}

function requireOutreachV3Plan(phase, scope) {
  if (!OUTREACH_V3_PHASES.has(phase)) throw new Error(`Unknown Outreach V3 phase: ${phase}`);
  if (!OUTREACH_V3_SCOPES.has(scope)) throw new Error(`Unknown Outreach V3 scope: ${scope}`);
}

export function outreachV3RunsLocalContracts(phase, scope) {
  requireOutreachV3Plan(phase, scope);
  // The Phase 4 local target/catalog/source assertions remain backend controls.
  // Engagement Phase 3 retains its own positive source/prototype inventories.
  return scope !== 'frontend-only';
}

export function outreachV3QualificationPlan(phase, scope, fullSteps) {
  requireOutreachV3Plan(phase, scope);
  if (scope === 'full') return fullSteps;

  const planned = [];
  for (const step of fullSteps) {
    const [label, command, args, ...options] = step;
    if (label === INHERITED_ENGAGEMENT_PHASE3[phase]) {
      let scopedArgs;
      if (phase === 'phase4') {
        if (
          args.length !== 2 ||
          args[0] !== 'scripts/verify-outreach-v3-phase3-code.mjs' ||
          args[1] !== '--run'
        ) {
          throw new Error('Nested Outreach Phase 3 requires exactly one --run before scope selection');
        }
        scopedArgs = [...args, `--${scope}`];
      } else {
        if (args.length !== 1 || args[0] !== 'verify:engagement-phase-3') {
          throw new Error('Nested Engagement Phase 3 requires its current full alias before scope selection');
        }
        scopedArgs = [`${args[0]}:${scope === 'backend-only' ? 'backend' : 'frontend'}`];
      }
      planned.push([label, command, scopedArgs, ...options]);
    } else if (scope === 'backend-only' || SHARED_SOURCE_CONTROLS[phase].has(label)) {
      planned.push(step);
    }
  }
  return planned;
}

export function outreachV3CompletionMarker(phase, scope) {
  requireOutreachV3Plan(phase, scope);
  const number = phase.slice('phase'.length);
  const qualifier = scope === 'full' ? '' : `_${scope === 'backend-only' ? 'BACKEND' : 'FRONTEND'}`;
  return `OUTREACH_V3_PHASE${number}${qualifier}_DB_FREE_COMPLETE`;
}

export function outreachV3FailureMarker(phase, scope) {
  requireOutreachV3Plan(phase, scope);
  if (scope === 'full') return undefined;
  return outreachV3CompletionMarker(phase, scope).replace(/COMPLETE$/, 'FAILED');
}

export function executeOutreachV3Plan(steps, run) {
  for (const step of steps) run(...step);
}
