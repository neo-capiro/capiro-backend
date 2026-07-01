/**
 * Pure change classification (Phase 3, plan §6.3) — ported VERBATIM from
 * apps/api/src/tracker/tracker-change-detector.service.ts (`classifyChange`,
 * `selectMaterialEvents`) so the shadow detector byte-matches legacy for the
 * Phase 5 parity gate. No side effects, no DB — unit-testable in isolation.
 *
 * Correction carried from plan §6.3: `bill_rule_reported` → triggerKey
 * `floorVote` (matches source lines 79–80; the registry's `committeeVote` is
 * wrong).
 */
export type ChangeTone = 'success' | 'critical' | 'notable' | 'info';
export type AlertSeverity = 'info' | 'notable' | 'critical';

export interface ChangeClass {
  changeType: string;
  triggerKey: string;
  label: string;
  tone: ChangeTone;
  severity: AlertSeverity;
}

/**
 * Classify a tracked bill's action text into a material change, or null for
 * routine churn we don't alert on. Ordered most-significant-first.
 */
export function classifyChange(nextText: string | null): ChangeClass | null {
  const t = (nextText ?? '').toLowerCase();
  if (!t) return null;
  if (/became (public )?law|public law no|signed by (the )?president|enacted/.test(t))
    return { changeType: 'bill_enacted', triggerKey: 'enactedFailed', label: 'Became law', tone: 'success', severity: 'critical' };
  if (/presented to (the )?president|cleared for white house/.test(t))
    return { changeType: 'bill_to_president', triggerKey: 'enactedFailed', label: 'Sent to President', tone: 'success', severity: 'critical' };
  if (/failed|rejected|motion to table agreed|veto|tabled/.test(t))
    return { changeType: 'bill_failed', triggerKey: 'enactedFailed', label: 'Failed / rejected', tone: 'critical', severity: 'critical' };
  if (/passed\/agreed to in (the )?(house|senate)|passed (the )?(house|senate)|on passage[^.]*passed|agreed to in (the )?(house|senate)/.test(t))
    return { changeType: 'bill_passed_chamber', triggerKey: 'floorVote', label: 'Passed a chamber', tone: 'success', severity: 'notable' };
  if (/rules committee|committee on rules|provides for consideration|considered under the provisions|pursuant to (the provisions of )?(h\.? ?res|house resolution)|(closed|structured|open|special) rule/.test(t))
    return { changeType: 'bill_rule_reported', triggerKey: 'floorVote', label: 'Rule granted (floor scheduled)', tone: 'info', severity: 'notable' };
  if (/placed on (the )?(union |senate )?calendar|scheduled for (floor|consideration)/.test(t))
    return { changeType: 'bill_floor_scheduled', triggerKey: 'floorVote', label: 'Floor action scheduled', tone: 'info', severity: 'notable' };
  if (/ordered to be reported|reported (by|to|favorably)|committee agreed to seek consideration/.test(t))
    return { changeType: 'bill_reported', triggerKey: 'committeeVote', label: 'Passed committee', tone: 'success', severity: 'notable' };
  if (/markup|marked up|committee consideration and mark/.test(t))
    return { changeType: 'bill_markup', triggerKey: 'committeeVote', label: 'Markup', tone: 'info', severity: 'notable' };
  if (/hearing/.test(t))
    return { changeType: 'bill_hearing', triggerKey: 'hearing', label: 'Hearing scheduled', tone: 'info', severity: 'info' };
  if (/amendment|amended|substitute/.test(t))
    return { changeType: 'bill_amendment', triggerKey: 'amendment', label: 'Amended', tone: 'notable', severity: 'notable' };
  return null;
}

export interface ActionLike {
  date: Date | null;
  text: string | null;
}
export interface MaterialEvent {
  cls: ChangeClass;
  text: string;
  date: Date | null;
}

/**
 * Given a bill's NEW actions since its snapshot plus the rollup latest action,
 * return the distinct material changes (one per changeType, chronological). The
 * latest action is always merged in so we never regress below latest-action-only.
 */
export function selectMaterialEvents(actions: ActionLike[], latest: ActionLike | null): MaterialEvent[] {
  const merged: ActionLike[] = [...actions];
  if (latest && latest.text) {
    const dup = merged.some(
      (a) => (a.text ?? '') === (latest.text ?? '') && (a.date?.getTime() ?? 0) === (latest.date?.getTime() ?? 0),
    );
    if (!dup) merged.push(latest);
  }
  merged.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));

  const out: MaterialEvent[] = [];
  const seen = new Set<string>();
  for (const a of merged) {
    const cls = classifyChange(a.text);
    if (!cls) continue;
    if (seen.has(cls.changeType)) continue;
    seen.add(cls.changeType);
    out.push({ cls, text: a.text ?? '', date: a.date });
  }
  return out;
}

/** Placeholder materiality until the Phase 4 AlertScorer computes it. */
export function severityToMateriality(sev: AlertSeverity): 'low' | 'medium' | 'high' {
  return sev === 'critical' ? 'high' : sev === 'notable' ? 'medium' : 'low';
}
