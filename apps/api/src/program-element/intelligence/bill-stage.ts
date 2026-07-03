/**
 * Bill-action stage normalizer (legislative-timeline plan §3): maps a
 * Congress.gov action's raw text + type onto Capiro's normalized stage ladder.
 * Pure module — no DB, no I/O; the read service classifies stored
 * congress_bill_action rows at read time so the classifier version is always
 * current and no backfill migration is ever needed.
 *
 * The RAW text is never discarded — callers render `text` verbatim and use the
 * stage only for color/grouping/ordering. Unrecognized actions classify as
 * 'other' (rendered neutrally), never guessed into a stage.
 *
 * NOTE: committee MARKUP is deliberately conservative here. A HASC/SASC/HAC-D/
 * SAC-D mark is authoritative when it comes from Capiro's own mark ingestion
 * (budget_action rows), not from Congress.gov action text — this classifier
 * only tags the textual traces ("markup held", "ordered to be reported").
 */

export type BillStage =
  | 'introduced'
  | 'referred'
  | 'markup'
  | 'reported'
  | 'passed_house'
  | 'passed_senate'
  | 'conference'
  | 'to_president'
  | 'enacted'
  | 'other';

export interface BillStageResult {
  stage: BillStage;
  /** Render-safe short label. */
  label: string;
  /** Ordinal position on the ladder (for sorting/coloring), 0=earliest. */
  rank: number;
}

const META: Record<BillStage, { label: string; rank: number }> = {
  introduced: { label: 'Introduced', rank: 0 },
  referred: { label: 'Referred', rank: 1 },
  markup: { label: 'Markup', rank: 2 },
  reported: { label: 'Reported', rank: 3 },
  passed_house: { label: 'Passed House', rank: 4 },
  passed_senate: { label: 'Passed Senate', rank: 5 },
  conference: { label: 'Conference', rank: 6 },
  to_president: { label: 'To President', rank: 7 },
  enacted: { label: 'Became law', rank: 8 },
  other: { label: 'Action', rank: -1 },
};

function result(stage: BillStage): BillStageResult {
  return { stage, ...META[stage] };
}

/**
 * Classify one action. `chamber` disambiguates bare "Passed/agreed to" texts;
 * when unknown the House/Senate wording in the text itself decides.
 */
export function normalizeBillStage(
  text: string | null | undefined,
  type?: string | null,
  chamber?: string | null,
): BillStageResult {
  const t = (text ?? '').toLowerCase();
  const ch = (chamber ?? '').toLowerCase();

  // Terminal states first — later-stage wording wins over earlier mentions.
  if (
    t.includes('became public law') ||
    t.includes('became law') ||
    t.includes('signed by president') ||
    t.includes('public law no')
  ) {
    return result('enacted');
  }
  if (t.includes('presented to president') || t.includes('to president')) {
    return result('to_president');
  }
  if (
    t.includes('conference report') ||
    t.includes('conferees') ||
    t.includes('resolving differences') ||
    t.includes('amendment between the houses')
  ) {
    return result('conference');
  }
  if (t.includes('passed') || t.includes('agreed to')) {
    if (t.includes('senate') || ch === 'senate') return result('passed_senate');
    if (t.includes('house') || ch === 'house') return result('passed_house');
    // Floor passage of unknown chamber — use the action type as a weak hint.
    if ((type ?? '').toLowerCase() === 'floor') return result('other');
    return result('other');
  }
  if (t.includes('markup') || t.includes('ordered to be reported')) {
    return result('markup');
  }
  if (t.includes('reported')) {
    return result('reported');
  }
  if (t.includes('referred to')) {
    return result('referred');
  }
  if (t.includes('introduced')) {
    return result('introduced');
  }
  const ty = (type ?? '').toLowerCase();
  if (ty === 'introreferral') return result('referred');
  if (ty === 'becamelaw') return result('enacted');
  if (ty === 'president') return result('to_president');
  return result('other');
}
