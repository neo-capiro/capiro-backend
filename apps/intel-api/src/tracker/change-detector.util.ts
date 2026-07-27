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
import { stateBillStatusLabel, type StateDeadlineCutoffType } from '@capiro/shared';
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

// ── LegiWatch B: derived-event classes (NOT from action text) ───────────────
// These fire from data the action-text watermark can't see (canonical status
// transitions, cbo estimates, cosponsor deltas, text versions, hearing agenda,
// new watchlist matches). Each reuses an EXISTING subscriber trigger key so it
// reaches current subscribers without a pref migration. classifyChange above is
// left byte-identical (Phase-5 parity gate).

/**
 * Map a canonical congress_bill.status TRANSITION to an alert class — ONLY for
 * transitions the action-text path misses: a governing rule failing/adopting
 * (Congress.gov never appends the rule's fate to the target bill's timeline —
 * the H.R. 8800 bug). Other statuses (enacted/failed/passed_chamber/…) already
 * emit via classifyChange, so this returns null for them to avoid duplicates.
 */
export function classifyStatusChange(status: string | null | undefined): ChangeClass | null {
  switch (status) {
    case 'rule_failed':
      return {
        changeType: 'bill_rule_failed',
        triggerKey: 'floorVote',
        label: 'Rule failed — stalled on the floor',
        tone: 'critical',
        severity: 'critical',
      };
    case 'floor': // deriveBillStatus returns 'floor' only when the governing rule was ADOPTED
      return {
        changeType: 'bill_rule_adopted',
        triggerKey: 'floorVote',
        label: 'Rule adopted — headed to the floor',
        tone: 'info',
        severity: 'notable',
      };
    default:
      return null;
  }
}

// ── State Legislation Platform (Phase 0 S4.3): state-rail event classes ────
// A parallel set, NOT a mutation of classifyChange/classifyStatusChange
// above (which stay byte-identical for the federal parity gate). State
// action-text events reuse classifyChange as-is (S4.3) — no new function
// needed there.

/**
 * Map a canonical state_bill.status TRANSITION to an alert class. Unlike the
 * federal `classifyStatusChange` (which only covers the rule_failed/rule_pending
 * gap classifyChange can't see), this covers every status transition worth
 * alerting on — state action text is far less standardized across 50
 * legislatures than Congress.gov's, so the coded status is the primary signal,
 * not a gap-filler. committee/introduced return null (routine, not alert-worthy).
 */
const STATE_STATUS_TRIGGER: Record<string, string> = {
  enacted: 'enactedFailed',
  vetoed: 'enactedFailed',
  failed: 'enactedFailed',
  dead_by_deadline: 'enactedFailed',
  passed_chamber: 'floorVote',
  floor: 'floorVote',
  to_governor: 'floorVote',
  veto_overridden: 'floorVote',
  resolving: 'floorVote',
  reported: 'committeeVote',
};
const STATE_STATUS_SEVERITY: Record<string, AlertSeverity> = {
  enacted: 'critical',
  vetoed: 'critical',
  failed: 'critical',
  dead_by_deadline: 'critical',
  passed_chamber: 'notable',
  floor: 'notable',
  to_governor: 'notable',
  veto_overridden: 'notable',
  resolving: 'notable',
  reported: 'notable',
};
const STATE_STATUS_TONE: Record<string, ChangeTone> = {
  enacted: 'success',
  vetoed: 'critical',
  failed: 'critical',
  dead_by_deadline: 'critical',
  passed_chamber: 'success',
  floor: 'info',
  to_governor: 'info',
  veto_overridden: 'info',
  resolving: 'info',
  reported: 'success',
};

export function classifyStateStatusChange(status: string | null | undefined): ChangeClass | null {
  if (!status) return null;
  const triggerKey = STATE_STATUS_TRIGGER[status];
  if (!triggerKey) return null;
  return {
    changeType: `state_bill_${status}`,
    triggerKey,
    label: stateBillStatusLabel(status),
    tone: STATE_STATUS_TONE[status] ?? 'info',
    severity: STATE_STATUS_SEVERITY[status] ?? 'notable',
  };
}

/** A recorded roll-call vote on a tracked state bill (fires even when it doesn't move canonical status — e.g. a failed floor vote). */
export function stateVoteRecordedClass(isFinalPassageMotion: boolean): ChangeClass {
  return {
    changeType: 'state_bill_vote_recorded',
    triggerKey: isFinalPassageMotion ? 'floorVote' : 'committeeVote',
    label: 'Vote recorded',
    tone: 'info',
    severity: 'notable',
  };
}

/** First-ever emitter for the `companion` trigger key (S4.3 — federal has none yet). */
export const STATE_COMPANION_MOVED_CLASS: ChangeClass = {
  changeType: 'state_companion_moved',
  triggerKey: 'companion',
  label: 'Companion bill moved',
  tone: 'info',
  severity: 'notable',
};

export const FISCAL_NOTE_CLASS: ChangeClass = {
  changeType: 'bill_fiscal_note',
  triggerKey: 'fiscalNote',
  label: 'New CBO cost estimate',
  tone: 'info',
  severity: 'notable',
};
export const TEXT_CHANGED_CLASS: ChangeClass = {
  changeType: 'bill_text_changed',
  triggerKey: 'amendment',
  label: 'Bill text updated',
  tone: 'notable',
  severity: 'notable',
};
export const HEARING_SCHEDULED_CLASS: ChangeClass = {
  changeType: 'bill_hearing_scheduled',
  triggerKey: 'hearing',
  label: 'Hearing scheduled',
  tone: 'info',
  severity: 'info',
};
export const NEW_MATCH_CLASS: ChangeClass = {
  changeType: 'bill_new_match',
  triggerKey: 'newMatch',
  label: 'New matched bill',
  tone: 'info',
  severity: 'info',
};

const DEADLINE_CUTOFF_LABEL: Record<StateDeadlineCutoffType, string> = {
  committeeCutoff: 'committee cutoff',
  crossover: 'crossover day',
  secondCommitteeCutoff: 'second-chamber committee cutoff',
  sineDie: 'sine die',
};

/**
 * Deadline Physics (Phase 1 M2.1/M2.3, PD5) — first emitter for the NEW
 * `deadline` trigger key (a predictive event; doesn't map to any of the
 * existing 9 keys). Severity mirrors the federal comment-period pattern
 * (`check-comment-periods.ts`): critical <3d, notable <=7d, info <=14d.
 * `bill_dead_by_deadline` (the retroactive twin) already fires via
 * `classifyStateStatusChange('dead_by_deadline')` on the EXISTING
 * `enactedFailed` key — this class is only for the upcoming-deadline warning.
 */
export function stateDeadlineClass(
  daysUntil: number,
  cutoffType: StateDeadlineCutoffType,
): ChangeClass {
  const severity: AlertSeverity = daysUntil < 3 ? 'critical' : daysUntil <= 7 ? 'notable' : 'info';
  return {
    changeType: 'state_bill_deadline_approaching',
    triggerKey: 'deadline',
    label: `${daysUntil}d to ${DEADLINE_CUTOFF_LABEL[cutoffType]}`,
    tone: severity === 'critical' ? 'critical' : severity === 'notable' ? 'notable' : 'info',
    severity,
  };
}

/** Cosponsor-momentum class; severity rises with the size of the 7-day surge. */
export function cosponsorMomentumClass(new7d: number): ChangeClass {
  return {
    changeType: 'bill_cosponsor_momentum',
    triggerKey: 'sponsorMomentum',
    label: `Cosponsor momentum (+${new7d} in 7 days)`,
    tone: 'notable',
    severity: new7d >= 15 ? 'notable' : 'info',
  };
}

/**
 * LegiWatch B4 — pull a {yeas, nays} tally out of committee/floor-vote action
 * text so the alert evidence carries the numbers (not just "passed a chamber").
 * Anchored to a vote phrase so it never mistakes an unrelated "12 - 3" for a
 * tally; the 1–3 digit cap keeps 4-digit years (2026-…) from matching.
 * Examples it reads:
 *   "Ordered to be Reported by the Yeas and Nays: 44 - 12."      → {44,12}
 *   "On passage Passed by recorded vote: 219 - 210."             → {219,210}
 *   "Failed by the Yeas and Nays: 198 - 224."                    → {198,224}
 *   "Agreed to by the Yeas and Nays: (2/3 required): 415 - 12."  → {415,12}
 */
export function parseTally(text: string | null | undefined): { yeas: number; nays: number } | null {
  if (!text) return null;
  // Only parse a tally when the text is actually about a vote — never guess a
  // "12 - 3" out of unrelated prose.
  const hasVotePhrase =
    /(yeas?\s+and\s+nays?|recorded\s+vote|record\s+vote|roll\s?call|division\s+vote|by\s+(?:a\s+)?(?:recorded\s+)?vote\s+of|by\s+the\s+yeas)/i.test(
      text,
    );
  if (hasVotePhrase) {
    // Take the LAST "N - N" pair: the tally comes at the end, after any embedded
    // date ("2026-01-05") or "(2/3 required)" — a slash isn't a dash, and a
    // trailing date after the tally is not seen in Congress.gov action text.
    const dashG = /(\d{1,3})\s*[-–—]\s*(\d{1,3})/g;
    let last: RegExpExecArray | null = null;
    for (let m = dashG.exec(text); m; m = dashG.exec(text)) last = m;
    if (last) return { yeas: Number(last[1]), nays: Number(last[2]) };
  }
  // Fallback: the explicit "Yeas N … Nays M" spelling.
  const yn = /\byeas?[^0-9]*(\d{1,3})[^0-9]+nays?[^0-9]*(\d{1,3})/i.exec(text);
  return yn ? { yeas: Number(yn[1]), nays: Number(yn[2]) } : null;
}

export interface ActionLike {
  date: Date | null;
  text: string | null;
}
export interface MaterialEvent {
  cls: ChangeClass;
  text: string;
  date: Date | null;
  // Optional per-event deep link (rule-vote clerk page, CBO publication, …).
  // When set, the writer cites it over the bill's generic congress.gov url.
  sourceUrl?: string | null;
  // Optional structured payload merged into the alert evidence JSON (tally,
  // party splits, cosponsor names, fiscal title/description, fit score, …).
  extra?: Record<string, unknown>;
}

/**
 * Given a bill's NEW actions since its snapshot plus the rollup latest action,
 * return the distinct material changes (one per changeType, chronological). The
 * latest action is always merged in so we never regress below latest-action-only.
 */
export function selectMaterialEvents(
  actions: ActionLike[],
  latest: ActionLike | null,
): MaterialEvent[] {
  const merged: ActionLike[] = [...actions];
  if (latest && latest.text) {
    const dup = merged.some(
      (a) =>
        (a.text ?? '') === (latest.text ?? '') &&
        (a.date?.getTime() ?? 0) === (latest.date?.getTime() ?? 0),
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

/**
 * P1-08: every changeType this file can emit, mapped to the tone its own
 * ChangeClass carries. The board read path needs the tone for a card whose
 * alert row it has already fetched, and the only other place the tone is
 * recorded is the alert's `evidence` JSON (bill-change-detector.service.ts:1042,
 * normalized to `provenance.tone` by Gate C). Selecting that whole JSON column
 * would be a real cost on `getTenantBoard`, which rolls up EVERY client's
 * tracked bills — so the board reads the cheap `severity` column and derives
 * tone here instead, from this file's own definitions rather than a duplicated
 * list in the web app (which is what P1-08 is about).
 *
 * `change-detector.tone-map.spec.ts` locks this against drift: it asserts every
 * class this module can produce has an entry, so adding a class without adding
 * a tone fails the suite rather than silently falling back.
 *
 * Two classes are deliberately ABSENT because their tone is computed from
 * runtime data, not fixed by changeType — `toneForChange` derives those from the
 * severity the row already carries, exactly as the emitting function does:
 *   - state_bill_deadline_approaching (stateDeadlineClass: tone tracks severity)
 *   - bill_cosponsor_momentum        (cosponsorMomentumClass: severity varies)
 */
export const CHANGE_TYPE_TONE: Record<string, ChangeTone> = {
  // classifyChange (action text)
  bill_enacted: 'success',
  bill_to_president: 'success',
  bill_failed: 'critical',
  bill_passed_chamber: 'success',
  bill_rule_reported: 'info',
  bill_floor_scheduled: 'info',
  bill_reported: 'success',
  bill_markup: 'info',
  bill_hearing: 'info',
  bill_amendment: 'notable',
  // classifyStatusChange (canonical federal status)
  bill_rule_failed: 'critical',
  bill_rule_adopted: 'info',
  // classifyStateStatusChange (canonical state status) — mirrors STATE_STATUS_TONE
  state_bill_enacted: 'success',
  state_bill_vetoed: 'critical',
  state_bill_failed: 'critical',
  state_bill_dead_by_deadline: 'critical',
  state_bill_passed_chamber: 'success',
  state_bill_floor: 'info',
  state_bill_to_governor: 'info',
  state_bill_veto_overridden: 'info',
  state_bill_resolving: 'info',
  state_bill_reported: 'success',
  // standalone classes
  state_bill_vote_recorded: 'info',
  state_companion_moved: 'info',
  bill_fiscal_note: 'info',
  bill_text_changed: 'notable',
  bill_hearing_scheduled: 'info',
  bill_new_match: 'info',
};

/**
 * P2-09: change types that mean the bill is in real procedural trouble — a
 * failed governing rule, a veto, a failed vote, or a state bill past its
 * session deadline. Derived from the SAME classes phase a-1 verified, not a
 * second hand-maintained list.
 *
 * The board keeps its four coarse lanes, so without this a failed rule renders
 * as an ordinary card in whichever lane its stage maps to — visually identical
 * to a bill that is progressing.
 */
export const TERMINAL_RISK_CHANGE_TYPES = new Set([
  'bill_rule_failed',
  'bill_failed',
  'state_bill_vetoed',
  'state_bill_failed',
  'state_bill_dead_by_deadline',
]);

/** True when this change type puts the bill in terminal or near-terminal risk. */
export function isTerminalRisk(changeType: string | null | undefined): boolean {
  return !!changeType && TERMINAL_RISK_CHANGE_TYPES.has(changeType);
}

/**
 * The tone for an emitted alert, from its changeType and the severity stored on
 * the row. Falls back to the severity-derived tone that `stateDeadlineClass`
 * itself uses, so a dynamic class is right rather than merely non-null.
 */
export function toneForChange(
  changeType: string | null | undefined,
  severity: string | null | undefined,
): ChangeTone | null {
  const fixed = changeType ? CHANGE_TYPE_TONE[changeType] : undefined;
  if (fixed) return fixed;
  switch ((severity ?? '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'notable':
      return 'notable';
    case 'info':
      return 'info';
    default:
      return null;
  }
}

/**
 * Keep the first event per changeType (input order preserved). Used to merge the
 * derived-event list with the action-text list without emitting two alerts of the
 * same changeType for one bill in one cycle. Pass derived events first so a more
 * specific derived signal wins any (currently impossible) collision.
 */
export function dedupeByChangeType(events: MaterialEvent[]): MaterialEvent[] {
  const seen = new Set<string>();
  const out: MaterialEvent[] = [];
  for (const ev of events) {
    if (seen.has(ev.cls.changeType)) continue;
    seen.add(ev.cls.changeType);
    out.push(ev);
  }
  return out;
}
