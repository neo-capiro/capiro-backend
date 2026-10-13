export interface TrackerActionChange {
  changeType: string;
  triggerKey: string;
  label: string;
  tone: 'success' | 'critical' | 'notable' | 'info';
  severity: 'info' | 'notable' | 'critical';
}

/** A single bill action (DB row or the bill's rollup latest action). */
export interface TrackerMaterialAction {
  date: Date | null;
  text: string | null;
  chamber?: string | null;
}

/** A distinct material change selected for one detection cycle. */
export interface TrackerMaterialEvent {
  cls: TrackerActionChange;
  text: string;
  date: Date | null;
  chamber?: string | null;
}

/**
 * Classify a tracked bill's action text into a material change, or null for
 * routine churn we don't alert on. Ordered most-significant first. Exported so
 * the change selector + unit tests share the exact same cascade.
 */
export function classifyTrackerActionText(nextText: string | null): TrackerActionChange | null {
  const t = (nextText ?? '').toLowerCase();
  if (!t) return null;
  return classifyHighPriorityAction(t) ?? classifyScheduledAndCommitteeAction(t);
}

/** Enactment, presidential delivery, measure failure and chamber passage take precedence. */
function classifyHighPriorityAction(t: string): TrackerActionChange | null {
  if (/became (public )?law|public law no|signed by (the )?president|enacted/.test(t))
    return {
      changeType: 'bill_enacted',
      triggerKey: 'enactedFailed',
      label: 'Became law',
      tone: 'success',
      severity: 'critical',
    };
  if (/presented to (the )?president|cleared for white house/.test(t))
    return {
      changeType: 'bill_to_president',
      triggerKey: 'enactedFailed',
      label: 'Sent to President',
      tone: 'success',
      severity: 'critical',
    };
  // GAI-07: bill_failed requires MEASURE-level failure context. The old bare
  // /failed|rejected|veto|tabled/ classified a failed procedural MOTION
  // ("Motion to recommit failed", "Cloture motion rejected"), a failed
  // amendment, or passage text that merely mentions a veto THREAT as a
  // critical "Failed / rejected" alert for a bill that did not fail — and
  // this alert fans out to email/SMS. Now: failure of passage itself, a
  // rejected conference report, tabling of the MEASURE, or an actual veto.
  if (
    /failed of passage|failed passage|on passage[^.]*(failed|rejected)|conference report[^.]*rejected|motion to table (the )?(bill|resolution|measure|h\.? ?r|s\.)[^.]*agreed|vetoed by (the )?president|veto message received|pocket veto/.test(
      t,
    )
  )
    return {
      changeType: 'bill_failed',
      triggerKey: 'enactedFailed',
      label: 'Failed / rejected',
      tone: 'critical',
      severity: 'critical',
    };
  if (
    /passed\/agreed to in (the )?(house|senate)|passed (the )?(house|senate)|on passage[^.]*passed|agreed to in (the )?(house|senate)/.test(
      t,
    )
  )
    return {
      changeType: 'bill_passed_chamber',
      triggerKey: 'floorVote',
      label: 'Passed a chamber',
      tone: 'success',
      severity: 'notable',
    };
  return null;
}

/** Floor scheduling, committee activity, hearings and amendments follow the priority cascade. */
function classifyScheduledAndCommitteeAction(t: string): TrackerActionChange | null {
  // House Rules Committee activity: a special rule reported / granted means the
  // bill cleared Rules and is headed to the floor. Must precede bill_reported so
  // a rule resolution's "Reported to House" isn't mislabeled a committee report;
  // floor passage above still wins for a combined "...under the rule and passed".
  if (
    /rules committee|committee on rules|provides for consideration|considered under the provisions|pursuant to (the provisions of )?(h\.? ?res|house resolution)|(closed|structured|open|special) rule/.test(
      t,
    )
  )
    return {
      changeType: 'bill_rule_reported',
      triggerKey: 'floorVote',
      label: 'Rule granted (floor scheduled)',
      tone: 'info',
      severity: 'notable',
    };
  if (/placed on (the )?(union |senate )?calendar|scheduled for (floor|consideration)/.test(t))
    return {
      changeType: 'bill_floor_scheduled',
      triggerKey: 'floorVote',
      label: 'Floor action scheduled',
      tone: 'info',
      severity: 'notable',
    };
  if (
    /ordered to be reported|reported (by|to|favorably)|committee agreed to seek consideration/.test(
      t,
    )
  )
    return {
      changeType: 'bill_reported',
      triggerKey: 'committeeVote',
      label: 'Passed committee',
      tone: 'success',
      severity: 'notable',
    };
  if (/markup|marked up|committee consideration and mark/.test(t))
    return {
      changeType: 'bill_markup',
      triggerKey: 'committeeVote',
      label: 'Markup',
      tone: 'info',
      severity: 'notable',
    };
  if (/hearing/.test(t))
    return {
      changeType: 'bill_hearing',
      triggerKey: 'hearing',
      label: 'Hearing scheduled',
      tone: 'info',
      severity: 'info',
    };
  if (/amendment|amended|substitute/.test(t))
    return {
      changeType: 'bill_amendment',
      triggerKey: 'amendment',
      label: 'Amended',
      tone: 'notable',
      severity: 'notable',
    };
  return null;
}

/**
 * Given a tracked bill's NEW actions since its snapshot (already filtered to
 * strictly-newer-than `lastSeenActionDate`) plus the bill's rollup latest
 * action, return the distinct material changes to alert on — one per changeType,
 * in chronological order.
 *
 * `latest` is always merged in so we never regress below the legacy
 * latest-action-only behavior when action rows are missing or stale. De-duping
 * by changeType means a burst that crosses several stages alerts each stage
 * once; the caller's NotificationLog/IntelligenceChange dedupe is the backstop
 * across runs.
 */
export function selectTrackerMaterialEvents(
  actions: TrackerMaterialAction[],
  latest: TrackerMaterialAction | null,
): TrackerMaterialEvent[] {
  const merged: TrackerMaterialAction[] = [...actions];
  if (latest && latest.text) {
    const dup = merged.some(
      (a) =>
        (a.text ?? '') === (latest.text ?? '') &&
        (a.date?.getTime() ?? 0) === (latest.date?.getTime() ?? 0),
    );
    if (!dup) merged.push(latest);
  }
  merged.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));

  const out: TrackerMaterialEvent[] = [];
  const seen = new Set<string>();
  for (const a of merged) {
    const cls = classifyTrackerActionText(a.text);
    if (!cls) continue;
    if (seen.has(cls.changeType)) continue;
    seen.add(cls.changeType);
    out.push({ cls, text: a.text ?? '', date: a.date, chamber: a.chamber ?? null });
  }
  return out;
}
