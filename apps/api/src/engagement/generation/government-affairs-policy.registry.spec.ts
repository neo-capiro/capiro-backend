/**
 * Government-affairs policy registry (Phase 1 §3.f1, §5.3).
 *
 * The load-bearing assertion here is the NEGATIVE one: an ambiguous audience must
 * STOP rather than resolve to federal. A registry that merely defines nine
 * audiences but still defaults to congressional when unsure has not fixed
 * anything — the federal default is the bug.
 */
import { describe, expect, test } from '@jest/globals';
import {
  AudiencePolicyRequiredError,
  GA_AUDIENCES,
  GA_JURISDICTIONS,
  GA_POLICY_VERSION,
  freshnessThresholdDays,
  policyForAudience,
  renderPolicyBlock,
  selectPolicy,
  type GaAudience,
} from './government-affairs-policy.registry.js';

describe('registry completeness', () => {
  test('every one of the nine defined audiences resolves to a policy', () => {
    const expected: GaAudience[] = [
      'congressional_office',
      'federal_agency',
      'state_legislator',
      'state_agency',
      'local_official',
      'coalition',
      'client_executive',
      'internal_colleague',
      'defense_acquisition_office',
    ];
    expect(new Set(GA_AUDIENCES)).toEqual(new Set(expected));
    for (const a of expected) {
      const p = policyForAudience(a);
      expect(p.audienceType).toBe(a);
      expect(p.version).toBe(GA_POLICY_VERSION);
      expect(GA_JURISDICTIONS).toContain(p.jurisdiction);
      // Every policy must actually carry rules — an empty policy would pass
      // selection while governing nothing.
      expect(p.allowedIntents.length).toBeGreaterThan(0);
      expect(p.salutationRule.length).toBeGreaterThan(0);
      expect(p.terminologyRules.length).toBeGreaterThan(0);
      expect(p.prohibitedAssumptions.length).toBeGreaterThan(0);
      expect(p.validators.length).toBeGreaterThan(0);
    }
  });
});

describe('Hill etiquette is scoped to federal audiences', () => {
  test('federal audiences apply it', () => {
    expect(policyForAudience('congressional_office').appliesHillEtiquette).toBe(true);
    expect(policyForAudience('federal_agency').appliesHillEtiquette).toBe(true);
    expect(policyForAudience('defense_acquisition_office').appliesHillEtiquette).toBe(true);
  });

  test('state, local, coalition, client and internal audiences do NOT', () => {
    for (const a of [
      'state_legislator',
      'state_agency',
      'local_official',
      'coalition',
      'client_executive',
      'internal_colleague',
    ] as GaAudience[]) {
      expect(policyForAudience(a).appliesHillEtiquette).toBe(false);
    }
  });

  test('a client executive is not required to receive a single congressional ask', () => {
    const p = policyForAudience('client_executive');
    expect(p.askRules.some((r) => /exactly ONE clear ask/i.test(r))).toBe(false);
    expect(p.askRules.join(' ')).toMatch(/multiple asks are permitted/i);
  });

  test('a congressional office IS held to one ask', () => {
    const p = policyForAudience('congressional_office');
    expect(p.askRules.some((r) => /exactly ONE clear ask/i.test(r))).toBe(true);
  });
});

describe('deterministic selection', () => {
  test('an explicit audience always wins', () => {
    const p = selectPolicy({
      explicitAudience: 'state_agency',
      recipient: { sourceType: 'congress' },
    });
    expect(p.audienceType).toBe('state_agency');
  });

  test("direction 'to-clients' resolves to the client executive policy", () => {
    expect(selectPolicy({ direction: 'to-clients' }).audienceType).toBe('client_executive');
  });

  test('a directory-resolved congressional recipient resolves federal', () => {
    expect(selectPolicy({ recipient: { sourceType: 'congress' } }).audienceType).toBe(
      'congressional_office',
    );
  });

  test('a state legislature source type resolves the STATE policy', () => {
    const p = selectPolicy({ recipient: { sourceType: 'state_legislature' } });
    expect(p.audienceType).toBe('state_legislator');
    expect(p.jurisdiction).toBe('state');
  });

  test('a defense acquisition office wins over a bare source type', () => {
    const p = selectPolicy({ recipient: { sourceType: 'federal_agency', defenseAcquisition: true } });
    expect(p.audienceType).toBe('defense_acquisition_office');
  });

  test('reserved federal legislative domains resolve congressional', () => {
    expect(
      selectPolicy({ recipient: { emailDomain: 'mail.house.gov' } }).audienceType,
    ).toBe('congressional_office');
    expect(selectPolicy({ recipient: { emailDomain: 'senate.gov' } }).audienceType).toBe(
      'congressional_office',
    );
  });

  test('selection is deterministic: the same input resolves identically', () => {
    const input = { recipient: { sourceType: 'state_legislature' } };
    expect(selectPolicy(input).policyId).toBe(selectPolicy(input).policyId);
  });
});

describe('ambiguity STOPS instead of defaulting to federal', () => {
  test('no signals at all raises AUDIENCE_POLICY_REQUIRED', () => {
    expect(() => selectPolicy({})).toThrow(AudiencePolicyRequiredError);
    try {
      selectPolicy({});
    } catch (e) {
      expect((e as AudiencePolicyRequiredError).code).toBe('AUDIENCE_POLICY_REQUIRED');
      expect((e as AudiencePolicyRequiredError).candidates.length).toBe(GA_AUDIENCES.length);
    }
  });

  test('chamber ALONE does not imply federal — most states also have a House', () => {
    // This is the exact silent-federal-default the registry exists to prevent.
    expect(() => selectPolicy({ recipient: { chamber: 'House' } })).toThrow(
      AudiencePolicyRequiredError,
    );
    expect(() => selectPolicy({ recipient: { chamber: 'Senate' } })).toThrow(
      AudiencePolicyRequiredError,
    );
  });

  test('an unrecognized source type does not fall back to congressional', () => {
    expect(() => selectPolicy({ recipient: { sourceType: 'something-new' } })).toThrow(
      AudiencePolicyRequiredError,
    );
  });

  test('a non-government email domain does not imply federal', () => {
    expect(() => selectPolicy({ recipient: { emailDomain: 'example.com' } })).toThrow(
      AudiencePolicyRequiredError,
    );
  });
});

describe('rendered policy text', () => {
  test('the federal block names Hill-appropriate rules', () => {
    const text = renderPolicyBlock(policyForAudience('congressional_office'));
    expect(text).toMatch(/Federal congressional office/);
    expect(text).toMatch(/ENACTED once signed into law/);
    expect(text).toMatch(/AUTHORIZATION .* from APPROPRIATION/);
  });

  test('the state block explicitly forbids federal framing', () => {
    const text = renderPolicyBlock(policyForAudience('state_legislator'));
    expect(text).toMatch(/never/i);
    expect(text).toMatch(/federal/i);
    expect(text).toMatch(/Governor signs/);
    // And must NOT tell the model to use congressional etiquette.
    expect(text).not.toMatch(/Capitol Hill/);
  });

  test('the internal block does not import external-advocacy ask structure', () => {
    const text = renderPolicyBlock(policyForAudience('internal_colleague'));
    expect(text).toMatch(/No external-advocacy ask structure is required/);
  });
});

describe('per-evidence-type freshness thresholds (§6.6)', () => {
  test('a bill ages faster than a durable client fact', () => {
    const p = policyForAudience('congressional_office');
    expect(freshnessThresholdDays(p, 'bill')).toBeLessThan(freshnessThresholdDays(p, 'client'));
  });

  test('an acquisition audience holds budget data to a tighter window', () => {
    expect(
      freshnessThresholdDays(policyForAudience('defense_acquisition_office'), 'programElement'),
    ).toBeLessThan(
      freshnessThresholdDays(policyForAudience('congressional_office'), 'programElement'),
    );
  });

  test('an UNKNOWN evidence type falls back to the most conservative threshold', () => {
    const p = policyForAudience('congressional_office');
    const unknown = freshnessThresholdDays(p, 'some-new-source');
    const min = Math.min(...Object.values(p.freshness));
    expect(unknown).toBe(min);
  });
});
