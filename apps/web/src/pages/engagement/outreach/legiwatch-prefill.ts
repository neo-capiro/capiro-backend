/**
 * Reader for the LegiWatch "Stage outreach" cross-surface handoff.
 *
 * HearingActions.tsx (LegiWatch) writes sessionStorage['lw:outreach-context']
 * — { prefill, createdAt } — then navigates to
 * /engagement/outreach?source=legiwatch&hearingId=…&client=… . This module is
 * the single consumer: it validates the payload and maps the staged prefill
 * (built server-side by LegiWatchWave1Service.buildOutreachPrefill) into the
 * New Outreach campaign wizard's workflow state.
 *
 * Cross-surface-handoff rule: fail loudly. If the key is present but stale or
 * malformed, surface an error to the user instead of silently dropping into a
 * blank wizard — the user explicitly clicked "Stage outreach" and expects the
 * context to carry over.
 */

export const LW_OUTREACH_CONTEXT_KEY = 'lw:outreach-context';

// One hour: a staged prefill older than this is stale — the hearing may have
// rescheduled or the client lens changed. Refuse rather than silently use it.
const MAX_AGE_MS = 60 * 60 * 1000;

export interface LegiWatchPrefillContext {
  hearing?: {
    id?: string;
    title?: string;
    committeeName?: string | null;
    chamber?: string | null;
    calendarDate?: string;
    detailPath?: string;
  } | null;
  finding?: { id?: string; title?: string; summary?: string | null; evidenceText?: string | null } | null;
  transcriptMoment?: { id?: string; text?: string | null; speakerLabel?: string | null } | null;
}

export interface LegiWatchOutreachPrefill {
  clientId: string;
  clientName?: string | null;
  context?: LegiWatchPrefillContext;
}

export interface LegiWatchHandoff {
  prefill: LegiWatchOutreachPrefill;
  createdAt: number;
}

export type LegiWatchHandoffResult =
  | { ok: true; handoff: LegiWatchHandoff }
  | { ok: false; reason: 'malformed' | 'stale' | 'client-mismatch'; message: string };

/** Read and VALIDATE the handoff. Does not clear the key. */
export function readLegiWatchHandoff(expectedClientId: string | null): LegiWatchHandoffResult {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(LW_OUTREACH_CONTEXT_KEY);
  } catch {
    return { ok: false, reason: 'malformed', message: 'Session storage is unavailable.' };
  }
  if (!raw) return { ok: false, reason: 'malformed', message: 'No staged outreach context found.' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: 'malformed',
      message: 'The staged outreach context is unreadable. Please stage the outreach again from LegiWatch.',
    };
  }

  const handoff = parsed as Partial<LegiWatchHandoff> | null;
  const prefill = handoff?.prefill;
  if (
    !handoff ||
    typeof handoff.createdAt !== 'number' ||
    !prefill ||
    typeof prefill.clientId !== 'string' ||
    !prefill.clientId
  ) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'The staged outreach context is incomplete. Please stage the outreach again from LegiWatch.',
    };
  }

  if (Date.now() - handoff.createdAt > MAX_AGE_MS) {
    return {
      ok: false,
      reason: 'stale',
      message: 'The staged outreach context has expired. Please stage the outreach again from LegiWatch.',
    };
  }

  if (expectedClientId && prefill.clientId !== expectedClientId) {
    return {
      ok: false,
      reason: 'client-mismatch',
      message: 'The staged outreach context belongs to a different client. Please stage the outreach again from LegiWatch.',
    };
  }

  return { ok: true, handoff: handoff as LegiWatchHandoff };
}

/** Consume (read + clear) the handoff. */
export function consumeLegiWatchHandoff(expectedClientId: string | null): LegiWatchHandoffResult {
  const result = readLegiWatchHandoff(expectedClientId);
  try {
    sessionStorage.removeItem(LW_OUTREACH_CONTEXT_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
  return result;
}

/**
 * Map the staged prefill into campaign-wizard workflow state: the client is
 * preselected and the hearing context is attached to the objective/subject so
 * the user reviews a grounded starting point, not a blank form. Sending stays
 * an explicit, separate user decision (the prefill's autoSend is always false).
 */
export function prefillToWorkflowPatch(
  prefill: LegiWatchOutreachPrefill,
): {
  clientId: string;
  objective: string;
  subject: string;
} {
  const hearing = prefill.context?.hearing;
  const finding = prefill.context?.finding;
  const moment = prefill.context?.transcriptMoment;

  const hearingLabel = hearing ? [hearing.committeeName, hearing.calendarDate].filter(Boolean).join(' · ') : '';
  const contextLines = [
    hearing?.title ? `Hearing: ${hearing.title}${hearingLabel ? ` (${hearingLabel})` : ''}` : null,
    finding?.title ? `Finding: ${finding.title}` : null,
    finding?.summary ?? finding?.evidenceText ?? null,
    moment?.text ? `Transcript moment${moment.speakerLabel ? ` — ${moment.speakerLabel}` : ''}: ${moment.text}` : null,
  ].filter(Boolean) as string[];

  return {
    clientId: prefill.clientId,
    objective: contextLines.join('\n\n'),
    subject: finding?.title || hearing?.title || 'LegiWatch outreach',
  };
}
