import type { ChangeTone } from '../tracker.types.js';

export type AlertSeverity = 'critical' | 'notable' | 'info';

/** A single material change on a tracked bill, ready to fan out to channels. */
export interface TrackerAlertEvent {
  tenantId: string;
  clientId: string;
  clientName?: string | null;
  billId: string;
  displayNum: string;
  billTitle: string;
  /** Detection rule that fired, e.g. 'bill_passed_chamber' | 'amendment' | 'new_match'. */
  changeType: string;
  /** Maps to an AlertPreference.triggers entry (newMatch/amendment/hearing/...). */
  triggerKey: string;
  /** Human label, e.g. "Passed a chamber". */
  label: string;
  tone: ChangeTone;
  severity: AlertSeverity;
  /** Latest action text / change detail. */
  detail: string;
  actionDate: string | null;
  /** Deep link back to the client-profile Tracker board. */
  url: string;
}

export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 1,
  notable: 2,
  critical: 3,
};

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
