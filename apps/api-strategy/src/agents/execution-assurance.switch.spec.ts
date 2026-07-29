import { describe, expect, it } from '@jest/globals';
import { generationReleaseHoldEnforced } from './execution-assurance.js';

/**
 * Strategy execution classifies as an external client-facing surface, so
 * `assessGeneratedDocumentForRelease` holds any generation lacking OK context
 * health or per-section provenance. That assessment is correct but strict, so the
 * withholding half must stay dark until it is armed deliberately — otherwise
 * deploying turns ordinary Workspace/Outreach generations into `generation_held`.
 */
describe('generationReleaseHoldEnforced', () => {
  it('is off when unset so a deploy cannot start withholding artifacts', () => {
    expect(generationReleaseHoldEnforced(undefined)).toBe(false);
    expect(generationReleaseHoldEnforced('')).toBe(false);
    expect(generationReleaseHoldEnforced('   ')).toBe(false);
  });

  it('arms only on an explicit enforce value', () => {
    expect(generationReleaseHoldEnforced('enforce')).toBe(true);
    expect(generationReleaseHoldEnforced(' Enforce ')).toBe(true);
  });

  it('fails safe on truthy-looking or near-miss values', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'annotate', 'enforced']) {
      expect(generationReleaseHoldEnforced(raw)).toBe(false);
    }
  });
});
