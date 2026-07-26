/**
 * Alert notification types + gates (Phase 4, plan §7) — ported from
 * apps/api/src/tracker/notifications/tracker-notification.types.ts +
 * tracker-alert.service.ts (quiet-hours helpers). Pure, side-effect-free.
 */
export type AlertSeverity = 'critical' | 'notable' | 'info';

export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 1, notable: 2, critical: 3 };
export const MATERIALITY_RANK: Record<'low' | 'medium' | 'high', number> = {
  low: 1,
  medium: 2,
  high: 3,
};

/** Does this event clear the user's materiality floor? */
export function clearsMateriality(severity: AlertSeverity, materiality: string): boolean {
  const floor = MATERIALITY_RANK[(materiality as 'low' | 'medium' | 'high') ?? 'medium'] ?? 2;
  return SEVERITY_RANK[severity] >= floor;
}

/** One material change ready to fan out (mirrors legacy TrackerAlertEvent + score/band). */
export interface IntelAlertEvent {
  tenantId: string;
  clientId: string;
  /** Client display name, resolved from `clients` for the email subject + "why this matters" header (optional — omitted rather than blocking on lookup failure). */
  clientName?: string | null;
  /**
   * The intel_alert ROW id, when this event came from a persisted row. Used as
   * the notification-log claim key so each occurrence dedups independently (a
   * changeType recurring after the 14-day window still delivers) while the same
   * row can never double-send. Absent for the synthetic shadow self-test.
   */
  alertRowId?: string;
  billId: string;
  displayNum: string;
  billTitle: string;
  changeType: string;
  triggerKey: string;
  label: string;
  /** Display tone for the email pill/accent color (`ev.cls.tone` from the detector). Optional — unknown tone just falls back to the brand color. */
  tone?: string;
  severity: AlertSeverity;
  detail: string;
  actionDate: string | null;
  url: string;
  why?: string | null;
  matchedTags?: string[];
  score?: number;
  band?: string;
  /** 'US' | <state code> (State Legislation Platform, DD5). Defaults to 'US' when absent — every pre-Phase-0 event stays federal-only. */
  jurisdiction?: string;
  /** LLM "what happened" paraphrase. Populated at emit time by `fanOut` (for
   *  deliverable events only) via `AlertSummaryClient`, which delegates to
   *  apps/api's TrackerSummaryService. Null/absent when disabled, unresolved, or
   *  on any failure — the email simply omits the "What happened" line. */
  summary?: string | null;
  /** The in-app LegiWatch deep link. Distinct from `url`, which is the OFFICIAL source (P1-06). */
  appUrl?: string;
  /** 'bill' | 'state_bill' | 'hearing' | 'combined' | 'regulation' | 'program_element' — selects the email renderer (P1-07). */
  sourceType?: string;
}

/** Parse "HH:MM" to minutes-since-midnight, or null. */
export function toMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Current minutes-since-midnight in America/New_York (the firm's working tz). */
export function nowEtMinutes(now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

/** True when the ET clock is inside [start,end), handling midnight wrap. */
export function isWithinQuietHours(start: string | null, end: string | null, now?: Date): boolean {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s == null || e == null) return false;
  const cur = nowEtMinutes(now);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}
