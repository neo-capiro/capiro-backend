/**
 * Rule registry for defense_budget_verification_v1.
 *
 * Registers all verification rules by code, so the engine can look up
 * which rules to run for a given policy. Rules are registered once at
 * module load and remain immutable.
 */
import type { VerificationRuleV1 } from './rule-types.js';

/* ------------------------------------------------------------------ */
/* Registry                                                             */
/* ------------------------------------------------------------------ */

const REGISTRY = new Map<string, VerificationRuleV1>();

/** Register a rule. Throws if a duplicate code is already registered. */
export function registerRule(rule: VerificationRuleV1): void {
  if (REGISTRY.has(rule.code)) {
    throw new Error(`duplicate verification rule code: ${rule.code}`);
  }
  REGISTRY.set(rule.code, rule);
}

/** Look up a rule by code. */
export function lookupRule(code: string): VerificationRuleV1 | undefined {
  return REGISTRY.get(code);
}

/** Get all registered rules. */
export function getAllRules(): readonly VerificationRuleV1[] {
  return [...REGISTRY.values()];
}

/** Get rules by codes, preserving order. Unknown codes are skipped. */
export function getRulesByCodes(codes: readonly string[]): readonly VerificationRuleV1[] {
  return codes.map((c) => REGISTRY.get(c)).filter((r): r is VerificationRuleV1 => r !== undefined);
}

/** Clear the registry (for testing). */
export function clearRuleRegistry(): void {
  REGISTRY.clear();
}
