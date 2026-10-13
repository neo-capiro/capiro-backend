import type { ClientProfileFillSource } from './client-profile-fill.helpers.js';

export {
  CLIENT_PROFILE_FILL_COMPLETION_TASK_TYPES,
  buildClientProfileFillCompletionPlan,
  calculateProfileCompletion,
  mergeFillProgress,
  type ClientProfileFillCompletionTaskType,
  type ProfileCompletionInput,
  type ProfileCompletionResult,
} from './client-profile-fill-completion-projection.js';
export {
  ADVOCACY_SOURCE_NAMES,
  buildAdvocacyHistoryHealth,
  deriveAdvocacyBackfillOverallStatus,
  deriveAdvocacyFreshness,
  deriveAdvocacyOverallHealth,
  updateAdvocacySourceHealth,
  type AdvocacyBackfillOverallStatus,
  type AdvocacyBackfillStatus,
  type AdvocacyHistoryHealth,
  type AdvocacyOverallHealth,
  type AdvocacySourceAvailability,
  type AdvocacySourceBackfillState,
  type AdvocacySourceFreshness,
  type AdvocacySourceHealth,
} from './client-profile-fill-advocacy-health.js';
export {
  buildRegulatoryOutcomeFinding,
  deriveRegulatoryCommentSubmitterLabel,
  faraMatchConfidence,
  matchAdvocacyOutcomeDeterministically,
  planTestimonyScanBatch,
  resolveFaraMatchedRole,
  sameActivityDay,
  scoreAdvocacyOutcome,
  testimonyMatchConfidence,
  titleOverlapRatio,
} from './client-profile-fill-advocacy-mapping.js';

export interface RefreshScheduleRow {
  enabled: boolean;
  cadenceHours: number;
  sources: ClientProfileFillSource[];
  nextRunAt: Date | null;
  lastEnqueuedAt: Date | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateClientProfileFillScheduleInput {
  enabled: boolean;
  cadenceHours?: number;
  sources?: ClientProfileFillSource[];
}
