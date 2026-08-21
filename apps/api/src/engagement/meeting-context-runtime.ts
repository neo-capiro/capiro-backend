import { AsyncLocalStorage } from 'node:async_hooks';

export type MeetingContextMode = 'prep' | 'debrief';

export interface MeetingCoverageProjection {
  complete: boolean;
  requestedDomains: string[];
  searchedDomains: string[];
  missingDomains: string[];
  partialDomains: string[];
  recordsReturned: number;
  paginationComplete: boolean;
  truncated: boolean;
  stopReason: string;
}

export interface MeetingGovernedContext {
  kind: 'governed_packet' | 'release_switch_rollback';
  mode: MeetingContextMode;
  meetingId: string;
  clientId: string | null;
  packetId: string | null;
  traceHash: string | null;
  modelContextBlock: string;
  coverage: MeetingCoverageProjection;
}

const storage = new AsyncLocalStorage<MeetingGovernedContext>();

/**
 * One request-scoped Phase 24 bundle is resolved before the mature Engagement
 * prep/debrief implementation runs and is reused all the way to the provider
 * seam. AsyncLocalStorage is also preserved through the detached notetaker
 * await chain, so the notes-first transcript path cannot compile a second packet.
 */
export function runWithMeetingGovernedContext<T>(
  context: MeetingGovernedContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function currentMeetingGovernedContext(): MeetingGovernedContext | null {
  return storage.getStore() ?? null;
}

export function requireMeetingGovernedContext(
  expectedMode?: MeetingContextMode,
): MeetingGovernedContext {
  const context = currentMeetingGovernedContext();
  if (!context) throw new Error('phase24_meeting_context_plane_bundle_required');
  if (expectedMode && context.mode !== expectedMode) {
    throw new Error('phase24_meeting_context_plane_mode_mismatch');
  }
  return context;
}
