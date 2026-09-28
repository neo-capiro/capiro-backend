import { describe, expect, it } from '@jest/globals';
import {
  checkFedrampStatusClaims,
  detectFedrampStatusClaims,
  enforceFedrampStatusReply,
  type CertificationStatusEvidence,
} from './status-provenance';

const evidence = (
  overrides: Partial<CertificationStatusEvidence> = {},
): CertificationStatusEvidence => ({
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
    expect(
      detectFedrampStatusClaims(
        [
          'Acme Cloud is FedRAMP Certified at Moderate impact.',
          'Beta is FedRAMP approved.',
          'No FedRAMP authorization was found for Gamma.',
          'FedRAMP publishes a marketplace.',
        ].join(' '),
      ),
    ).toEqual([
      expect.objectContaining({
        entityMention: 'Acme Cloud',
        statedStatus: 'FedRAMP Certified',
        statedImpactLevel: 'Moderate',
        negative: false,
      }),
      expect.objectContaining({
        entityMention: 'Beta',
        statedStatus: 'FedRAMP approved',
        negative: false,
      }),
      expect.objectContaining({ statedStatus: null, negative: true }),
    ]);
  });

  it('classifies exact strings, explicit paraphrases, mismatches, and missing entities', () => {
    const claims = detectFedrampStatusClaims(
      'Acme Cloud is FedRAMP Certified at Moderate. Acme Cloud is FedRAMP approved. Acme Cloud is FedRAMP In Process. Beta is FedRAMP Certified.',
    );
    expect(checkFedrampStatusClaims(claims, [evidence()]).map((item) => item.outcome)).toEqual([
      'exact',
      'paraphrased',
      'mismatch',
      'unsupported',
    ]);
  });

  it('never accepts self-reported fields as verification', () => {
    const claims = detectFedrampStatusClaims('Acme Cloud is FedRAMP Certified.');
    expect(checkFedrampStatusClaims(claims, [evidence({ selfReported: true })])[0]?.outcome).toBe(
      'unsupported',
    );
  });

  it('requires complete authoritative coverage for a negative claim', () => {
    const claims = detectFedrampStatusClaims('Acme Cloud is not FedRAMP authorized.');
    expect(checkFedrampStatusClaims(claims, [evidence()])[0]?.outcome).toBe('negative_unsupported');
    expect(
      checkFedrampStatusClaims(claims, [
        evidence({
          coverage: {
            description: 'entire FedRAMP marketplace',
            complete: true,
            truncated: false,
            failedSources: [],
          },
        }),
      ])[0]?.outcome,
    ).toBe('exact');
  });

  it('repairs non-exact text with exact status, impact, and source observation', () => {
    const reply = 'Acme Cloud is FedRAMP approved. Other prose stays byte-identical.';
    const checked = checkFedrampStatusClaims(detectFedrampStatusClaims(reply), [evidence()]);
    expect(enforceFedrampStatusReply(reply, checked)).toBe(
      'Acme Cloud is FedRAMP Certified at Moderate impact (FedRAMP Marketplace, observed 2026-09-23T00:00:00.000Z). Other prose stays byte-identical.',
    );
  });
});
