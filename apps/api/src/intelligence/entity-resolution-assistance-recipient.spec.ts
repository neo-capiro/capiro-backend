import { describe, expect, test } from '@jest/globals';
import { ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE, EntityResolutionService } from './entity-resolution.service.js';

type ScoreCandidateFn = (
  fp: string,
  row: { external_name: string; similarity: number },
  source?: string,
) => number;

function scoreCandidate(service: EntityResolutionService): ScoreCandidateFn {
  return (service as unknown as { scoreCandidate: ScoreCandidateFn }).scoreCandidate.bind(service);
}

/**
 * assistance_recipient's pool (federal_assistance_award recipients) spans
 * heterogeneous entity types — universities, counties, energy companies,
 * foundations — where the generic-corporate-suffix distinctiveness guard in
 * entity-resolution-distinctiveness.spec.ts doesn't apply: two different real
 * organizations can share a real, non-generic word ("University", "County",
 * "Energy"). Verified live 2026-07-27: 173 of 183 candidates were wrong this
 * way, several with $B+ obligated attached (district-nexus remediation). This
 * source's non-exact name matches are capped below the write floor
 * unconditionally, regardless of shared tokens or raw trigram score.
 */
describe('assistance_recipient matcher hardening', () => {
  test('a non-exact match sharing a real (non-generic) word is still capped below the write floor', () => {
    const service = new EntityResolutionService({} as never);
    const clientFp = service.fingerprint('Olivet University');
    const confidence = scoreCandidate(service)(
      clientFp,
      { external_name: 'Duke University', similarity: 0.6 },
      'assistance_recipient',
    );
    expect(confidence).toBeLessThanOrEqual(0.35); // dropped before the 0.4 review floor
  });

  test('the same non-exact match on a DIFFERENT source is not capped by this rule', () => {
    const service = new EntityResolutionService({} as never);
    const clientFp = service.fingerprint('Olivet University');
    // 'university' is a shared distinctive token (not a corporate suffix), so
    // the generic-word guard alone would not cap this — proves the new cap is
    // scoped to assistance_recipient, not a general regression.
    const confidence = scoreCandidate(service)(
      clientFp,
      { external_name: 'Duke University', similarity: 0.6 },
      'contracting',
    );
    expect(confidence).toBeGreaterThan(0.35);
  });

  test('a fingerprint-exact multi-token match still boosts normally for assistance_recipient', () => {
    const service = new EntityResolutionService({} as never);
    const clientFp = service.fingerprint('RTX Corporation');
    const confidence = scoreCandidate(service)(
      clientFp,
      { external_name: 'RTX Corporation', similarity: 0.6 },
      'assistance_recipient',
    );
    expect(confidence).toBeGreaterThanOrEqual(0.85); // unaffected — fingerprintExact short-circuits the new cap
  });

  test('matchAssistanceRecipientByUei short-circuits on a malformed UEI without touching the database', async () => {
    const service = new EntityResolutionService({} as never);
    const result = await (
      service as unknown as { matchAssistanceRecipientByUei: (uei: string) => Promise<unknown[]> }
    ).matchAssistanceRecipientByUei('not-a-real-uei');
    expect(result).toEqual([]);
  });

  test('ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE is high enough to sort first in review but below a deliberate human pin (1.0)', () => {
    expect(ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE).toBeGreaterThanOrEqual(0.9);
    expect(ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE).toBeLessThan(1.0);
  });
});
