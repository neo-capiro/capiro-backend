/**
 * Barrel exports for the decision engine (Workstream J).
 */
export type {
  DecisionEngineInputV1,
  DecisionEngineResultV1,
} from './decision-engine-v1.js';
export { computeDecisionV1 } from './decision-engine-v1.js';
export type {
  RiskEngineInputV1,
  RiskEngineResultV1,
} from './risk-engine-v1.js';
export { computeRiskScoreV1 } from './risk-engine-v1.js';
