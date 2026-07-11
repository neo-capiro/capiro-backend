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
  | 'district_brief'
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
  sourceType: string; // 'bill' | 'hearing' | 'combined' | 'state_bill'
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
  // State Legislation Platform (S7): a state bill IS a bill for "open the
  // source" purposes (isBill), but the memo generator's DTO doesn't accept
  // sourceType='state_bill' yet (apps/api alert-memo.controller.ts @IsIn) —
  // memo drafting for state bills is out of Phase 0 scope, so it's excluded
  // below rather than offering a chip that 400s.
  const isBill =
    alert.sourceType === 'bill' ||
    alert.sourceType === 'combined' ||
    alert.sourceType === 'state_bill';
  const isHearing = alert.sourceType === 'hearing' || alert.sourceType === 'combined';
  // W4.4 (D-12): the memo generator is BILL-shaped — a 'regulation' alert has no
  // bill fields, so a "Draft client memo" chip on a regulation produced a memo
  // with null bill fields. Exclude regulation (minimal fix; a real rule-shaped
  // memo is a deferred feature). state_bill stays excluded (its DTO doesn't
  // accept the sourceType yet); bill/combined/hearing behavior is unchanged.
  const canMemo = alert.sourceType !== 'state_bill' && alert.sourceType !== 'regulation';
  const sessionId = sessionIdOf(alert.evidence);

  const actions: RecommendedAction[] = [];
  // Memo — primary on meaningful alerts, still offered (non-primary) on routine ones.
  if (canMemo)
    actions.push({ kind: 'draft_memo', label: 'Draft client memo', primary: meaningful });
  // District Impact Engine (Phase 1 M1.5) — works for a federal OR a state bill
  // alert alike (the composer resolves the client's facility + representation);
  // offered whenever the alert is bill-shaped. Whether the client actually has a
  // geocoded facility to ground it in is a UI-time check, not a feed-shape one —
  // same "always offer, let the composer degrade" pattern as draft_memo above.
  if (isBill) actions.push({ kind: 'district_brief', label: 'Generate district brief' });
  // Hearing-specific: jump to / copy the matched quotes.
  if (isHearing) actions.push({ kind: 'pull_quotes', label: 'Pull key quotes' });
  // Outreach: turn the development into a note to the Hill / client.
  actions.push({ kind: 'draft_outreach', label: 'Draft outreach' });
  // Curation.
  actions.push({ kind: 'add_talking_point', label: 'Add talking point' });
  actions.push({ kind: 'add_to_report', label: 'Add to weekly report' });
  // Navigate to the source.
  if (isBill && alert.sourceRef)
    actions.push({ kind: 'open_bill', label: 'Open bill', target: { billId: alert.sourceRef } });
  if (isHearing && sessionId)
    actions.push({ kind: 'open_hearing', label: 'Open hearing', target: { sessionId } });

  return actions;
}
