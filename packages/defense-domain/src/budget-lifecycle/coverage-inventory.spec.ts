import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDefenseCoverageInventory } from './coverage-inventory.js';

describe('versioned defense coverage inventory', () => {
  it('keeps FY2024 expected slots separate from split volumes and superseded editions', () => {
    const report = buildDefenseCoverageInventory({
      fiscalYear: 2024,
      inventoryKnowledge: 'inventoried',
      expectedSlots: [
        { slotId: 'fy24-r2', fiscalYear: 2024, sourceFamily: 'pb_r2', adapterId: 'army-budget', label: 'FY2024 Army R-2', optional: false },
        { slotId: 'fy24-r1', fiscalYear: 2024, sourceFamily: 'pb_r1', adapterId: 'dod-comptroller', label: 'FY2024 R-1', optional: false },
      ],
      observations: [
        {
          observationId: 'r2-current', slotId: 'fy24-r2', sourceDocumentId: 'doc-r2-current',
          observationState: 'changed', supersededByObservationId: null, classification: 'classified',
          physicalUnits: [
            { unitId: 'r2-vol-1', kind: 'volume', label: 'Volume 1' },
            { unitId: 'r2-vol-2', kind: 'volume', label: 'Volume 2' },
            { unitId: 'r2-vol-2-sec-a', kind: 'section', label: 'Volume 2, BA1 section' },
            { unitId: 'r2-vol-2-exhibit-a', kind: 'exhibit', label: 'Volume 2, R-2 exhibit A' },
          ],
        },
        {
          observationId: 'r2-old', slotId: 'fy24-r2', sourceDocumentId: 'doc-r2-old',
          observationState: 'superseded', supersededByObservationId: 'r2-current', classification: 'classified',
        },
        {
          observationId: 'r1-missing', slotId: 'fy24-r1', sourceDocumentId: null,
          discoveredUrl: 'https://official.example/FY2024_r1.pdf', observationState: 'review_required',
          supersededByObservationId: null, classification: 'unavailable',
        },
      ],
      inventoriedUnits: [
        {
          slotId: 'fy24-r2', unitId: 'manifest-vol-3', kind: 'volume', label: 'Volume 3',
          sourceDocumentId: 'doc-r2-current', observationId: 'r2-current', memberStatus: 'verified',
        },
      ],
    });

    assert.equal(report.schemaVersion, 'defense_coverage_inventory_v1');
    assert.equal(report.expectedSlots.length, 2);
    assert.equal(report.expectedSlots[0]?.coverage, 'observed');
    assert.equal(report.expectedSlots[1]?.coverage, 'observed');
    assert.equal(report.physicalUnits.filter((unit) => unit.kind === 'volume').length, 3);
    assert.equal(report.physicalUnits.find((unit) => unit.unitId === 'r2-vol-2-sec-a')?.kind, 'section');
    assert.equal(report.physicalUnits.find((unit) => unit.unitId === 'r2-vol-2-exhibit-a')?.kind, 'exhibit');
    assert.equal(report.physicalUnits.find((unit) => unit.unitId === 'manifest-vol-3')?.memberStatus, 'verified');
    assert.equal(report.physicalUnits.find((unit) => unit.observationId === 'r2-old')?.superseded, true);
    assert.equal(report.physicalUnits.find((unit) => unit.observationId === 'r1-missing')?.classification, 'unavailable');
    assert.equal(report.physicalUnits.find((unit) => unit.observationId === 'r1-missing')?.sourceDocumentId, null);
  });

  it('does not turn absent or uninventoried slots into zero coverage', () => {
    const report = buildDefenseCoverageInventory({
      fiscalYear: 2024,
      inventoryKnowledge: 'not_inventoried',
      expectedSlots: [{ slotId: 'slot', fiscalYear: 2024, sourceFamily: 'pb_r3', adapterId: 'army-budget', label: 'R-3', optional: true }],
      observations: [],
    });
    assert.equal(report.expectedSlots[0]?.coverage, 'unknown');
    assert.equal(report.physicalUnits.length, 0);
  });
});
