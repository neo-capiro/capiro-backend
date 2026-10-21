/** Pure command planning; importing this module never loads or runs a verifier. */
export function engagementPhase3Scope(args) {
  if (!Array.isArray(args) || args.filter(arg => arg === '--run').length !== 1 ||
      args.some(arg => !['--run', '--backend-only', '--frontend-only'].includes(arg)) ||
      args.filter(arg => arg !== '--run').length > 1) {
    throw new Error('Use exactly one --run and at most one --backend-only or --frontend-only');
  }
  return args.includes('--backend-only') ? 'backend-only' : args.includes('--frontend-only') ? 'frontend-only' : 'full';
}

function requireScope(scope) {
  if (!['full', 'backend-only', 'frontend-only'].includes(scope)) {
    throw new Error(`Unknown Phase 3 scope: ${scope}`);
  }
}

const FRONTEND_ONLY_LABELS = new Set([
  'Phase 3 web preview-header containment',
  'Phase 3 focused web contracts',
  'Phase 3 browser harness syntax',
  'Phase 3 interaction harness syntax',
  'Phase 3 scenario catalog syntax',
  'Phase 3 bearer refresh syntax',
  'Phase 3 browser+replay wrapper syntax',
  // This main gate proves the historical UI exists and v2 was not removed.
  // Its pure backend/source negative controls remain in CONTROL_LABEL below.
  'Phase 3 V3/prototype boundary',
  'Web production typecheck',
  'Web production build',
  'Web complete regression suite',
]);
const BACKEND_ONLY_LABELS = new Set([
  'Phase 0 prerequisite',
  'Phase 3 fixture/read/containment contracts',
  'Phase 3 fixture and acceptance-script typecheck',
  'Phase 3 local runner syntax',
  'Phase 3 local proxy syntax',
  'Phase 3 resilience syntax',
  'Phase 3 resilience wrapper syntax',
  'Phase 3 read replay syntax',
]);
const CONTROL_LABEL = 'Phase 3 harness/scope/resilience negative controls';

export function engagementPhase3QualificationPlan(scope, steps) {
  requireScope(scope);
  if (scope === 'full') return steps;

  const planned = [];
  for (const [label, command, args, ...options] of steps) {
    if (scope === 'backend-only' && FRONTEND_ONLY_LABELS.has(label)) continue;
    if (scope === 'frontend-only' && BACKEND_ONLY_LABELS.has(label)) continue;

    if (scope === 'backend-only' && label === 'Phase 3 UI inventory') {
      planned.push(['Phase 3 current backend route contracts', command,
        ['--test', 'scripts/engagement-phase3-backend-contract.spec.mjs'], ...options]);
    } else if (scope === 'backend-only' && label === 'Phase 3 preview route generation drift') {
      planned.push(['Phase 3 current backend preview boundary', command,
        ['scripts/engagement-phase3-backend-contract.mjs', '--check-preview-boundary'], ...options]);
    } else if (label === 'Phase 1 prerequisite' || label === 'Phase 2 prerequisite') {
      const suffix = scope === 'backend-only' ? ':backend' : ':frontend';
      planned.push([label, command, [args[0] + suffix], ...options]);
    } else if (label === CONTROL_LABEL) {
      // The original batch owns both browser tests and API/scope negative
      // controls. Split only their argv; keep every original test identity.
      const browser = args.filter((arg) => arg.startsWith('tests/support/legacy-web/'));
      const root = args.filter((arg) => arg.startsWith('scripts/'));
      if (scope === 'frontend-only') {
        planned.push(['Phase 3 browser negative controls', command, ['--test', ...browser], ...options]);
      }
      planned.push([label, command, ['--test', ...root], ...options]);
    } else {
      // Source-only replacements above do not qualify the historical UI/table.
      // Scope/findings retains current backend infra/runtime/ledger enforcement.
      // Historical UI main is frontend-only; pure controls remain above.
      planned.push([label, command, args, ...options]);
    }
  }
  return planned;
}

export function engagementPhase3CompletionMarker(scope) {
  requireScope(scope);
  if (scope === 'backend-only') return 'ENGAGEMENT_PHASE3_BACKEND_DB_FREE_COMPLETE';
  if (scope === 'frontend-only') return 'ENGAGEMENT_PHASE3_FRONTEND_DB_FREE_COMPLETE';
  return 'ENGAGEMENT_PHASE3_DB_FREE_COMPLETE';
}

export function engagementPhase3FailureMarker(scope) {
  requireScope(scope);
  if (scope === 'backend-only') return 'ENGAGEMENT_PHASE3_BACKEND_DB_FREE_FAILED';
  if (scope === 'frontend-only') return 'ENGAGEMENT_PHASE3_FRONTEND_DB_FREE_FAILED';
  // The original full CLI reports the error and exits 1 without a marker.
  return undefined;
}

export function engagementPhase3Phase1Policy(scope) {
  requireScope(scope);
  if (scope === 'backend-only') {
    return {
      complete: '[engagement-phase1] BACKEND COMPLETE',
      failed: '[engagement-phase1] BACKEND FAILED',
      logPath: 'C:\\dev\\recovery-phase3-phase1-backend-prerequisite.log',
    };
  }
  if (scope === 'frontend-only') {
    return {
      complete: '[engagement-phase1] FRONTEND COMPLETE',
      failed: '[engagement-phase1] FRONTEND FAILED',
      logPath: 'C:\\dev\\recovery-phase3-phase1-frontend-prerequisite.log',
    };
  }
  return {
    complete: 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE',
    failed: 'ENGAGEMENT_PHASE1_DB_FREE_FAILED',
    logPath: 'C:\\dev\\recovery-phase3-phase1-prerequisite.log',
  };
}

export function engagementPhase3Phase1CompletionState(output, scope, exitCode = null) {
  const policy = engagementPhase3Phase1Policy(scope);
  // Preserve the original full Windows protocol, including COMPLETE precedence
  // and its lack of a child-exit acceptance check. Scoped forms are stricter.
  if (scope === 'full') {
    if (output.includes(policy.complete)) return 'complete';
    if (output.includes(policy.failed)) return 'failed';
    return 'pending';
  }
  if (exitCode !== null && exitCode !== 0) return 'failed';
  if (output.includes(policy.failed)) return 'failed';
  const otherPolicies = ['full', 'backend-only', 'frontend-only']
    .filter(other => other !== scope).map(engagementPhase3Phase1Policy);
  if (otherPolicies.some(other => output.includes(other.complete) || output.includes(other.failed)))
    return 'failed';
  const lines = output.split(/\r?\n/);
  if (lines.includes(policy.complete)) return 'complete';
  if (output.includes(policy.complete)) return 'failed';
  return 'pending';
}

export function executeEngagementPhase3Plan(steps, { run, runPhase1 }) {
  for (const [label, command, args, options] of steps) {
    if (label === 'Phase 1 prerequisite') runPhase1(label, command, args, options);
    else run(label, command, args, options);
  }
}
