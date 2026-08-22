import { CUTOVER_EVIDENCE_TYPES } from './legiwatch-phase9-gates.js';
import { LEGIWATCH_PHASE9_VERIFICATION_MATRIX } from './legiwatch-phase9-verification-matrix.js';

describe('LegiWatch Phase 9 verification matrix', () => {
  it('owns every cutover evidence type exactly once', () => {
    const keys = LEGIWATCH_PHASE9_VERIFICATION_MATRIX.map((row) => row.evidenceType);
    expect(keys).toHaveLength(CUTOVER_EVIDENCE_TYPES.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...CUTOVER_EVIDENCE_TYPES].sort());
  });

  it('keeps the live chain non-substitutable', () => {
    for (const key of ['LIVE_DISCOVERY', 'LIVE_RESOLUTION', 'LIVE_CAPTURE', 'LIVE_DEEPGRAM']) {
      const scenario = LEGIWATCH_PHASE9_VERIFICATION_MATRIX.find(
        (row) => row.evidenceType === key,
      );
      expect(scenario).toBeDefined();
      expect(scenario?.category).toBe('LIVE_CHAIN');
      expect(scenario?.acceptableSources).toEqual(['LIVE', 'MIXED']);
      expect(scenario?.maxAgeDays).toBeLessThanOrEqual(30);
      expect(scenario?.artifactRequired).toBe(true);
    }
  });

  it('gives every scenario an automated mechanism proof and an operator proof', () => {
    for (const scenario of LEGIWATCH_PHASE9_VERIFICATION_MATRIX) {
      expect(scenario.requirement.trim().length).toBeGreaterThan(20);
      expect(scenario.automatedProof.length).toBeGreaterThan(0);
      expect(
        scenario.automatedProof.every(
          (file) => file.endsWith('.spec.ts') || file.endsWith('.test.ts'),
        ),
      ).toBe(true);
      expect(scenario.operatorProof.trim().length).toBeGreaterThan(20);
      expect(scenario.maxAgeDays).toBeGreaterThan(0);
      expect(scenario.maxAgeDays).toBeLessThanOrEqual(90);
    }
  });

  it('has no manual-only or source-free cutover scenario', () => {
    for (const scenario of LEGIWATCH_PHASE9_VERIFICATION_MATRIX) {
      expect(scenario.automatedProof).not.toEqual([]);
      expect(scenario.acceptableSources).not.toEqual([]);
      expect(scenario.acceptableSources).not.toContain('NONE');
      expect(scenario.artifactRequired).toBe(true);
    }
  });
});
