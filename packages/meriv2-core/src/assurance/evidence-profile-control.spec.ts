import { describe, expect, it, jest } from '@jest/globals';
import { buildControlledClaimLedger } from './evidence-profile-control';

const tenantId = '11111111-1111-4111-8111-111111111111';
const common = {
  output: 'The client is a strong match [1].',
  ledgerEntries: [{ tool: 'search_capiro_data', serialized: '{"id":"match-1"}' }],
  citations: [{ n: 1, tool: 'search_capiro_data', id: 'match-1' }],
  tenantId,
  surface: 'chat' as const,
  callSite: 'caller-test',
};

describe('buildControlledClaimLedger', () => {
  it('keeps off legacy, shadows once without sensitive text, and enforces profiles', () => {
    const enrolled = {
      MERI_EVIDENCE_PROFILES_TENANTS: tenantId,
      MERI_EVIDENCE_PROFILES_SURFACES: 'chat',
    };
    const logShadow = jest.fn();
    const off = buildControlledClaimLedger({ ...common, env: {}, logShadow });
    expect(off.claims[0]).toMatchObject({ primarySourcePresent: true, confidence: 'high' });
    expect(logShadow).not.toHaveBeenCalled();

    const shadow = buildControlledClaimLedger({
      ...common,
      env: { ...enrolled, MERI_EVIDENCE_PROFILES_MODE: 'shadow' },
      logShadow,
    });
    expect(shadow).toEqual(off);
    expect(logShadow).toHaveBeenCalledTimes(1);
    const [event, fields] = logShadow.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('meri.evidence_profiles.shadow');
    expect(fields).toMatchObject({
      surface: 'chat',
      callSite: 'caller-test',
      evidenceChanged: 1,
      claimSupportChanged: 1,
    });
    expect(JSON.stringify(fields)).not.toContain(common.output);

    const enforce = buildControlledClaimLedger({
      ...common,
      env: { ...enrolled, MERI_EVIDENCE_PROFILES_MODE: 'enforce' },
      logShadow,
    });
    expect(enforce.claims[0]).toMatchObject({ primarySourcePresent: false, confidence: 'unknown' });
    expect(logShadow).toHaveBeenCalledTimes(1);
  });

  it('swallows shadow logger failures and returns the legacy ledger', () => {
    const ledger = buildControlledClaimLedger({
      ...common,
      env: {
        MERI_EVIDENCE_PROFILES_MODE: 'shadow',
        MERI_EVIDENCE_PROFILES_TENANTS: tenantId,
        MERI_EVIDENCE_PROFILES_SURFACES: 'chat',
      },
      logShadow: () => { throw new Error('logger unavailable'); },
    });
    expect(ledger.claims[0]).toMatchObject({ primarySourcePresent: true, confidence: 'high' });
  });
});