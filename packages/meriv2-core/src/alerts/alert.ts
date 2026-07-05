/**
 * The ONE canonical alert shape (MeriV2 Phase-1, SC1.1).
 *
 * Tracker, Intelligence, and the web changes-inbox all render THIS type — not
 * their own per-surface shapes — so every alert answers the same seven
 * questions and no surface can invent a divergent "almost-alert". Constructing
 * an alert routes through `buildAlert`, which FLAGS missing required fields
 * rather than silently dropping them (SC1.2): a half-populated alert is still
 * returned, marked incomplete, so the UI shows the gap instead of hiding it.
 *
 * This is the shared TYPE + completeness contract only. Persisting/delivering
 * alerts, and the dedupe/freshness taxonomy, are the surrounding Workstream-E
 * consolidation work; this module is deliberately pure and DB-free.
 */

export interface Alert {
  /** What changed — the underlying event, in plain language. Required. */
  whatChanged: string;
  /** Why it matters to THIS client. Required. */
  whyItMatters: string;
  /** The client this alert is for. Required. */
  clientId: string;
  /** The issue / interest area it maps to. Required. */
  issueId: string;
  /** Who should act (role or person). Required. */
  whoActs: string;
  /** Optional action deadline (ISO-8601 date/datetime); null when none. */
  deadline?: string | null;
  /** Optional drafted artifact (memo/email) prepared for the action. */
  draftArtifactId?: string | null;
  /** Optional compliance-check id gating any action taken from this alert. */
  complianceCheckId?: string | null;
}

/** The five fields an alert MUST have to be actionable (SC1.2). */
export const REQUIRED_ALERT_FIELDS = [
  'whatChanged',
  'whyItMatters',
  'clientId',
  'issueId',
  'whoActs',
] as const;

export type RequiredAlertField = (typeof REQUIRED_ALERT_FIELDS)[number];

export interface AlertBuildResult {
  /** The normalized alert. Present even when incomplete — never dropped. */
  alert: Alert;
  /** Required fields that were absent/blank — surfaced, never swallowed. */
  missingFields: RequiredAlertField[];
  /** True iff no required field is missing. */
  complete: boolean;
}

/**
 * Build a canonical `Alert`, FLAGGING (not dropping) any missing required field.
 * A blank/whitespace/absent required value is recorded in `missingFields` and
 * the alert is still returned (with that field as an empty string) so the caller
 * can render it marked-incomplete. Optional fields normalize to `null` when
 * absent. Never throws.
 */
export function buildAlert(input: Partial<Alert>): AlertBuildResult {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const optId = (v: unknown): string | null => {
    const s = str(v);
    return s.length > 0 ? s : null;
  };

  const alert: Alert = {
    whatChanged: str(input.whatChanged),
    whyItMatters: str(input.whyItMatters),
    clientId: str(input.clientId),
    issueId: str(input.issueId),
    whoActs: str(input.whoActs),
    deadline: optId(input.deadline),
    draftArtifactId: optId(input.draftArtifactId),
    complianceCheckId: optId(input.complianceCheckId),
  };

  const missingFields = REQUIRED_ALERT_FIELDS.filter((field) => alert[field].length === 0);
  return { alert, missingFields, complete: missingFields.length === 0 };
}

/** Convenience: true iff every required field is present. */
export function isAlertComplete(input: Partial<Alert>): boolean {
  return buildAlert(input).complete;
}
