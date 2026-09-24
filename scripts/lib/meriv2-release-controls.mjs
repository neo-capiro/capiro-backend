export const CONTROLLED_ENVIRONMENT_NAMES = Object.freeze([
  'MEMORY_GOVERNANCE_TENANTS',
  'MEMORY_GOVERNANCE_LIFECYCLE',
  'MEMORY_GOVERNANCE_ENFORCE',
  'MEMORY_CLIENT_REVIEW',
  'MEMORY_GOVERNANCE_CENTER',
  'MERIV2_CONTEXT_PACKET_V2',
  'CONTEXT_PACKET_V2',
  'MERI_POLICY_PACK_SOURCE',
  'MERI_POLICY_PACK_TENANTS',
  'MERI_RELEASE_GATE',
  'MERI_RELEASE_GATE_TENANTS',
  'MERI_RELEASE_GATE_SURFACES',
  'MERI_EVIDENCE_ACCURACY_MODE',
  'MERI_EVIDENCE_ACCURACY_TENANTS',
  'MERI_EVIDENCE_ACCURACY_SURFACES',
  'MERI_COVERAGE_RETRIEVAL_MODE',
  'MERI_COVERAGE_RETRIEVAL_TENANTS',
  'MERI_COVERAGE_RETRIEVAL_SURFACES',
  'MERI_CLAIM_ASSESSMENT_MODE',
  'MERI_CLAIM_ASSESSMENT_TENANTS',
  'MERI_CLAIM_ASSESSMENT_SURFACES',
  'MERI_AUTO_CORRECTION_MODE',
  'MERI_AUTO_CORRECTION_TENANTS',
  'MERI_AUTO_CORRECTION_SURFACES',
  'MERI_AUTO_CORRECTION_CATEGORIES',
  'MERI_PASSAGE_SELECTION_MODE',
  'MERI_PASSAGE_SELECTION_TENANTS',
  'MERI_PASSAGE_SELECTION_SURFACES',
  'MERI_EVIDENCE_PROFILES_MODE',
  'MERI_EVIDENCE_PROFILES_TENANTS',
  'MERI_EVIDENCE_PROFILES_SURFACES',
  'MERI_MATCH_LABEL_MODE',
  'MERI_MATCH_LABEL_TENANTS',
  'MERI_MATCH_LABEL_SURFACES',
  'MERI_STATUS_PROVENANCE_MODE',
  'MERI_STATUS_PROVENANCE_TENANTS',
  'MERI_STATUS_PROVENANCE_SURFACES',
  'MERI_JEV_CACHE_MODE',
  'MERI_JEV_CACHE_TENANTS',
  'MERI_JEV_CACHE_SURFACES',
  'MERI_JEV_PROVIDER_MODE',
  'MERI_JEV_PROVIDER_TENANTS',
  'MERI_JEV_PROVIDER_SURFACES',
  'MERI_JEV_MODEL',
  'MERI_JEV_TIMEOUT_MS',
  'MERI_JEV_MAX_ATTEMPTS',
  'MERI_CHAT_EVIDENCE_JUDGE',
  'MERI_JEV_TASKS',
  'MEMORY_AUTOLEARN_GOVERNED',
  'MERIV2_CONTROL_METRICS',
]);

const CONTROLLED = new Set(CONTROLLED_ENVIRONMENT_NAMES);

export function environmentRecord(environment = []) {
  return Object.fromEntries(
    environment.map((entry) => [String(entry.name), String(entry.value ?? '')]),
  );
}

export function controlledEnvironment(environment = []) {
  const values = environmentRecord(environment);
  return Object.fromEntries(
    CONTROLLED_ENVIRONMENT_NAMES.filter((name) => values[name] !== undefined).map((name) => [
      name,
      values[name],
    ]),
  );
}

export function computeControlChanges(existing, intended) {
  const live = environmentRecord(existing);
  return CONTROLLED_ENVIRONMENT_NAMES.map((name) => ({
    name,
    live: live[name] ?? null,
    intended: intended[name] ?? null,
  })).filter((entry) => entry.live !== entry.intended);
}

export function resolveControlPolicy(controlChanges, options = {}) {
  const preserve = options.preserveLiveControls === true;
  const reset = options.resetControls === true;
  if (preserve && reset) {
    throw new Error('Pass exactly one of --preserve-live-controls or --reset-controls, not both.');
  }
  if (!controlChanges.length) return 'dark';
  if (preserve) return 'preserve-live';
  if (reset) return 'reset';
  const details = controlChanges
    .map(({ name, live, intended }) => `${name}: ${display(live)} -> ${display(intended)}`)
    .join('; ');
  throw new Error(
    `Controlled environment differs from dark defaults: ${details}. ` +
      'Re-run with exactly one of --preserve-live-controls or --reset-controls.',
  );
}

export function replaceControlledEnvironment(existing, intended, policy) {
  if (!['dark', 'reset', 'preserve-live'].includes(policy)) {
    throw new Error(`Unknown control policy ${String(policy)}.`);
  }
  const live = environmentRecord(existing);
  const values = new Map(
    existing
      .filter((entry) => !CONTROLLED.has(entry.name))
      .map((entry) => [entry.name, { name: entry.name, value: String(entry.value ?? '') }]),
  );
  const selected = policy === 'preserve-live' ? live : intended;
  for (const name of CONTROLLED_ENVIRONMENT_NAMES) {
    const value = selected[name];
    if (value !== undefined) values.set(name, { name, value: String(value) });
  }
  return [...values.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function validateControlPolicy({ policy, liveControls, intendedControls, proposedControls }) {
  if (!['dark', 'reset', 'preserve-live'].includes(policy)) {
    throw new Error(`Manifest has invalid controlPolicy ${String(policy)}.`);
  }
  const changes = CONTROLLED_ENVIRONMENT_NAMES.filter(
    (name) => (liveControls[name] ?? null) !== (intendedControls[name] ?? null),
  );
  if (policy === 'dark' && changes.length) {
    throw new Error(`dark controlPolicy has live deviations: ${changes.join(', ')}.`);
  }
  const expected = policy === 'preserve-live' ? liveControls : intendedControls;
  const mismatches = CONTROLLED_ENVIRONMENT_NAMES.filter(
    (name) => (proposedControls[name] ?? null) !== (expected[name] ?? null),
  );
  if (mismatches.length) {
    throw new Error(`${policy} controlPolicy values mismatch: ${mismatches.join(', ')}.`);
  }
  return true;
}

export function assertPreservedControlsStillLive(recorded, current) {
  const drift = CONTROLLED_ENVIRONMENT_NAMES.filter(
    (name) => (recorded[name] ?? null) !== (current[name] ?? null),
  );
  if (drift.length) {
    throw new Error(`Live controlled environment drifted after preparation: ${drift.join(', ')}.`);
  }
  return true;
}

function display(value) {
  return value === null ? '<absent>' : JSON.stringify(value);
}
