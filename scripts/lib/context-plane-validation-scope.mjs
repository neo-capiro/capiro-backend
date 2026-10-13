import { knowledgeValidationScope } from './knowledge-validation-scope.mjs';

/** Phase26's legacy fast mode still performs typing; source-only is explicit. */
export function contextPlaneValidationScope(args) {
  const sourceIntent = args.some((arg) => typeof arg === 'string' &&
    /^--source/i.test(arg.trim()));
  if (!sourceIntent) return knowledgeValidationScope(args);
  if (args.filter((arg) => arg === '--source-only').length !== 1 ||
      args.some((arg) => /^--source/i.test(String(arg).trim()) && arg !== '--source-only')) {
    throw new Error('Use exactly one literal --source-only with an explicit scope');
  }
  const selected = knowledgeValidationScope(args.filter((arg) => arg !== '--source-only'));
  if (!selected) throw new Error('--source-only requires --backend-only or --frontend-only');
  return { ...selected, sourceOnly: true };
}

export function contextPlaneValidationMarker(selected, failed = false) {
  if (!selected || !['backend', 'frontend'].includes(selected.scope)) throw new Error('Explicit scope required');
  const kind = selected.scope === 'frontend' || selected.sourceOnly ? 'SOURCE'
    : selected.skipTests ? 'TYPING' : 'NATIVE';
  return `KNOWLEDGE_PLANE_PHASE26_${selected.scope.toUpperCase()}_${kind}_${failed ? 'FAILED' : 'COMPLETE'}`;
}
