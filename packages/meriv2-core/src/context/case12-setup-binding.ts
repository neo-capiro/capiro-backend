/** Provenance of the actual completed Case12 setup. Shape checks do not mint
 * authority; the API must join these fields to its current native owners. */
export interface MeriCase12SetupBinding {
  setupRunId: string;
  fixtureInstanceId: string;
  setupPlanSha256: string;
  setupClaimSha256: string;
  setupLedgerSha256: string;
}

const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const KEYS = [
  'setupRunId',
  'fixtureInstanceId',
  'setupPlanSha256',
  'setupClaimSha256',
  'setupLedgerSha256',
] as const;

export function readMeriCase12SetupBinding(value: unknown): MeriCase12SetupBinding {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...KEYS].sort().join('|')
  )
    throw new Error('meri_case12_setup_binding_invalid');
  const binding = value as MeriCase12SetupBinding;
  for (const key of KEYS) {
    if (
      typeof binding[key] !== 'string' ||
      !(key === 'setupRunId' || key === 'fixtureInstanceId' ? UUID4 : HASH).test(binding[key])
    )
      throw new Error('meri_case12_setup_binding_invalid');
  }
  return Object.freeze(
    Object.fromEntries(KEYS.map((key) => [key, binding[key]])),
  ) as unknown as MeriCase12SetupBinding;
}

export function meriCase12SetupBindingsEqual(a: unknown, b: unknown): boolean {
  const left = readMeriCase12SetupBinding(a),
    right = readMeriCase12SetupBinding(b);
  return KEYS.every((key) => left[key] === right[key]);
}

export function validateMeriCase12SetupPolicyBinding(policy: {
  caseId: string | null;
  captureRunId: string | null;
  resetReceiptId: string | null;
  seedReceiptId: string | null;
  case12Setup?: MeriCase12SetupBinding;
  syntheticReadBudget?: unknown;
}): void {
  if (policy.caseId !== '12') {
    if (Object.hasOwn(policy, 'case12Setup'))
      throw new Error('meri_case12_setup_binding_foreign_case');
    return;
  }
  const binding = readMeriCase12SetupBinding(policy.case12Setup);
  if (
    policy.syntheticReadBudget ||
    policy.resetReceiptId !== null ||
    policy.seedReceiptId !== null ||
    typeof policy.captureRunId !== 'string' ||
    !UUID4.test(policy.captureRunId) ||
    policy.captureRunId === binding.setupRunId
  )
    throw new Error('meri_case12_setup_binding_scope_invalid');
}
