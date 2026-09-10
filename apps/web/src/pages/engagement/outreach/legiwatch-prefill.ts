import type { SelectedContextItem } from './v2/types.js';

export const LW_OUTREACH_CONTEXT_KEY = 'lw:outreach-context';
const MAX_AGE_MS = 60 * 60 * 1000;

export interface LegiWatchOutreachPrefill {
  clientId: string;
  clientName: string;
  status: 'staged';
  autoSend: false;
  context: {
    hearing: { id: string; title: string; committeeName?: string | null; calendarDate?: string };
    finding?: { id: string; title: string; summary?: string | null; evidenceText?: string | null } | null;
    transcriptMoment?: { id: string; text: string; speakerLabel?: string | null } | null;
  };
}

export interface LegiWatchHandoff {
  id: string;
  prefill: LegiWatchOutreachPrefill;
  createdAt: number;
}

type FailureReason = 'malformed' | 'stale' | 'client-mismatch' | 'hearing-mismatch' | 'handoff-mismatch';
export type LegiWatchHandoffResult =
  | { ok: true; handoff: LegiWatchHandoff }
  | { ok: false; reason: FailureReason; message: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function optionalText(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

/** Validate identities and every field rendered or forwarded into the wizard. */
export function validateLegiWatchPrefill(
  value: unknown,
  expectedClientId: string | null,
  expectedHearingId: string | null,
): value is LegiWatchOutreachPrefill {
  if (!record(value) || !text(value.clientId) || !text(value.clientName) ||
      value.status !== 'staged' || value.autoSend !== false || !record(value.context)) return false;
  const { hearing, finding, transcriptMoment } = value.context;
  if (!record(hearing) || !text(hearing.id) || !text(hearing.title) ||
      !optionalText(hearing.committeeName) || !optionalText(hearing.calendarDate)) return false;
  if (value.clientId !== expectedClientId || hearing.id !== expectedHearingId) return false;
  if (finding != null && (!record(finding) || !text(finding.id) || !text(finding.title) ||
      !optionalText(finding.summary) || !optionalText(finding.evidenceText))) return false;
  if (transcriptMoment != null && (!record(transcriptMoment) || !text(transcriptMoment.id) ||
      !text(transcriptMoment.text) || !optionalText(transcriptMoment.speakerLabel))) return false;
  return true;
}

/** Keep the staged handoff until save/cancel so a reload can revalidate it. */
export function readLegiWatchHandoff(
  expectedClientId: string | null,
  expectedHearingId: string | null,
  expectedHandoffId: string | null,
): LegiWatchHandoffResult {
  const fail = (reason: FailureReason, message: string): LegiWatchHandoffResult => ({ ok: false, reason, message });
  let parsed: unknown;
  try {
    parsed = JSON.parse(sessionStorage.getItem(LW_OUTREACH_CONTEXT_KEY) ?? 'null');
  } catch {
    return fail('malformed', 'The hearing details could not be opened. Stage outreach again from LegiWatch.');
  }
  if (!record(parsed) || typeof parsed.createdAt !== 'number' || !Number.isFinite(parsed.createdAt)) {
    return fail('malformed', 'No usable hearing details were found. Stage outreach again from LegiWatch.');
  }
  if (!text(expectedHandoffId) || parsed.id !== expectedHandoffId) {
    return fail('handoff-mismatch', 'Another hearing outreach was staged. Return to LegiWatch and open the outreach you want to review.');
  }
  const age = Date.now() - parsed.createdAt;
  if (age < -60_000 || age > MAX_AGE_MS) {
    return fail('stale', 'The hearing details have expired. Stage outreach again from LegiWatch.');
  }
  if (!text(expectedClientId) || !text(expectedHearingId) || !record(parsed.prefill)) {
    return fail('malformed', 'The hearing or client is missing. Stage outreach again from LegiWatch.');
  }
  if (parsed.prefill.clientId !== expectedClientId) {
    return fail('client-mismatch', 'These hearing details belong to a different client. Stage outreach again from LegiWatch.');
  }
  const context = parsed.prefill.context;
  if (record(context) && record(context.hearing) && context.hearing.id !== expectedHearingId) {
    return fail('hearing-mismatch', 'These details belong to a different hearing. Stage outreach again from LegiWatch.');
  }
  if (!validateLegiWatchPrefill(parsed.prefill, expectedClientId, expectedHearingId)) {
    return fail('malformed', 'The hearing details are incomplete. Stage outreach again from LegiWatch.');
  }
  return { ok: true, handoff: { id: expectedHandoffId, prefill: parsed.prefill, createdAt: parsed.createdAt } };
}

export function clearLegiWatchHandoff(id: string): void {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(LW_OUTREACH_CONTEXT_KEY) ?? 'null');
    // Saving an earlier hearing must not erase a newly staged one.
    if (record(stored) && stored.id === id) sessionStorage.removeItem(LW_OUTREACH_CONTEXT_KEY);
  } catch { /* An unavailable or malformed handoff cannot be resumed. */ }
}

export interface LegiWatchWizardPrefill {
  clientId: string;
  campaignName: string;
  mainIdea: string;
  contextItems: SelectedContextItem[];
}

export function prefillToWizardState(prefill: LegiWatchOutreachPrefill): LegiWatchWizardPrefill {
  const { hearing, finding, transcriptMoment: moment } = prefill.context;
  const heading = [hearing.committeeName, hearing.calendarDate].filter(Boolean).join(' · ');
  const content = [
    `Hearing: ${hearing.title}${heading ? ` (${heading})` : ''}`,
    finding ? `Finding: ${finding.title}` : null,
    finding?.summary || finding?.evidenceText,
    moment ? `Transcript moment${moment.speakerLabel ? ` — ${moment.speakerLabel}` : ''}: ${moment.text}` : null,
  ].filter(Boolean).join('\n\n');
  const source = `Source: /legiwatch/hearings/${encodeURIComponent(hearing.id)}`;
  // The existing generation DTO accepts at most 8,000 characters per note.
  // Keep the hearing link and disclose an excerpt instead of causing a 400.
  const limit = 8000 - source.length - 80;
  const excerpt = content.length > limit ? `${content.slice(0, limit)}\n\nExcerpt; open the hearing for the full details.` : content;
  const body = `${excerpt}\n\n${source}`;
  return {
    clientId: prefill.clientId,
    campaignName: (finding?.title || hearing.title).slice(0, 240),
    mainIdea: `Follow up on ${finding?.title || hearing.title}. Review the attached hearing details before drafting.`,
    contextItems: [{
      id: `legiwatch:${hearing.id}:${finding?.id || moment?.id || 'hearing'}`,
      kind: 'note',
      title: `Hearing: ${hearing.title}`.slice(0, 240),
      body,
      note: body,
      noteUse: 'fact',
      scope: 'all',
      clientId: prefill.clientId,
      clientName: prefill.clientName,
    }],
  };
}
