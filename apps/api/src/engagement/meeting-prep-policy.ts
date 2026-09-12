/** Operation-local budgets. Never raise the timeout of unrelated interactive tools. */
export const MEETING_PREP_POLICY = {
  version: 'comprehensive-prep-v1',
  standard: { meetings: 25, meetingDays: 180, threads: 100, emailDays: 90, messages: 1_000, upcomingDays: 30, deadlineMs: 30 * 60_000 },
  deep: { meetings: 100, meetingDays: 365, threads: 300, emailDays: 365, messages: 3_000, upcomingDays: 90, deadlineMs: 60 * 60_000 },
  synthesisMs: 10 * 60_000,
  reviewMs: 5 * 60_000,
  extractionMs: 3 * 60_000,
  toolMs: 45_000,
  persistenceReserveMs: 15_000,
  synthesisReserveMs: 8 * 60_000,
  heartbeatMs: 15_000,
  leaseMs: 90_000,
  outputTokens: 32_768,
  retryOutputTokens: 49_152,
  extractionTokens: 8_192,
  evidenceTokens: 64_000,
  maxRepairPasses: 2,
} as const;

export type MeetingPrepDepth = 'standard' | 'deep';
export const MEETING_BRIEFING_SECTIONS = [
  'recentDevelopments', 'importantEmails', 'previousConversations', 'decisions',
  'unresolvedIssues', 'upcomingDevelopments', 'commitments',
] as const;
export type MeetingBriefingSection = typeof MEETING_BRIEFING_SECTIONS[number];

export function meetingPrepEnabled(): boolean {
  return process.env.MEETING_PREP_COMPREHENSIVE_ENABLED === 'true';
}

/** Conservative UTF-8 upper bound: unlike chars/4 this never undercounts tokens. */
export function conservativeTokens(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
