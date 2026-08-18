import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePbComparison, type BudgetPositionLike } from '../../apps/api/src/program-element/budget-position.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Old-vs-new parity: PB-comparison money/shape parity between apps/api's
 * pure computePbComparison() and defense-api's getPbComparison() row-shaping
 * logic, fed the SAME fixture. This test imports apps/api's ACTUAL pure
 * helper (no Nest/Prisma deps, safe to import directly) rather than
 * re-describing its behavior, so a real behavioral drift fails here first.
 */
function newImplementationComparison(positions: BudgetPositionLike[]) {
  // Mirrors ProgramElementReadService.getPbComparison's row-building exactly
  // (see apps/defense-api/src/program-elements/program-element-read.service.ts).
  const pbRows = positions.filter((r) => /^pb_fy\d{4}$/i.test(r.positionCycle));
  const byCycle = new Map<string, BudgetPositionLike[]>();
  for (const r of pbRows) {
    const list = byCycle.get(r.positionCycle) ?? [];
    list.push(r);
    byCycle.set(r.positionCycle, list);
  }
  const cycles = [...byCycle.keys()].sort();
  if (cycles.length < 2) return [];
  const currentCycle = cycles[cycles.length - 1] as string;
  const priorCycle = cycles[cycles.length - 2] as string;
  const num = (v: number | string | null): number | null => (v === null ? null : Number(v));
  const currentByFy = new Map((byCycle.get(currentCycle) ?? []).map((r) => [r.assertedFy, num(r.amount)]));
  const priorByFy = new Map((byCycle.get(priorCycle) ?? []).map((r) => [r.assertedFy, num(r.amount)]));
  const fys = new Set([...currentByFy.keys(), ...priorByFy.keys()]);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
  return [...fys].sort().map((fy) => {
    const pbCurrent = currentByFy.get(fy) ?? null;
    const pbPrior = priorByFy.get(fy) ?? null;
    const inCurrent = currentByFy.has(fy);
    const inPrior = priorByFy.has(fy);
    return {
      assertedFy: fy,
      pbCurrent,
      pbPrior,
      deltaAbs: pbCurrent !== null && pbPrior !== null ? round2(pbCurrent - pbPrior) : null,
      deltaPct: pbCurrent !== null && pbPrior !== null && pbPrior !== 0 ? round4((pbCurrent - pbPrior) / Math.abs(pbPrior)) : null,
      newInPb: inCurrent && pbCurrent !== null && (!inPrior || pbPrior === null),
      droppedFromPb: inPrior && pbPrior !== null && (!inCurrent || pbCurrent === null),
    };
  });
}

test('PARITY: apps/api computePbComparison and defense-api getPbComparison row-shaping agree exactly', () => {
  const fixture: BudgetPositionLike[] = [
    { positionCycle: 'pb_fy2026', assertedFy: 2026, amount: '100.333333', valueKind: 'total' },
    { positionCycle: 'pb_fy2026', assertedFy: 2027, amount: '50.111111', valueKind: 'total' },
    { positionCycle: 'pb_fy2027', assertedFy: 2026, amount: '105.666666', valueKind: 'total' },
    { positionCycle: 'pb_fy2027', assertedFy: 2027, amount: '55.222222', valueKind: 'total' },
    { positionCycle: 'pb_fy2027', assertedFy: 2028, amount: '10', valueKind: 'total' },
  ];

  const legacy = computePbComparison(fixture);
  const next = newImplementationComparison(fixture);

  assert.equal(next.length, legacy.length);
  assert.deepEqual(next, legacy, 'row shape and money representation must match apps/api exactly, field-for-field');
});

test('PARITY: single-PB-book input yields an empty comparison on both implementations', () => {
  const fixture: BudgetPositionLike[] = [
    { positionCycle: 'pb_fy2027', assertedFy: 2027, amount: '10', valueKind: 'total' },
  ];
  assert.deepEqual(computePbComparison(fixture), []);
  assert.deepEqual(newImplementationComparison(fixture), []);
});
