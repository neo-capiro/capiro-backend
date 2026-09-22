import type { AssuranceSurface } from '../assurance/risk-gate';
import type { ClaimCategory } from '../assurance/evidence-plan';
import {
  resolveCapabilityRollout,
  validateCapabilityRolloutConfig,
  type CapabilityRolloutEnvironment,
  type CapabilityRolloutMode,
  type CapabilityRolloutValidation,
} from './capability-rollout';

export const AUTO_CORRECTION_CAPABILITY = 'AUTO_CORRECTION' as const;

const CLAIM_CATEGORIES: readonly ClaimCategory[] = [
  'bill_status', 'member_vote', 'current_role', 'budget_amount', 'budget_delta',
  'enactment', 'report_language', 'regulatory_deadline', 'schedule_commitment',
  'regulatory_stage', 'district_representation', 'grant_opportunity', 'grant_award',
  'procurement_opportunity', 'client_recommendation', 'negative_or_exhaustive',
  'general_background',
];

export interface AutoCorrectionCategories {
  categories: ReadonlySet<ClaimCategory>;
  unknownTokens: string[];
}

/** Empty by default: category promotion is an explicit human canary decision. */
export function resolveAutoCorrectionCategories(
  env: CapabilityRolloutEnvironment,
): AutoCorrectionCategories {
  const known = new Set<string>(CLAIM_CATEGORIES);
  const tokens = String(env.MERI_AUTO_CORRECTION_CATEGORIES ?? '')
    .split(/[\s,]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return {
    categories: new Set(tokens.filter((token): token is ClaimCategory => known.has(token))),
    unknownTokens: [...new Set(tokens.filter((token) => !known.has(token)))],
  };
}

export function resolveAutoCorrectionMode(
  env: CapabilityRolloutEnvironment,
  tenantId: string | null | undefined,
  surface: AssuranceSurface,
): CapabilityRolloutMode {
  return resolveCapabilityRollout({
    capability: AUTO_CORRECTION_CAPABILITY,
    env,
    tenantId,
    surface,
  }).mode;
}

export function validateAutoCorrectionConfig(
  env: CapabilityRolloutEnvironment,
): CapabilityRolloutValidation {
  return validateCapabilityRolloutConfig({ capability: AUTO_CORRECTION_CAPABILITY, env });
}
