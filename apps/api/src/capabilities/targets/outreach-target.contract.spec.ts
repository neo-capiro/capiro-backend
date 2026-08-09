import {
  createManualTargetLocator,
  createResolvedTargetRefV1,
  normalizeResolvedTargetRefsV1,
  normalizeTargetLocatorV1,
  outreachResolvedTargetRefV1Schema,
  recommendationRefForTarget,
  targetKeyForLocator,
} from './outreach-target.contract.js';

function resolved(id: string, email = 'person@example.test') {
  const locator = createManualTargetLocator({
    id,
    name: '  Person Example  ',
    email: ` ${email.toUpperCase()} `,
    title: ' Policy Director ',
    organization: ' Example Office ',
  });
  return createResolvedTargetRefV1({
    locator,
    displayName: 'Person Example',
    email: locator.email,
    phone: locator.phone,
    title: locator.title,
    organization: locator.organization,
    clientId: null,
    jurisdiction: {
      governmentLevel: 'unknown',
      chamber: null,
      state: null,
      district: null,
      committees: ['Appropriations', 'Appropriations'],
      issueAreas: ['Defense'],
    },
    roleStatus: 'unknown',
    emailStatus: 'available',
    profileStatus: 'limited',
    sourceSnapshot: { system: 'user_supplied', version: null, lastVerifiedAt: null },
  });
}

describe('Outreach target contract', () => {
  it('normalizes manual target identity deterministically', () => {
    const locator = createManualTargetLocator({
      id: '00000000-0000-4000-8000-000000000001',
      name: '  Alex Example ',
      email: ' ALEX@EXAMPLE.TEST ',
      phone: ' 202-555-0100 ',
    });
    expect(locator).toMatchObject({
      source: 'manual',
      name: 'Alex Example',
      email: 'alex@example.test',
      phone: '202-555-0100',
    });
    expect(targetKeyForLocator(locator)).toBe(
      'manual:00000000-0000-4000-8000-000000000001',
    );
  });

  it('creates a content-addressed target snapshot and rejects tampering', () => {
    const target = resolved('00000000-0000-4000-8000-000000000002');
    expect(target.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(target.jurisdiction.committees).toEqual(['Appropriations']);
    expect(() => outreachResolvedTargetRefV1Schema.parse(target)).not.toThrow();
    expect(() =>
      outreachResolvedTargetRefV1Schema.parse({ ...target, title: 'Invented title' }),
    ).toThrow();
  });

  it('deduplicates exact target keys without merging distinct identities by email', () => {
    const first = resolved('00000000-0000-4000-8000-000000000003');
    const duplicateKey = resolved('00000000-0000-4000-8000-000000000003');
    const sameEmailDifferentPerson = resolved(
      '00000000-0000-4000-8000-000000000004',
      first.email!,
    );
    expect(normalizeResolvedTargetRefsV1([first, duplicateKey, sameEmailDifferentPerson])).toHaveLength(2);
  });

  it('creates stable recommendation references from target, criteria and client scope', () => {
    const input = {
      targetKey: 'directory_member:member-1',
      criteriaHash: 'a'.repeat(64),
      clientId: '00000000-0000-4000-8000-000000000005',
    };
    expect(recommendationRefForTarget(input)).toBe(recommendationRefForTarget(input));
    expect(recommendationRefForTarget(input)).toMatch(/^orec_[a-f0-9]{64}$/);
    expect(
      recommendationRefForTarget({ ...input, clientId: null }),
    ).not.toBe(recommendationRefForTarget(input));
  });

  it('rejects unknown target locator fields and source types', () => {
    expect(() =>
      normalizeTargetLocatorV1({ source: 'directory_member', id: 'member-1', tenantId: 'bad' }),
    ).toThrow();
    expect(() => normalizeTargetLocatorV1({ source: 'invented', id: 'person' })).toThrow();
  });
});
