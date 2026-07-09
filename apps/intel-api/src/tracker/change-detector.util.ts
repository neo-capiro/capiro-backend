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
  if (/failed|rejected|motion to table agreed|veto|tabled/.test(t))
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
