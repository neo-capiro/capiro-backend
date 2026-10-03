import { MERI_FIXTURE_SEMANTIC_INSTANT, MERI_FIXTURE_SEMANTIC_ZONE, validateMeriFixtureSemanticClock, type MeriFixtureSemanticClock } from './server-readonly-capture.js';

const clock: MeriFixtureSemanticClock = { version: 1, kind: 'qualified_original_fixture_semantic_clock',
  instant: MERI_FIXTURE_SEMANTIC_INSTANT, timeZone: MERI_FIXTURE_SEMANTIC_ZONE, caseId: '01',
  captureRunId: '11111111-1111-4111-8111-111111111111', currentVerifySha256: 'a'.repeat(64), observedAt: 1791028800000 };
const binding = { caseId: clock.caseId, captureRunId: clock.captureRunId, issuedAt: clock.observedAt };
test('only the fixed qualified clock shape and exact capture tuple are valid', () => {
  expect(validateMeriFixtureSemanticClock(clock, binding)).toBe(clock);
  for (const change of [{ instant: '2020-01-01T00:00:00Z' }, { timeZone: 'UTC' }, { caseId: '21' },
    { captureRunId: '22222222-2222-4222-8222-222222222222' }, { observedAt: clock.observedAt - 1 },
    { currentVerifySha256: 'ready' }, { ready: true }]) {
    expect(() => validateMeriFixtureSemanticClock({ ...clock, ...change } as MeriFixtureSemanticClock, binding)).toThrow('semantic_clock');
  }
  expect(() => validateMeriFixtureSemanticClock(clock, { ...binding, syntheticReadBudget: {} })).toThrow('semantic_clock');
});
