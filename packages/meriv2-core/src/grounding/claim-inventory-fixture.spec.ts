import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractMaterialClaims } from './claim-inventory';

type Expected = { text: string; kind: string; uncited: boolean; compound: boolean };
type Case = { id: string; split: 'tuning' | 'heldout'; reply: string; material: Expected[]; exclusions: string[] };
const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__/claim-inventory-v1.json'), 'utf8')) as { cases: Case[] };
const citations = [
  { n: 1, tool: 'fixture', id: 'one', stableId: 'fixture-one' },
  { n: 2, tool: 'fixture', id: 'two', stableId: 'fixture-two' },
];

function key(value: Expected): string {
  return `${value.text.replace(/[.!?]$/, '').toLowerCase()}|${value.kind}|${value.uncited}|${value.compound}`;
}

function metrics(split: Case['split']) {
  let expected = 0;
  let actual = 0;
  let matches = 0;
  for (const item of fixture.cases.filter((entry) => entry.split === split)) {
    const inventory = extractMaterialClaims({ replyText: item.reply, citations, asOf: '2026-09-22T00:00:00.000Z' });
    const expectedKeys = new Set(item.material.map(key));
    const actualRows = inventory.filter((claim) => claim.material).map((claim) => ({
      text: claim.text, kind: claim.kind, uncited: claim.uncited, compound: claim.compound,
    }));
    const actualKeys = new Set(actualRows.map(key));
    expected += expectedKeys.size;
    actual += actualKeys.size;
    matches += [...actualKeys].filter((value) => expectedKeys.has(value)).length;

    expect(inventory.filter((claim) => !claim.material).map((claim) => claim.text)).toEqual(item.exclusions);
  }
  return { recall: matches / expected, precision: matches / actual, matches, expected, actual };
}

describe('claim inventory labeled fixture', () => {
  it('meets predeclared tuning recall and precision thresholds', () => {
    const result = metrics('tuning');
    console.log('claim-inventory tuning metrics', result);
    expect(result.recall).toBeGreaterThanOrEqual(0.9);
    expect(result.precision).toBeGreaterThanOrEqual(0.8);
  });

  it('reports held-out metrics without asserting a threshold', () => {
    const result = metrics('heldout');
    console.log('claim-inventory heldout metrics', result);
    expect(result.expected).toBeGreaterThan(0);
  });
});
