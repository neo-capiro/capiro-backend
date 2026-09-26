import { describe, expect, it } from '@jest/globals';
import {
  checkFedrampStatusClaims,
  detectFedrampStatusClaims,
  enforceFedrampStatusReply,
  type CertificationStatusEvidence,
} from './status-provenance';

const evidence = (overrides: Partial<CertificationStatusEvidence> = {}): CertificationStatusEvidence => ({
  entityId: 'FR123',
  entityNames: ['Acme Cloud'],
  status: 'FedRAMP Certified',
  impactLevel: 'Moderate',
  sourceUrl: 'https://fedramp.gov/marketplace/products/',
  observedAt: '2026-09-23T00:00:00.000Z',
  authoritative: true,
  primary: true,
  ...overrides,
});

describe('FedRAMP status provenance', () => {
  it('detects exact, paraphrased, impact-level, and negative statements', () => {
    expect(detectFedrampStatusClaims([
      'Acme Cloud is FedRAMP Certified at Moderate impact.',
      'Beta is FedRAMP approved.',
      'No FedRAMP authorization was found for Gamma.',
      'FedRAMP publishes a marketplace.',
    ].join(' '))).toEqual([
      expect.objectContaining({ entityMention: 'Acme Cloud', statedStatus: 'FedRAMP Certified', statedImpactLevel: 'Moderate', negative: false }),
      expect.objectContaining({ entityMention: 'Beta', statedStatus: 'FedRAMP approved', negative: false }),
      expect.objectContaining({ statedStatus: null, negative: true }),
    ]);
  });

  it('classifies exact strings, explicit paraphrases, mismatches, and missing entities', () => {
    const claims = detectFedrampStatusClaims(
      'Acme Cloud is FedRAMP Certified at Moderate. Acme Cloud is FedRAMP approved. Acme Cloud is FedRAMP In Process. Beta is FedRAMP Certified.',
    );
    expect(checkFedrampStatusClaims(claims, [evidence()]).map((item) => item.outcome)).toEqual([
      'exact', 'paraphrased', 'mismatch', 'unsupported',
    ]);
  });

  it('recognizes the documented remediation status as one exact status', () => {
    const reply = 'Acme Cloud is FedRAMP Certified (In Remediation).';
    const claims = detectFedrampStatusClaims(reply);
    expect(claims).toEqual([
      expect.objectContaining({ entityMention: 'Acme Cloud', statedStatus: 'FedRAMP Certified (In Remediation)' }),
    ]);
    expect(checkFedrampStatusClaims(claims, [evidence({ status: 'FedRAMP Certified (In Remediation)' })])[0]?.outcome)
      .toBe('exact');
  });

  it('never accepts self-reported fields as verification', () => {
    const claims = detectFedrampStatusClaims('Acme Cloud is FedRAMP Certified.');
    expect(checkFedrampStatusClaims(claims, [evidence({ selfReported: true })])[0]?.outcome).toBe('unsupported');
  });

  it('requires complete authoritative coverage for a negative claim', () => {
    const claims = detectFedrampStatusClaims('Acme Cloud is not FedRAMP authorized.');
    expect(checkFedrampStatusClaims(claims, [evidence()])[0]?.outcome).toBe('negative_unsupported');
    expect(checkFedrampStatusClaims(claims, [evidence({
      coverage: {
        description: 'entire FedRAMP marketplace',
        complete: true,
        truncated: false,
        failedSources: [],
      },
    })])[0]?.outcome).toBe('exact');
  });

  it('replaces unsupported negative and positive assertions instead of appending a disclaimer', () => {
    const negative = 'Gamma Cloud is not FedRAMP authorized.';
    const negativeChecked = checkFedrampStatusClaims(detectFedrampStatusClaims(negative), []);
    const negativeReply = enforceFedrampStatusReply(negative, negativeChecked);
    expect(negativeReply).toBe(
      "Gamma Cloud's FedRAMP authorization status is unverified; complete-dataset coverage was not established.",
    );
    expect(negativeReply).not.toContain('is not FedRAMP authorized');

    const sourceMiss = 'No FedRAMP authorization was found for Gamma Cloud.';
    const sourceMissChecked = checkFedrampStatusClaims(detectFedrampStatusClaims(sourceMiss), []);
    expect(enforceFedrampStatusReply(sourceMiss, sourceMissChecked)).toBe(
      "Gamma Cloud's FedRAMP authorization status is unverified; complete-dataset coverage was not established.",
    );

    const positive = 'Gamma Cloud is FedRAMP Certified.';
    const positiveChecked = checkFedrampStatusClaims(detectFedrampStatusClaims(positive), []);
    const positiveReply = enforceFedrampStatusReply(positive, positiveChecked);
    expect(positiveReply).toBe(
      "Gamma Cloud's FedRAMP status could not be verified from available marketplace evidence.",
    );
    expect(positiveReply).not.toContain('is FedRAMP Certified');
  });

  it('states the observed record when a negative assertion conflicts with a positive record', () => {
    const reply = 'Acme Cloud is not FedRAMP authorized.';
    const checked = checkFedrampStatusClaims(detectFedrampStatusClaims(reply), [evidence()]);
    expect(checked[0]?.outcome).toBe('negative_unsupported');
    const enforced = enforceFedrampStatusReply(reply, checked);
    expect(enforced).toContain('FedRAMP Marketplace record reporting FedRAMP Certified at Moderate impact');
    expect(enforced).not.toContain('is not FedRAMP authorized');
  });

  it('scopes a negative status to its own clause in a multi-entity answer', () => {
    const claims = detectFedrampStatusClaims(
      'Acme Cloud is FedRAMP Certified, but Beta Cloud is not FedRAMP authorized.',
    );
    expect(claims).toEqual([
      expect.objectContaining({ entityMention: 'Acme Cloud', statedStatus: 'FedRAMP Certified', negative: false }),
      expect.objectContaining({ entityMention: 'Beta Cloud', statedStatus: null, negative: true }),
    ]);
  });

  it('extracts the entity from a source-scoped no-match statement', () => {
    expect(detectFedrampStatusClaims('No FedRAMP authorization was found for Gamma Cloud.')).toEqual([
      expect.objectContaining({ entityMention: 'Gamma Cloud', statedStatus: null, negative: true }),
    ]);
  });

  it('recognizes bounded negative paraphrases without widening their entity scope', () => {
    expect(detectFedrampStatusClaims(
      'Acme Cloud has no FedRAMP authorization. Beta Cloud is not authorized by FedRAMP.',
    )).toEqual([
      expect.objectContaining({ entityMention: 'Acme Cloud', statedStatus: null, negative: true }),
      expect.objectContaining({ entityMention: 'Beta Cloud', statedStatus: null, negative: true }),
    ]);
  });

  it('repairs non-exact text with exact status, impact, and source observation', () => {
    const reply = 'Acme Cloud is FedRAMP approved. Other prose stays byte-identical.';
    const checked = checkFedrampStatusClaims(detectFedrampStatusClaims(reply), [evidence()]);
    expect(enforceFedrampStatusReply(reply, checked)).toBe(
      'Acme Cloud is FedRAMP Certified at Moderate impact (FedRAMP Marketplace, observed 2026-09-23T00:00:00.000Z). Other prose stays byte-identical.',
    );
  });
});
