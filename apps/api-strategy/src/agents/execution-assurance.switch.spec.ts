import { describe, expect, it } from '@jest/globals';
import {
  generationReleaseHoldEnforced,
  generationReleaseModeForTenant,
} from './execution-assurance.js';

describe('Strategies generated-document release gate (advisory-only)', () => {
  it('never enforces a hold regardless of env/tenant/surface controls', () => {
    expect(generationReleaseHoldEnforced(undefined, 'all', 'all')).toBe(false);
    expect(generationReleaseHoldEnforced('enforce', 'all', 'all')).toBe(false);
    expect(generationReleaseHoldEnforced(' Enforce ', ' all ', ' all ')).toBe(false);
    expect(generationReleaseHoldEnforced('enforce', 'tenant-a', 'outreach')).toBe(false);
    expect(generationReleaseHoldEnforced('shadow', 'all', 'all')).toBe(false);
  });

  it('fails safe on truthy-looking or near-miss values (never a mandatory wait)', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'annotate', 'enforced', 'enforce']) {
      expect(generationReleaseHoldEnforced(raw, 'all', 'all')).toBe(false);
    }
  });

  it('retains the tenant-aware mode resolver for observability/compat', () => {
    expect(
      generationReleaseModeForTenant('tenant-a', 'strategy', 'shadow', 'tenant-a', 'strategy'),
    ).toBe('shadow');
    expect(
      generationReleaseModeForTenant('tenant-a', 'outreach', 'enforce', 'tenant-a', 'outreach'),
    ).toBe('enforce');
    expect(
      generationReleaseModeForTenant('tenant-b', 'strategy', 'enforce', 'tenant-a', 'strategy'),
    ).toBe('off');
  });
});
