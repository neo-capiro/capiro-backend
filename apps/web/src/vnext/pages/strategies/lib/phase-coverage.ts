import type { FirmPhaseInput } from '../../../../pages/strategy/types.js';

export const phaseQuarter = (fy: number, q: number) => fy * 4 + q - 1;
const label = (ordinal: number) => `FY${Math.floor(ordinal / 4)} Q${(ordinal % 4) + 1}`;

/** Merge overlapping phases before identifying uncovered portions of the visible horizon. */
export function phaseCoverageGaps(
  rows: FirmPhaseInput[],
  startFy: number,
  endFy: number,
): string[] {
  let cursor = phaseQuarter(startFy, 1);
  const end = phaseQuarter(endFy + 1, 1);
  const gaps: string[] = [];
  const sorted = rows
    .map(
      (row) => [phaseQuarter(row.startFy, row.startQ), phaseQuarter(row.endFy, row.endQ)] as const,
    )
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a < b)
    .sort((a, b) => a[0] - b[0]);
  for (const [a, b] of sorted) {
    if (b <= cursor || a >= end) continue;
    if (a > cursor) gaps.push(`${label(cursor)} to ${label(Math.min(a, end))} (end exclusive)`);
    cursor = Math.max(cursor, b);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push(`${label(cursor)} to ${label(end)} (end exclusive)`);
  return gaps;
}

export function phasesInDateOrder(rows: FirmPhaseInput[]): boolean {
  return rows.every(
    (row, i) =>
      i === 0 ||
      phaseQuarter(row.startFy, row.startQ) >=
        phaseQuarter(rows[i - 1]!.startFy, rows[i - 1]!.startQ),
  );
}
