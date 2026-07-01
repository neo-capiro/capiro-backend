/**
 * Bill-stage + passage-likelihood + congress helpers (Phase 3/§6.2) — ported
 * verbatim from apps/api/src/tracker/bill-stage.util.ts. Pure, deterministic.
 * (humanizeBillId lives in relevance.util to avoid duplication.)
 */
export type BillStage = 'introduced' | 'committee' | 'passed' | 'enacted';

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

/** Calibrated passage-likelihood heuristic (0..1). NOT a trained model. */
export function passageProbability(bill: {
  latestActionText: string | null;
  title?: string | null;
  latestActionDate?: Date | null;
  nowMs?: number;
}): number {
  const stage = billStage(bill.latestActionText);
  if (stage === 'enacted') return 0.99;
  const mustPass =
    /national defense authorization|consolidated appropriations|making appropriations|defense appropriation|continuing appropriations|further (consolidated |additional )?appropriations/i.test(
      bill.title ?? '',
    );
  let p =
    stage === 'passed'
      ? mustPass ? 0.85 : 0.4
      : stage === 'committee'
        ? mustPass ? 0.55 : 0.12
        : mustPass ? 0.3 : 0.04;
  const actionMs = bill.latestActionDate ? bill.latestActionDate.getTime() : null;
  if (actionMs != null) {
    const days = ((bill.nowMs ?? Date.now()) - actionMs) / 86_400_000;
    if (days > 270) p *= 0.6;
    else if (days < 45) p = Math.min(0.95, p * 1.15);
  }
  return Math.max(0.02, Math.min(0.97, p));
}

/** The current US Congress number (a Congress spans 2 years from the odd year). */
export function currentCongress(now: Date = new Date()): number {
  return Math.floor((now.getFullYear() - 1789) / 2) + 1;
}

/** Parse the leading Congress number from a bill id ("119-hr-7702" → 119), or null. */
export function congressFromBillId(id: string): number | null {
  const n = Number((id ?? '').split('-')[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
