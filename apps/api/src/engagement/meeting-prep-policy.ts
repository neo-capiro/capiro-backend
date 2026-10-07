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
