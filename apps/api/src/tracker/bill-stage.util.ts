/**
 * Deterministic bill-stage + passage-likelihood helpers shared by the Tracker
 * Board and the change-detection worker. Mirrors the heuristics the Intelligence
 * aggregate uses (intelligence.service.ts) so the curated Board stages a bill
 * identically to how it was staged on the old in-Intelligence kanban.
 */

export type BillStage = 'introduced' | 'committee' | 'passed' | 'enacted';

/** The four board columns, in legislative order. */
export const BILL_STAGES: ReadonlyArray<{ id: BillStage; label: string }> = [
  { id: 'introduced', label: 'Introduced' },
  { id: 'committee', label: 'In committee' },
  { id: 'passed', label: 'Passed chamber' },
  { id: 'enacted', label: 'Enacted' },
];

/** Classify a bill's latest action text into a board stage (status-driven). */
export function billStage(latestActionText: string | null | undefined): BillStage {
  const txt = (latestActionText ?? '').toLowerCase();
  if (/signed|enacted|public law|pl\s+\d/.test(txt)) return 'enacted';
  if (/passed|agreed to/.test(txt)) return 'passed';
  if (/committee|referred|reported|markup/.test(txt)) return 'committee';
  return 'introduced';
}

/**
 * Estimated passage likelihood (0..1). NOT a trained model — a calibrated
 * heuristic over real per-bill signals (stage base rate, must-pass vehicle
 * boost, recency momentum) so it varies bill-to-bill rather than one flat
 * number per stage. Kept byte-identical to intelligence.service's version.
 */
export function passageProbability(bill: {
  latestActionText: string | null;
  title?: string | null;
  latestActionDate?: Date | null;
}): number {
  const stage = billStage(bill.latestActionText);
  if (stage === 'enacted') return 0.99;
  const mustPass =
    /national defense authorization|consolidated appropriations|making appropriations|defense appropriation|continuing appropriations|further (consolidated |additional )?appropriations/i.test(
      bill.title ?? '',
    );
  let p =
    stage === 'passed'
      ? mustPass
        ? 0.85
        : 0.4
      : stage === 'committee'
        ? mustPass
          ? 0.55
          : 0.12
        : mustPass
          ? 0.3
          : 0.04;
  const actionMs = bill.latestActionDate ? bill.latestActionDate.getTime() : null;
  if (actionMs != null) {
    const days = (Date.now() - actionMs) / 86_400_000;
    if (days > 270)
      p *= 0.6; // stalled ~9+ months
    else if (days < 45) p = Math.min(0.95, p * 1.15); // fresh momentum
  }
  return Math.max(0.02, Math.min(0.97, p));
}

const BILL_TYPE_LABEL: Record<string, string> = {
  hr: 'H.R.',
  s: 'S.',
  hjres: 'H.J.Res.',
  sjres: 'S.J.Res.',
  hconres: 'H.Con.Res.',
  sconres: 'S.Con.Res.',
  hres: 'H.Res.',
  sres: 'S.Res.',
};

/**
 * Humanize a congress_bill id ("119-hr-7702") into a display label
 * ("H.R. 7702"). Falls back to the raw id when it doesn't parse.
 */
export function humanizeBillId(id: string): string {
  const parts = (id ?? '').split('-');
  if (parts.length < 3) return id;
  const type = parts[1] ?? '';
  const number = parts.slice(2).join('-');
  if (!type) return id;
  const prefix = BILL_TYPE_LABEL[type.toLowerCase()] ?? type.toUpperCase();
  return `${prefix} ${number}`;
}
