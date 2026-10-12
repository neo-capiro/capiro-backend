import { BadRequestException } from '@nestjs/common';

export const OBJECTIVE_ASK_TYPES = [
  'funding',
  'policy_authority',
  'both',
  'protect_funding',
  'meri_propose',
] as const;
export type ObjectiveAskType = (typeof OBJECTIVE_ASK_TYPES)[number];
export type ObjectiveStatus = 'draft' | 'in_review' | 'ready';
export type ObjectiveTransition = 'request_review' | 'confirm_ready';

export interface ObjectiveFields {
  outcome: string;
  governmentProblem: string;
  askType: string | null;
  minimumWin: string;
  limits: string;
}

export type ObjectiveDraftInput = Partial<ObjectiveFields> & { ownerUserId?: string | null };
export type CreateObjectiveInput = ObjectiveDraftInput & { requestId: string };

export function normalizeObjectiveFields(
  input: Partial<ObjectiveFields>,
): Partial<ObjectiveFields> {
  if (input.askType != null && !OBJECTIVE_ASK_TYPES.some((type) => type === input.askType)) {
    throw new BadRequestException('Invalid objective ask type');
  }
  return {
    ...(input.outcome !== undefined ? { outcome: input.outcome.trim() } : {}),
    ...(input.governmentProblem !== undefined
      ? { governmentProblem: input.governmentProblem.trim() }
      : {}),
    ...(input.askType !== undefined ? { askType: input.askType } : {}),
    ...(input.minimumWin !== undefined ? { minimumWin: input.minimumWin.trim() } : {}),
    ...(input.limits !== undefined ? { limits: input.limits.trim() } : {}),
  };
}

export function objectiveReadiness(fields: ObjectiveFields) {
  const checklist = {
    outcome: fields.outcome.trim().length > 0,
    governmentProblem: fields.governmentProblem.trim().length > 0,
    askType: fields.askType !== null && OBJECTIVE_ASK_TYPES.some((type) => type === fields.askType),
    minimumWin: fields.minimumWin.trim().length > 0,
  };
  const completedFields = Object.values(checklist).filter(Boolean).length;
  return { checklist, completedFields, requiredFields: 4, isReady: completedFields === 4 };
}

export function requireObjectiveReady(fields: ObjectiveFields): void {
  const readiness = objectiveReadiness(fields);
  if (!readiness.isReady) {
    throw new BadRequestException({
      message: 'Complete outcome, government problem, ask type and minimum win first',
      code: 'OBJECTIVE_INCOMPLETE',
      readiness,
    });
  }
}
