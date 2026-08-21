import {
  EngagementAiService,
  type MeetingDebriefDraftInput,
  type MeetingPrepInput,
} from './engagement-ai.service.js';
import { requireMeetingGovernedContext } from './meeting-context-runtime.js';

export const RAW_ENGAGEMENT_AI_SERVICE = Symbol('RAW_ENGAGEMENT_AI_SERVICE');

/**
 * Provider-seam enforcement for Phase 24.
 *
 * EngagementService still owns authoritative current-meeting, transcript/note,
 * directory and persistence behavior. Historical/private context assembled by
 * its pre-Phase-24 helper queries is removed before the provider sees it and is
 * replaced by the one request-scoped Context Plane bundle. A direct internal AI
 * call without that bundle fails closed.
 */
export function createGovernedMeetingAiService(
  service: EngagementAiService,
): EngagementAiService {
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === 'generateMeetingPrep') {
        return async (
          input: MeetingPrepInput,
          ctx?: Parameters<EngagementAiService['generateMeetingPrep']>[1],
        ) => {
          const bundle = requireMeetingGovernedContext('prep');
          assertInputScope(input.meeting, input.client, bundle.meetingId, bundle.clientId);
          const sanitized: MeetingPrepInput = {
            ...input,
            meeting: sanitizeCurrentMeeting(input.meeting),
            // These pre-Phase-24 history arrays are no longer model context.
            // Their governed equivalents are in bundle.modelContextBlock.
            recentMeetings: [],
            recentThreads: [],
            tasks: [],
            steeringContext: bundle.modelContextBlock,
          };
          return target.generateMeetingPrep(sanitized, ctx);
        };
      }
      if (property === 'generateMeetingDebrief') {
        return async (
          input: MeetingDebriefDraftInput,
          ctx?: Parameters<EngagementAiService['generateMeetingDebrief']>[1],
        ) => {
          const bundle = requireMeetingGovernedContext('debrief');
          assertInputScope(input.meeting, input.client, bundle.meetingId, bundle.clientId);
          const sanitized: MeetingDebriefDraftInput = {
            ...input,
            meeting: sanitizeCurrentMeeting(input.meeting),
            // The source transcript and visible notes remain intact and are the
            // only evidence of what happened. Legacy private history is removed.
            clientContext: null,
            recentMeetings: [],
            recentThreads: [],
            steeringContext: bundle.modelContextBlock,
          };
          return target.generateMeetingDebrief(sanitized, ctx);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function assertInputScope(
  meeting: Record<string, unknown>,
  client: Record<string, unknown> | null,
  expectedMeetingId: string,
  expectedClientId: string | null,
): void {
  const meetingId = stringField(meeting, 'id');
  if (!meetingId || meetingId !== expectedMeetingId) {
    throw new Error('phase24_meeting_ai_meeting_mismatch');
  }
  const inputClientId = client ? stringField(client, 'id') : null;
  // The raw Engagement service treats explicitly internal meetings as
  // unscoped even if a stale denormalized clientId remains on the row. Match
  // that canonical behavior before comparing the provider input to the packet.
  const meetingClientId = meeting.isInternal === true
    ? null
    : stringField(meeting, 'clientId');
  const effectiveClientId = inputClientId ?? meetingClientId;
  if (effectiveClientId !== expectedClientId) {
    throw new Error('phase24_meeting_ai_client_mismatch');
  }
}

function sanitizeCurrentMeeting(
  meeting: Record<string, unknown>,
): Record<string, unknown> {
  const blocked = new Set([
    'client',
    'attendees',
    'preps',
    'debriefs',
    'tasks',
    'notes',
    'attachments',
    'mailThreads',
    'recentMeetings',
    'recentThreads',
  ]);
  return Object.fromEntries(
    Object.entries(meeting).filter(([key]) => !blocked.has(key)),
  );
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}
