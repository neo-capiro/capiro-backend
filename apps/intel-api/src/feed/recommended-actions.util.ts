/**
 * Per-alert actionable recommendations (§ actionable-recommendations plan).
 *
 * Pure + deterministic: given an alert's shape, return the next actions an
 * analyst would take — memo when a memo fits, otherwise the right lighter action
 * (outreach, pull quotes, add to the weekly report, open the source). The
 * frontend renders these as chips; the primary one is the filled button.
 *
 * "Draft client memo" is offered on every alert (it is always a reasonable
 * response), but it is only the PRIMARY action on a meaningful (notable+) alert;
 * on routine/info alerts the lighter actions lead so we don't over-nudge.
 */

export type RecommendedActionKind =
  | 'draft_memo'
  | 'draft_outreach'
  | 'pull_quotes'
  | 'add_to_report'
  | 'add_talking_point'
  | 'open_bill'
  | 'open_hearing';

export interface RecommendedAction {
  kind: RecommendedActionKind;
  label: string;
  primary?: boolean;
  target?: { billId?: string; sessionId?: string };
}

export interface AlertShape {
  sourceType: string; // 'bill' | 'hearing' | 'combined'
  severity?: string | null; // 'critical' | 'notable' | 'info'
  sourceRef?: string | null;
  evidence?: unknown;
}

const MEANINGFUL = new Set(['critical', 'notable', 'high']);

function sessionIdOf(evidence: unknown): string | undefined {
  const ev = evidence as { sessionId?: string; hearing?: { sessionId?: string } } | null;
  return ev?.sessionId ?? ev?.hearing?.sessionId ?? undefined;
}

export function recommendedActionsFor(alert: AlertShape): RecommendedAction[] {
  const meaningful = MEANINGFUL.has((alert.severity ?? '').toLowerCase());
  const isBill = alert.sourceType === 'bill' || alert.sourceType === 'combined';
  const isHearing = alert.sourceType === 'hearing' || alert.sourceType === 'combined';
  const sessionId = sessionIdOf(alert.evidence);

  const actions: RecommendedAction[] = [];
  // Memo — primary on meaningful alerts, still offered (non-primary) on routine ones.
  actions.push({ kind: 'draft_memo', label: 'Draft client memo', primary: meaningful });
  // Hearing-specific: jump to / copy the matched quotes.
  if (isHearing) actions.push({ kind: 'pull_quotes', label: 'Pull key quotes' });
  // Outreach: turn the development into a note to the Hill / client.
  actions.push({ kind: 'draft_outreach', label: 'Draft outreach' });
  // Curation.
  actions.push({ kind: 'add_talking_point', label: 'Add talking point' });
  actions.push({ kind: 'add_to_report', label: 'Add to weekly report' });
  // Navigate to the source.
  if (isBill && alert.sourceRef) actions.push({ kind: 'open_bill', label: 'Open bill', target: { billId: alert.sourceRef } });
  if (isHearing && sessionId) actions.push({ kind: 'open_hearing', label: 'Open hearing', target: { sessionId } });

  return actions;
}
