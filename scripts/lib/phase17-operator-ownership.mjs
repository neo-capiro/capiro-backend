// Executable operator entrypoints belong to the API scripts directory. The
// Defense mirror retains runtime lineage and fixtures, without CLI copies.
export const PHASE17_OPERATOR_NAMES = Object.freeze([
  'phase6-stage-cycle.ts',
  'plan-defense-budget-promotion-v1.ts',
  'status-defense-budget-promotion-v1.ts',
]);

export function inspectPhase17OperatorOwnership(exists) {
  const errors = [];
  for (const name of PHASE17_OPERATOR_NAMES) {
    const canonical = `apps/api/scripts/${name}`;
    if (!exists(canonical)) errors.push(`Missing canonical Phase 1-7 operator: ${canonical}`);
  }
  const duplicateRoot = 'apps/defense-api/runtime-source/operators';
  if (exists(duplicateRoot)) {
    errors.push(`Duplicate Phase 1-7 operator tree: ${duplicateRoot}; use apps/api/scripts`);
  }
  return errors;
}
