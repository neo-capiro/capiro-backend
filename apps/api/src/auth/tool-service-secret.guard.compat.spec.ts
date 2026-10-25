import { describe, expect, it } from '@jest/globals';
import * as owner from './tool-service-secret.guard.js';
import * as legacy from '../meri/tool-service-secret.guard.js';
import * as modes from './meri-evidence-mode-reads.js';
import * as legacyModes from '../meri/meri-funding-read-observation.js';

describe('neutral authority owners keep the legacy Meri import paths identical', () => {
  it('re-exports one guard class and one request-local service-identity proof', () => {
    expect(legacy.ToolServiceSecretGuard).toBe(owner.ToolServiceSecretGuard);
    expect(legacy.hasVerifiedToolServiceIdentity).toBe(owner.hasVerifiedToolServiceIdentity);
  });

  it('re-exports the same evidence-mode read list and predicate', () => {
    expect(legacyModes.MERI_EVIDENCE_MODE_READS).toBe(modes.MERI_EVIDENCE_MODE_READS);
    expect(legacyModes.isMeriEvidenceModeRead).toBe(modes.isMeriEvidenceModeRead);
    expect([...modes.MERI_EVIDENCE_MODE_READS]).toEqual([
      'search_federal_grants', 'search_federal_awards', 'search_program_elements', 'get_program_element', 'get_pe_budget_timeline', 'search_sam_opportunities',
    ]);
    expect(modes.isMeriEvidenceModeRead('search_federal_grants')).toBe(true);
    expect(modes.isMeriEvidenceModeRead('search_funding_opportunities')).toBe(false);
  });
});
