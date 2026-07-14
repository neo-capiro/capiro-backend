import { resolveEntitlements, isFeatureEntitled, ENTITLEMENT_FEATURES } from '@capiro/shared';
import { entitlementsForTenant } from './tenant-flags.js';

describe('entitlements (Phase 5 §5.1 — no-op tier architecture)', () => {
  it('5.1.2: every tier grants EVERY feature today (zero access change on ship)', () => {
    for (const tier of ['FOUNDATION', 'GROWTH', 'ENTERPRISE']) {
      const set = resolveEntitlements(tier);
      for (const f of ENTITLEMENT_FEATURES) expect(set.has(f)).toBe(true);
    }
  });

  it('5.1.4: core memory governance is entitled for EVERY tier and never gated', () => {
    for (const tier of ['FOUNDATION', 'GROWTH', 'ENTERPRISE', 'bogus', '', null, undefined]) {
      expect(isFeatureEntitled(tier as string, 'memoryGovernance')).toBe(true);
    }
  });

  it('fails OPEN: unknown/null tier resolves to FOUNDATION (all features), never denies', () => {
    for (const bad of ['nope', '', null, undefined]) {
      const set = resolveEntitlements(bad as string);
      for (const f of ENTITLEMENT_FEATURES) expect(set.has(f)).toBe(true);
    }
  });

  it('5.1.3: default settings change nothing (every feature stays entitled)', () => {
    const out = entitlementsForTenant(undefined, 'FOUNDATION');
    for (const f of ENTITLEMENT_FEATURES) expect(out[f]).toBe(true);
    expect(entitlementsForTenant({}, null)).toEqual(out);
  });

  it('5.1.3: a per-tenant boolean override flips a single feature via the SAME flag reader', () => {
    const out = entitlementsForTenant(
      { clioFeatureFlags: { 'entitlement.peWatch': false } },
      'FOUNDATION',
    );
    expect(out.peWatch).toBe(false);
    // memoryGovernance is unaffected and other features stay granted
    expect(out.memoryGovernance).toBe(true);
    expect(out.defenseBudgetIntel).toBe(true);
  });

  it('5.1.4: a per-tenant override CANNOT revoke an ALWAYS_ENTITLED feature', () => {
    // Even an explicit false override must not gate core memory governance.
    const out = entitlementsForTenant(
      { clioFeatureFlags: { 'entitlement.memoryGovernance': false } },
      'FOUNDATION',
    );
    expect(out.memoryGovernance).toBe(true);
    // ...and the floor holds regardless of tier (including unknown/null).
    expect(
      entitlementsForTenant({ clioFeatureFlags: { 'entitlement.memoryGovernance': false } }, null)
        .memoryGovernance,
    ).toBe(true);
  });
});
