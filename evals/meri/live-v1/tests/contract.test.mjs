import test from 'node:test';
import assert from 'node:assert/strict';
import { cases } from '../cases.mjs';
import { frozenFixture } from '../fixture.mjs';
import { validateContract } from '../validate-contract.mjs';

test('canonical contract has exactly sequential 01..75 and frozen hashes', () => {
  const result = validateContract();
  assert.equal(result.valid, true, result.errors.join('\n'));
  assert.equal(result.caseCount, 75);
});

test('actual validator rejects a missing manifest case', () => {
  const result = validateContract({ caseManifest: cases.slice(0, -1) });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /exactly 75|01\.\.75/u);
});

test('actual validator rejects a duplicate manifest ID', () => {
  const duplicate = [...cases.slice(0, -1), cases[0]];
  const result = validateContract({ caseManifest: duplicate });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /duplicate|01\.\.75/u);
});

test('actual validator rejects verbatim prompt drift', () => {
  const changed = cases.map((item, index) => index === 0 ? { ...item, prompt: `${item.prompt} ` } : item);
  const result = validateContract({ caseManifest: changed });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /prompt/u);
});

test('actual validator rejects fixture hash drift', () => {
  const changed = structuredClone(frozenFixture);
  changed.clock.instant = '2026-09-26T16:00:01.000Z';
  const result = validateContract({ fixture: changed });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /fixture hash drift|clock drift/u);
});
