import {
  EngagementAiService,
  type MeetingDebriefDraftInput,
  type MeetingPrepInput,
} from './engagement-ai.service.js';
import {
  requireMeetingGovernedContext,
  type MeetingGovernedContext,
} from './meeting-context-runtime.js';
import { debriefContextTokens } from './meeting-debrief-context.js';
import { MEETING_DEBRIEF_POLICY } from './meeting-prep-policy.js';

export const RAW_ENGAGEMENT_AI_SERVICE = Symbol('RAW_ENGAGEMENT_AI_SERVICE');

/**
 * Provider-seam enforcement for Phase 24.
 *
 * EngagementService still owns authoritative current-meeting, transcript/note,
 * directory and persistence behavior. Prep keeps the firm's client record it
 * assembled (client-linked threads, prior meetings with their notes/debriefs,
 * open tasks) as the evidence the briefing answers from, and takes steering plus
 * governed supplemental records from the one request-scoped Context Plane
 * bundle. Debrief removes that history so only the transcript and visible notes
 * can establish what happened. A direct internal AI call without a bundle fails
 * closed.
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
            steeringContext: bundle.modelContextBlock,
            evidenceSources: bundle.evidenceSources ?? [],
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
            // The source transcript, own notes/prep, roster and bounded continuity are
            // the only evidence of what happened (D2). The input contract has no
            // client timeline, directory matches or mail fields to strip.
            //
            // The canonical Context Plane block is authoritative for meeting steering
            // and is always supplied, exactly as the original seam did. The assembly
            // composes it BEFORE the bound and the bound no longer reduces the steering
            // slot, so this is not a post-bound insertion in the governed path.
            // The assembly composes the canonical block BEFORE the bound and may have
            // reduced it by whole approved items to fit. Re-substituting the full bundle
            // here would undo that reduction after the bound and push the input back over
            // the limit, so an already-composed canonical block is kept as sent.
            steeringContext: isCanonicalProjectionOf(input.steeringContext, bundle)
              ? (input.steeringContext as string)
              : bundle.modelContextBlock,
          };
          // The provider seam dispatches nothing above the debrief's hard bound: the
          // canonical substitution happens here, so the check has to happen here too.
          if (debriefContextTokens(sanitized) > MEETING_DEBRIEF_POLICY.contextTokens)
            throw new Error('meeting_debrief_context_budget_exhausted');
          return target.generateMeetingDebrief(sanitized, ctx);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Is this steering the assembly's OWN canonical projection for this bundle?
 *
 * The assembly composes the canonical block before the bound and may reduce it by whole
 * approved items; the seam must accept that reduced projection rather than re-substituting
 * the full block after the bound. Acceptance is tied to the composition identity — the plane
 * framing AND this bundle's packet identity — not to an opening-tag substring, and a
 * projection that lost its closing boundary or any typed item's closing tag is not accepted.
 */
function isCanonicalProjectionOf(
  steering: unknown,
  bundle: MeetingGovernedContext,
): boolean {
  if (typeof steering !== 'string') return false;
  if (!steering.startsWith('<capiro_meeting_context_plane>')) return false;
  if (!steering.trimEnd().endsWith('</capiro_meeting_context_plane>')) return false;
  const packetId = bundle.packetId ?? 'not-persisted';
  if (!steering.includes(`CONTEXT_PACKET_ID: ${packetId}`)) return false;
  // Escape-free counting: the previous literal here held a real backspace byte where the
  // word boundary belonged, so it never matched a canonical item and every reduced
  // projection of this bundle was rejected and re-substituted with the full block.
  const opening = steering.split('<context_item').length - 1;
  const closing = steering.split('</context_item>').length - 1;
  return opening === closing;
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
