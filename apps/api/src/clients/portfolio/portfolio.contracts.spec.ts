import { BadRequestException } from '@nestjs/common';
import {
  proposalSchema,
  parsePortfolio,
  proposalKey,
  hasOfficialEvidence,
  capabilityPayloadSchema,
  sectorPayloadSchema,
  type PortfolioProposalInput,
} from './portfolio.contracts.js';
const evidence = [
  {
    url: 'https://example.gov/fixture',
    title: 'Synthetic test document',
    excerpt: 'A test evidence marker, not a statement attributed to an office.',
    observedAt: '2026-01-01T00:00:00.000Z',
    sourceType: 'official' as const,
  },
];
const capability = {
  kind: 'capability',
  payload: {
    name: 'Test component',
    type: 'component',
    lifecycle: 'in_development',
    description: 'Synthetic recorded fixture',
    tags: ['family'],
    classification: 'capability',
  },
  evidence,
};

describe('portfolio domain contracts', () => {
  it.each(['family', 'category', 'feature', 'market'])(
    'does not promote a %s into a capability',
    (classification) => {
      expect(() =>
        parsePortfolio(proposalSchema, {
          ...capability,
          payload: { ...capability.payload, classification },
        }),
      ).toThrow(BadRequestException);
    },
  );
  it.each(['product', 'platform', 'service', 'program', 'component'])(
    'supports named %s capabilities',
    (type) => {
      expect(capabilityPayloadSchema.parse({ ...capability.payload, type }).type).toBe(type);
    },
  );
  it('rejects unsupported capability types, lifecycle states and blank names', () => {
    for (const change of [{ type: 'family' }, { lifecycle: 'confirmed_by_model' }, { name: ' ' }])
      expect(capabilityPayloadSchema.safeParse({ ...capability.payload, ...change }).success).toBe(
        false,
      );
  });
  it('uses stable rejection identity across source refreshes and name whitespace/case', () => {
    const first = parsePortfolio(proposalSchema, capability);
    const refreshed = parsePortfolio(proposalSchema, {
      ...capability,
      payload: { ...capability.payload, name: ' TEST   COMPONENT ' },
      evidence: [{ ...evidence[0], url: 'https://example.gov/new' }],
    });
    expect(proposalKey(first)).toBe(proposalKey(refreshed));
  });
  it('does not confuse capability scoped alignment identities', () => {
    const input = {
      kind: 'alignment',
      capabilityId: '10000000-0000-4000-8000-000000000001',
      payload: { targetType: 'keyword', value: 'sensor', rationale: 'Test evidence' },
      evidence,
    } as PortfolioProposalInput;
    expect(proposalKey(input)).not.toBe(
      proposalKey({ ...input, capabilityId: '10000000-0000-4000-8000-000000000002' }),
    );
  });
  it('requires dated source evidence and rejects future observations', () => {
    for (const changed of [
      [],
      [{ ...evidence[0], observedAt: '2099-01-01T00:00:00Z' }],
      [{ ...evidence[0], url: undefined }],
      [{ ...evidence[0], url: 'javascript:alert(1)' }],
    ])
      expect(proposalSchema.safeParse({ ...capability, evidence: changed }).success).toBe(false);
  });
  it('social-only sources or a claimed official label on a nonofficial domain are insufficient', () => {
    expect(hasOfficialEvidence(evidence)).toBe(true);
    expect(hasOfficialEvidence([{ ...evidence[0]!, url: 'https://social.example/post' }])).toBe(
      false,
    );
    expect(
      hasOfficialEvidence([{ ...evidence[0]!, url: 'https://senate.gov.evil.example/post' }]),
    ).toBe(false);
  });
  it('requires term/directory binding on member fields', () => {
    expect(
      proposalSchema.safeParse({
        kind: 'case_field',
        payload: { field: 'impact', text: 'Source-backed fixture', memberId: 'fixture-office' },
        evidence,
      }).success,
    ).toBe(false);
  });
  it.each(['119', '119th', '119th Congress', 'Congress:119', 'congress:0119'])(
    'rejects ambiguous Congress term alias %s before deduplication',
    (officeTerm) => {
      expect(
        proposalSchema.safeParse({
          kind: 'statement',
          payload: {
            memberId: 'fixture-office',
            sourceDirectory: 'congress',
            officeTerm,
            statementDate: '2026-01-01T00:00:00.000Z',
            summary: 'Test fixture',
          },
          evidence,
        }).success,
      ).toBe(false);
      expect(
        proposalSchema.safeParse({
          kind: 'case_field',
          payload: {
            field: 'impact',
            text: 'Test fixture',
            memberId: 'fixture-office',
            sourceDirectory: 'congress',
            officeTerm,
          },
          evidence,
        }).success,
      ).toBe(false);
    },
  );
  it('models health/agriculture/defense anchors and checks maturity membership', () => {
    const maturity = { current: 'research', steps: ['research', 'validation'] };
    expect(
      sectorPayloadSchema.safeParse({
        sector: 'health',
        agency: 'Fixture agency',
        account: 'Fixture account',
        program: 'Fixture program',
        maturity,
      }).success,
    ).toBe(true);
    expect(
      sectorPayloadSchema.safeParse({
        sector: 'agriculture',
        agency: 'USDA',
        program: 'Fixture program',
        farmBillTitle: 'Fixture title',
        maturity,
      }).success,
    ).toBe(true);
    expect(
      sectorPayloadSchema.safeParse({
        sector: 'defense',
        pe: '0600000A',
        maturity: { ...maturity, current: 'unsupported' },
      }).success,
    ).toBe(false);
  });
});
