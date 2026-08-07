import {
  ENGAGEMENT_API_CONTRACT,
  type EngagementApiInfraConfig,
} from './engagement-api-config';

/** Must match EngagementApiServiceStack's ECS maxHealthyPercent. */
export const ENGAGEMENT_API_DEPLOYMENT_MAXIMUM_PERCENT = 200;

export interface EngagementApiDbBudgetEvaluation {
  deploymentTaskCeiling: number;
  projectedPeak: number;
  safeCeiling: number;
  headroom: number;
  requiredHeadroom: number;
  failures: string[];
}

/**
 * Highest number of tasks ECS may run while replacing a service that has
 * already autoscaled to maximumCount. Steady-state maximumCount alone is not a
 * safe rollout budget when maximumPercent is 200.
 */
export function engagementApiDeploymentTaskCeiling(
  maximumCount: number,
  maximumPercent: number = ENGAGEMENT_API_DEPLOYMENT_MAXIMUM_PERCENT,
): number {
  return Math.ceil(maximumCount * (maximumPercent / 100));
}

export function evaluateEngagementApiDbBudget(
  cfg: EngagementApiInfraConfig,
): EngagementApiDbBudgetEvaluation {
  const budget = cfg.dbConnectionBudget;
  const deploymentTaskCeiling = engagementApiDeploymentTaskCeiling(cfg.maximumCount);
  const projectedPeak =
    budget.observedSevenDayPeak + deploymentTaskCeiling * budget.perTaskPoolMaximum;
  const safeCeiling = Math.floor(
    budget.databaseMaxConnections * ENGAGEMENT_API_CONTRACT.dbSafeCeilingRatio,
  );
  const headroom = budget.databaseMaxConnections - projectedPeak;
  const requiredHeadroom =
    budget.databaseMaxConnections * ENGAGEMENT_API_CONTRACT.dbHeadroomRatio;
  const failures: string[] = [];

  if (projectedPeak > safeCeiling) {
    failures.push(
      `deployment-surge database peak ${projectedPeak} exceeds safe ceiling ${safeCeiling} ` +
        `(observed=${budget.observedSevenDayPeak}, tasks=${deploymentTaskCeiling}, ` +
        `pool=${budget.perTaskPoolMaximum})`,
    );
  }
  if (headroom < requiredHeadroom) {
    failures.push(
      `deployment-surge database headroom ${headroom} is below required ${requiredHeadroom}`,
    );
  }

  return {
    deploymentTaskCeiling,
    projectedPeak,
    safeCeiling,
    headroom,
    requiredHeadroom,
    failures,
  };
}

export function assertEngagementApiDeploymentDbBudget(
  cfg: EngagementApiInfraConfig,
): EngagementApiDbBudgetEvaluation {
  const evaluation = evaluateEngagementApiDbBudget(cfg);
  if (evaluation.failures.length > 0) {
    throw new Error(
      `engagement-api database budget is unsafe during rolling deployment:\n  - ${evaluation.failures.join('\n  - ')}`,
    );
  }
  return evaluation;
}
