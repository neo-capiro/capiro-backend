import type { OutreachCommandType } from '../state/outreach-command.contract.js';

/**
 * Canonical example payloads shown to the reasoning model for command types it
 * must synthesize from scratch (free text or a closed enum), rather than copy
 * verbatim from a referenced Capiro read-tool result.
 *
 * Root cause this exists to fix: with no payload shape in the prompt, the
 * live gpt-4.1-mini reasoning model was observed emitting payloads such as
 * `{"type":"SET_TONE","schemaVersion":1,"phaseOwner":"campaign_state","payload":{"tone":"..."}}`
 * or even `{"type":"SET_CAMPAIGN_ANGLE","schemaVersion":1,"phaseOwner":"campaign_state","angle":"..."}`
 * with no "payload" wrapper at all -- guessing a different, wrong key name
 * (and stray catalog metadata) on every call. Every one of those shapes fails
 * `parseOutreachCommandEnvelope`'s strict Zod schemas, which is the intended,
 * correct, fail-closed behavior. The fix is giving the model an accurate
 * template to imitate, not loosening what gets accepted.
 *
 * Deliberately excluded:
 *  - ADD_TARGET_REFS, REMOVE_TARGET_REFS, REJECT_TARGET_RECOMMENDATION,
 *    ACCEPT_CONTEXT_REFS, EXCLUDE_CONTEXT_REFS: their payloads must be the
 *    exact locator/selection/recommendationRef objects returned by a
 *    referenced read tool (enforced by assertCommandsGrounded in
 *    OutreachReasoningService). Showing a canned example here would invite
 *    the model to fabricate a plausible-looking but ungrounded substitute.
 *  - SET_TARGET_CRITERIA, SET_SPONSOR_SCOPE: payload shape/validity depends on
 *    campaign-specific conditional rules (sponsor kind <-> clientRefs count,
 *    coalition label, etc.) that a single illustrative example would
 *    misrepresent more than it would help.
 *  - ADD_STYLE_SAMPLES, REMOVE_STYLE_SAMPLES: user-authored-only commands,
 *    already excluded from the model-visible catalog entirely.
 *
 * `outreach-reasoning-command-examples.spec.ts` parses every entry here
 * through the real `parseOutreachCommandEnvelope`, so a schema change that
 * invalidates an example fails CI instead of silently reaching production.
 */
export const OUTREACH_REASONING_COMMAND_EXAMPLE_PAYLOADS: Partial<
  Record<OutreachCommandType, Record<string, unknown>>
> = {
  SET_GOAL: { value: 'Example: Build bipartisan support for the appropriations rider protecting the program.' },
  SET_OBJECTIVE: { value: 'Example: Secure a 20-minute staff briefing before markup.' },
  SET_TOPIC: { value: 'Example: FY27 appropriations rider' },
  SET_DESIRED_OUTCOME: { value: 'Example: Staff agrees to review the one-pager before markup.' },
  SET_ASK: { mode: 'explicit', text: 'Example: Request a 20-minute staff briefing before markup.' },
  CLEAR_ASK: {},
  SET_WHY_NOW: { value: 'Example: Markup is scheduled in three weeks.' },
  SET_DELIVERY_PATTERN: { value: 'personalized_separate' },
  SET_PERSONALIZATION: { value: 'high' },
  SET_CAMPAIGN_ANGLE: {
    value: 'Example: Position this as protecting jobs and national security in the district.',
  },
  SET_TONE: { value: 'Example: Professional, respectful, and direct.' },
  SET_LENGTH: { value: 'short', customInstruction: null },
  RESTORE_STATE_VERSION: { version: 4 },
};
