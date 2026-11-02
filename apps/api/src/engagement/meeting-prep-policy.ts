/** Operation-local budgets. Never raise the timeout of unrelated interactive tools. */
export const MEETING_PREP_POLICY = {
  version: 'comprehensive-prep-v4',
  standard: {
    meetings: 10,
    meetingDays: 90,
    threads: 15,
    emailDays: 30,
    messages: 150,
    upcomingDays: 30,
    deadlineMs: 60 * 60_000,
  },
  deep: {
    meetings: 25,
    meetingDays: 180,
    threads: 100,
    emailDays: 90,
    messages: 1_000,
    upcomingDays: 30,
    deadlineMs: 60 * 60_000,
  },
  max: {
    meetings: 100,
    meetingDays: 365,
    threads: 300,
    emailDays: 365,
    messages: 3_000,
    upcomingDays: 90,
    deadlineMs: 120 * 60_000,
  },
  legacyDeadlineMs: 50 * 60_000,
  legacyProviderMs: 25 * 60_000,
  synthesisMs: 20 * 60_000,
  coverageReviewMs: 10 * 60_000,
  extractionMs: 10 * 60_000,
  extractionConcurrency: 4,
  toolMs: 45_000,
  persistenceReserveMs: 15_000,
  synthesisReserveMs: 15 * 60_000,
  heartbeatMs: 15_000,
  leaseMs: 90_000,
  outputTokens: 32_768,
  retryOutputTokens: 49_152,
  extractionTokens: 24_576,
  evidenceTokens: 64_000,
  maxRepairPasses: 2,
} as const;

export const MEETING_PREP_DEPTHS = ['standard', 'deep', 'max'] as const;
export type MeetingPrepDepth = (typeof MEETING_PREP_DEPTHS)[number];
export const MEETING_BRIEFING_SECTIONS = [
  'recentDevelopments',
  'importantEmails',
  'previousConversations',
  'decisions',
  'unresolvedIssues',
  'upcomingDevelopments',
  'commitments',
] as const;
export type MeetingBriefingSection = (typeof MEETING_BRIEFING_SECTIONS)[number];

export function meetingPrepEnabled(): boolean {
  return process.env.MEETING_PREP_COMPREHENSIVE_ENABLED === 'true';
}

/** Conservative UTF-8 upper bound: unlike chars/4 this never undercounts tokens. */
export function conservativeTokens(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Debrief D1/D2 budgets. The job deadline must stay >= 10 minutes (D1). */
export const MEETING_DEBRIEF_POLICY = {
  version: 'meeting-debrief-v1',
  /** Hard upper bound on the assembled model context (D2). */
  contextTokens: 8_000,
  deadlineMs: 15 * 60_000,
  leaseMs: 90_000,
  heartbeatMs: 15_000,
  maxAttempts: 3,
  /** Bounded continuity: how many of the client's own prior debriefs may be read. */
  recentDebriefs: 3,
  /** Per-section caps keep one section from crowding out the reviewed source. */
  sectionTokens: {
    prep: 2_000,
    visibleNotes: 2_000,
    attendees: 1_000,
    meeting: 800,
    client: 400,
    openTasks: 600,
    recentDebriefs: 900,
    steeringContext: 600,
  },
} as const;

/**
 * Rollout gate for the async debrief job (D1). While it is off the route keeps its
 * existing synchronous 201 behaviour, and the worker never claims a job.
 */
export function meetingDebriefJobEnabled(): boolean {
  return process.env.MEETING_DEBRIEF_JOB_ENABLED === 'true';
}
