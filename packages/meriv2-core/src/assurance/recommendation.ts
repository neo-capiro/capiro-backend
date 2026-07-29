import type { ClaimLedger } from './claim-ledger';
import type { GovernmentAffairsOperatingFrame } from './operating-frame';

export interface GovernmentAffairsRecommendation {
  id: string;
  clientObjectiveAdvanced?: string;
  evidenceBasis: string[];
  target?: {
    type: 'office' | 'committee' | 'agency' | 'person' | 'coalition' | 'generic';
    id?: string;
    label: string;
  };
  requestedAction: string;
  timing?: { window?: string; deadline?: string; timezone?: string };
  owner?: string;
  dependencies: string[];
  risks: string[];
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  uncertainty?: string;
  nextVerificationStep?: string;
  /** True only when tied to approved client direction in the operating frame. */
  clientSpecific: boolean;
  /** Generic option sets are permitted when no approved objective/ask exists. */
  genericOption: boolean;
}

export interface RecommendationValidation {
  valid: boolean;
  blockers: string[];
  warnings: string[];
}

export function validateGovernmentAffairsRecommendation(
  recommendation: GovernmentAffairsRecommendation,
  frame: GovernmentAffairsOperatingFrame,
  ledger: ClaimLedger,
): RecommendationValidation {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const evidenceIds = new Set(ledger.evidence.map((item) => item.id));
  const unresolved = recommendation.evidenceBasis.filter((id) => !evidenceIds.has(id));
  if (!recommendation.requestedAction.trim()) blockers.push('A requested action is required.');
  if (!recommendation.evidenceBasis.length) blockers.push('The recommendation has no evidence basis.');
  if (unresolved.length) blockers.push(`Unresolved evidence ids: ${unresolved.join(', ')}.`);
  if (ledger.conflictedClaimIds.length) {
    blockers.push('Conflicted claims must be resolved before a client-specific recommendation is released.');
  }
  if (ledger.highRiskUnsupportedClaimIds.length) {
    blockers.push('Unsupported high-risk claims cannot support a recommendation.');
  }

  const approvedDirection = Boolean(frame.clientObjective || frame.authorizedAsk);
  if (recommendation.clientSpecific && !approvedDirection) {
    blockers.push('No approved client objective or authorized ask is available.');
  }
  if (recommendation.clientSpecific && recommendation.genericOption) {
    blockers.push('A recommendation cannot be both client-specific and a generic option.');
  }
  if (!approvedDirection && !recommendation.genericOption) {
    blockers.push('Without approved client direction, provide a generic option set rather than manufacturing an objective.');
  }
  if (
    recommendation.clientObjectiveAdvanced &&
    frame.clientObjective &&
    normalize(recommendation.clientObjectiveAdvanced) !== normalize(frame.clientObjective)
  ) {
    blockers.push('The recommendation names a client objective that does not match approved client direction.');
  }
  if (!recommendation.target) warnings.push('No target office, committee, agency, or person is identified.');
  if (!recommendation.timing?.window && !recommendation.timing?.deadline) {
    warnings.push('No procedural timing or deadline is identified.');
  }
  if (!recommendation.nextVerificationStep) warnings.push('No next verification step is identified.');
  if (!recommendation.dependencies.length) warnings.push('No dependencies or prerequisites are identified.');
  if (!recommendation.risks.length) warnings.push('No opposition or execution risk is identified.');

  return { valid: blockers.length === 0, blockers, warnings };
}

export function genericRecommendationOption(input: {
  id: string;
  requestedAction: string;
  evidenceBasis: string[];
  targetLabel?: string;
  uncertainty: string;
  nextVerificationStep: string;
}): GovernmentAffairsRecommendation {
  return {
    id: input.id,
    evidenceBasis: [...input.evidenceBasis],
    ...(input.targetLabel
      ? { target: { type: 'generic' as const, label: input.targetLabel } }
      : {}),
    requestedAction: input.requestedAction,
    dependencies: [],
    risks: [],
    confidence: 'low',
    uncertainty: input.uncertainty,
    nextVerificationStep: input.nextVerificationStep,
    clientSpecific: false,
    genericOption: true,
  };
}

export function recommendationPromptRequirements(
  frame: GovernmentAffairsOperatingFrame,
): string {
  const approved = Boolean(frame.clientObjective || frame.authorizedAsk);
  return [
    'For each recommendation, state the objective advanced, evidence basis, target, requested action, timing, dependencies, risks, confidence, uncertainty, and next verification step.',
    approved
      ? `Approved client direction is available${frame.clientObjective ? `: objective="${bounded(frame.clientObjective)}"` : ''}${frame.authorizedAsk ? `; ask="${bounded(frame.authorizedAsk)}"` : ''}. Do not exceed it.`
      : 'No approved client objective or authorized ask is available. Do not invent one; provide generic options or ask for direction.',
    'Keep political inference separate from factual procedural status.',
  ].join('\n');
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function bounded(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500);
}
