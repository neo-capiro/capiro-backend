/**
 * Stage-A intelligence classifiers (product plan §2): pure, deterministic,
 * golden-fixture-spec'd. Consumed by the Movement Tracker, Conference Strategy
 * dashboard, runway views, and the capability->budget recommender.
 */
export {
  classifyPosture,
  type MarkVector,
  type Posture,
  type RecommendedAction,
  type PostureResult,
} from './committee-posture.js';
export {
  classifyRunway,
  type FyFunding,
  type RunwayClass,
  type RunwayResult,
} from './procurement-runway.js';
export {
  classifyMaturity,
  parseBudgetActivity,
  type MaturityStage,
  type MaturityInput,
  type MaturityResult,
} from './acquisition-maturity.js';
export {
  detectAnomalies,
  type AnomalyInput,
  type AnomalyType,
  type Anomaly,
} from './budget-anomaly.js';
export {
  buildMaturityLadder,
  type MaturityLadderInput,
  type MaturityRung,
  type MaturityLadder,
} from './maturity-ladder.js';
export {
  scoreAppropriability,
  type AppropriabilityInput,
  type AppropriabilityFactor,
  type AppropriabilityResult,
} from './appropriability.js';
