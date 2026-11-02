import { describe, expect, it } from '@jest/globals';
import { objectiveConsentPolicyTerms } from '../../../auth/workload-authority/objective-consent-policy.js';
import { consentSessionExpiresAtMs } from './objective-work.service.js';

const NOW = 1_800_000_000_000;
const TOKEN = NOW + 60_000;
const MINUTE = 60_000;

/** The exact consent terms ObjectiveWorkService's policy port feeds into a new Strategy or Planner consent. */
function terms(proof: { expiresAtMs: number; sessionExpiresAtMs?: unknown }, tenantDurationLimitMs: number | null = null) {
  return objectiveConsentPolicyTerms({
    operation: 'objective.strategy.draft', databaseNowMs: NOW, configuredDurationMs: 30 * MINUTE,
    tenantDurationLimitMs, actionDurationLimitMs: 30 * MINUTE,
    originalTokenExpiresAtMs: consentSessionExpiresAtMs(proof as { expiresAtMs: number; sessionExpiresAtMs?: number }),
    originalDelegationExpiresAtMs: null, priorOutcomeUnconfirmed: false,
  });
}

describe('objective work consent deadline bound', () => {
  it('uses the verified session lifetime, not the ~60 s request token', () => {
    expect(consentSessionExpiresAtMs({ expiresAtMs: TOKEN, sessionExpiresAtMs: NOW + 120 * MINUTE })).toBe(NOW + 120 * MINUTE);
  });

  for (const [name, value] of [
    ['absent', undefined], ['NaN', Number.NaN], ['fractional', NOW + 1.5], ['a string', String(NOW + 120 * MINUTE)],
    ['shorter than the request token', TOKEN - 1], ['unsafe', Number.MAX_SAFE_INTEGER + 2],
  ] as const) {
    it(`falls back to the request token expiry when the session lifetime is ${name}`, () => {
      const proof = { expiresAtMs: TOKEN, ...(value === undefined ? {} : { sessionExpiresAtMs: value }) };
      expect(consentSessionExpiresAtMs(proof as { expiresAtMs: number; sessionExpiresAtMs?: number })).toBe(TOKEN);
    });
  }

  it('a consent issued with a 60 s token is bounded by the session lifetime and still by the 30-minute policy', () => {
    const long = terms({ expiresAtMs: TOKEN, sessionExpiresAtMs: NOW + 120 * MINUTE });
    expect(long.expiresAtMs).toBe(NOW + 30 * MINUTE);
    expect(long.effectiveDurationMs).toBe(30 * MINUTE);
    const short = terms({ expiresAtMs: TOKEN, sessionExpiresAtMs: NOW + 10 * MINUTE });
    expect(short.expiresAtMs).toBe(NOW + 10 * MINUTE);
    expect(terms({ expiresAtMs: TOKEN, sessionExpiresAtMs: NOW + 120 * MINUTE }, 5 * MINUTE).expiresAtMs).toBe(NOW + 5 * MINUTE);
  });

  it('without a session lifetime the consent keeps the current token-bounded behaviour', () => {
    expect(terms({ expiresAtMs: TOKEN }).expiresAtMs).toBe(TOKEN);
    expect(terms({ expiresAtMs: TOKEN, sessionExpiresAtMs: Number.NaN }).expiresAtMs).toBe(TOKEN);
  });
});
