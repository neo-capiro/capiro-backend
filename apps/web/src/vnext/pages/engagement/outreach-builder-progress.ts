/**
 * "Save progress at any stage, resume where I left off" — client-side
 * remembers the last builder step a user was standing on for a given
 * campaign, so reopening the campaign lands there instead of always
 * restarting at step 1 (Campaign type).
 *
 * WHY THIS IS THE RIGHT-SIZED FIX, NOT A NEW SERVER FIELD
 *
 * Every step's actual DATA is already durably saved server-side: confirming
 * a step sends a real command batch that creates a new immutable Campaign
 * Spec version (see `outreach-builder-model.ts`'s header comment and every
 * step's own "Every confirmed change creates a new immutable Campaign Spec
 * version" footer note). Nothing the user has typed and confirmed is ever
 * at risk of loss — that part of "save progress" already works.
 *
 * What was actually broken: `VNextEngagementRoutes` always initialized the
 * builder's step state to `'workflow'` (step 1) and reset it to `'workflow'`
 * on every campaign-id change, with no memory of where the user last stood.
 * A user who worked through Targets, Context and Review, then left and came
 * back, was dropped back at Campaign type — technically lossless (the rail
 * is clickable in both directions, per `VNextOutreachCampaignBuilder`'s own
 * "Rail reachability" doc comment), but a real regression from "continue
 * where I left off" to "start the tour over every time."
 *
 * The builder step itself has no server-side field to persist against — it
 * is a UI navigation cursor over an already-durable spec, not campaign data.
 * `localStorage` (not `sessionStorage`) is deliberate: it survives closing
 * and reopening the browser tab/window, which sessionStorage would not — the
 * user's report was specifically about coming back to a campaign later, not
 * just switching tabs within one browsing session.
 */
import type { OutreachBuilderStep } from './outreach-campaign-flow.js';

const KEY_PREFIX = 'capiro.outreach-v3.builder-step.';

const VALID_STEPS = new Set<OutreachBuilderStep>([
  'workflow',
  'name',
  'update',
  'format',
  'targets',
  'context',
  'review',
  'drafts',
  'send',
]);

function isValidStep(value: unknown): value is OutreachBuilderStep {
  return typeof value === 'string' && VALID_STEPS.has(value as OutreachBuilderStep);
}

export function outreachBuilderProgressKey(sessionId: string): string {
  return `${KEY_PREFIX}${sessionId}`;
}

/**
 * The step the user last stood on for this campaign, or `null` when nothing
 * is stored (first visit, storage unavailable, or a corrupted/legacy value).
 * Fails closed to `null` rather than throwing — a storage read failure (e.g.
 * private browsing) must not break opening the campaign.
 */
export function readOutreachBuilderProgress(sessionId: string): OutreachBuilderStep | null {
  if (!sessionId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(outreachBuilderProgressKey(sessionId));
    return isValidStep(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Records the step as the campaign's resume point. Called on every step
 * change (both explicit rail clicks and a step's own "Continue" advance), so
 * whichever step the user is looking at when they navigate away is where
 * they land on return — not just the last step they confirmed.
 */
export function writeOutreachBuilderProgress(sessionId: string, step: OutreachBuilderStep): void {
  if (!sessionId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(outreachBuilderProgressKey(sessionId), step);
  } catch {
    // Best-effort only — losing the resume point is a minor inconvenience
    // (the user lands on step 1 instead of their last step), never a data
    // loss, since every confirmed field is already durable server-side.
  }
}

/**
 * Called when a campaign is archived or otherwise finished with, so a
 * future campaign that happens to reuse... nothing reuses a session id, but
 * clearing keeps `localStorage` from accumulating one entry per campaign
 * forever.
 */
export function clearOutreachBuilderProgress(sessionId: string): void {
  if (!sessionId || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(outreachBuilderProgressKey(sessionId));
  } catch {
    // Best-effort; a leftover key is harmless.
  }
}
