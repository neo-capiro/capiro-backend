import { describe, expect, it } from 'vitest';
import { buildExploreCsv } from './PeExploreView.js';
import type { V2LineRow } from '../../../pages/program-element/v2/pe-v2-model.js';

const row: V2LineRow = {
  code: '0603851F',
  title: 'Trusted program',
  service: 'AF',
  lineType: 'RDTE_PE',
  budgetActivity: 'BA 4',
  lastSyncedAt: '2026-09-23T12:00:00.000Z',
  request: 100,
  requestFy: 2027,
  current: 110,
  currentFy: 2027,
  currentStage: 'hasc',
  delta: 10,
  pct: 10,
  spark: [90, 100, 110],
  watched: false,
  signalType: null,
  signalDeltaPct: null,
  actionSignalType: null,
  billCount: 1,
};

describe('Explore CSV', () => {
  it('exports reproducible FY, units, as-of, attribution status, and a source link', () => {
    const csv = buildExploreCsv([row], {
      selectedFy: 2027,
      generatedAt: '2026-09-24T00:00:00.000Z',
      origin: 'https://app.example.test',
    });

    expect(csv).toContain('"Selected FY"');
    expect(csv).toContain('"2027"');
    expect(csv).toContain('"USD millions"');
    expect(csv).toContain('"2026-09-23T12:00:00.000Z"');
    expect(csv).toContain('"not evaluated in catalog; open source inspector"');
    expect(csv).toContain('"https://app.example.test/program-elements/0603851F?tab=sources"');
  });
});
