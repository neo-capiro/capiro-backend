/**
 * How a generated draft names the person it is addressed to, and two small
 * helpers the Send step shares with it.
 *
 * Extracted from `outreach-v3-phase1-shared.tsx` when the prototype-parity
 * builder replaced the phase-1 workspaces: these are the only pieces of that
 * module the new flow needs, and leaving them there would have kept the whole
 * superseded island alive to serve three functions.
 */
import type { OutreachV3DraftArtifact, OutreachV3GenerationPlan } from './engagement-api.js';

export interface RecipientPresentation {
  label: string;
  subtitle: string;
  email: string | null;
}

/** The last-resort name for a draft: a key, shown only when nothing better exists. */
export function recipientLabel(draft: OutreachV3DraftArtifact): string {
  return draft.current?.recipientKey || draft.recipientKey || draft.generationKey;
}

/**
 * The recipient's real name, organization and address for a draft.
 *
 * Reads the generation plan's own field names — `displayName`, `organization`,
 * `chamber`, `email` — because the server's plan payload has no `label` or
 * `targetType`. Reading fields that do not exist is what once made every
 * recipient display as a raw locator like "directory_member:member-3055"; see
 * `outreach-recipient-presentation.test.ts`.
 */
export function recipientPresentation(
  draft: OutreachV3DraftArtifact,
  plan?: OutreachV3GenerationPlan | null,
): RecipientPresentation {
  const slot = plan?.slots.find((candidate) => candidate.generationKey === draft.generationKey);
  const recipient = slot?.recipients[0];
  return {
    label: recipient?.displayName?.trim() || recipientLabel(draft),
    subtitle:
      recipient?.organization?.trim() ||
      recipient?.chamber?.trim() ||
      recipient?.email ||
      'Campaign recipient',
    email: recipient?.email ?? null,
  };
}

/** A date and time for a recorded event. "Not recorded" when there is none. */
export function formatDateTime(value?: string | null): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** A wall-clock time for "Last checked …". Falls back to "now" on a bad value. */
export function formatClock(value?: Date | string | null): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 'now';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
}

/**
 * An idempotency key for a one-off operation (a test send). `crypto.randomUUID`
 * is absent in some non-secure contexts, so the fallback keeps the key unique
 * rather than letting the call fail.
 */
export function randomKey(prefix: string): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}
