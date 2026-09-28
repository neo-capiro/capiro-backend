import test from 'node:test';
import assert from 'node:assert/strict';
import { cases } from '../cases.mjs';
import { frozenFixture } from '../fixture.mjs';
import { standardDeepCaseIds, structuredExecutionRequirements } from '../execution-requirements.mjs';
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

test('verbatim execution contract has structured context, fault, and mode requirements', () => {
  for (const id of ['25', '42', '56', '57', '58', '71', '72', '73', '74', '75']) {
    const requirement = structuredExecutionRequirements[id];
    assert.ok(requirement, `missing structured execution requirement for ${id}`);
    assert.ok(Array.isArray(requirement.injectedFaults), `missing injectedFaults for ${id}`);
    assert.ok(Array.isArray(requirement.modeMatrix) && requirement.modeMatrix.length > 0, `missing modeMatrix for ${id}`);
    assert.ok(Array.isArray(requirement.requiredTransitions) && requirement.requiredTransitions.length > 0, `missing transitions for ${id}`);
    assert.equal(typeof requirement.previousTurns?.required, 'boolean', `missing previousTurns for ${id}`);
  }
  assert.deepEqual([...standardDeepCaseIds].sort(), ['01', '20', '22', '42', '49', '51', '59', '74']);
  assert.deepEqual(structuredExecutionRequirements['56'].modeMatrix.map((entry) => entry.verificationMode), ['enabled-canary', 'shadow']);
  assert.ok(structuredExecutionRequirements['42'].requiredTransitions.includes('mode_persisted_after_reload'));
  assert.ok(structuredExecutionRequirements['74'].requiredTransitions.includes('mode_persisted_next_turn'));
});
