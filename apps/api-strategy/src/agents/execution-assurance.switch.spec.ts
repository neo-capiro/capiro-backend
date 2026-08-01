import { describe, expect, it } from '@jest/globals';
import {
  generationReleaseHoldEnforced,
  generationReleaseModeForTenant,
} from './execution-assurance.js';

describe('Phase 16 strategy artifact rollout', () => {
  it('is off when any legacy all-tenant control is absent', () => {
    expect(generationReleaseHoldEnforced(undefined, 'all', 'all')).toBe(false);
    expect(generationReleaseHoldEnforced('enforce', undefined, 'all')).toBe(false);
    expect(generationReleaseHoldEnforced('enforce', 'all', undefined)).toBe(false);
  });

  it('legacy staging can enforce only through exact global, all-tenant, all-surface controls', () => {
    expect(generationReleaseHoldEnforced('enforce', 'all', 'all')).toBe(true);
    expect(generationReleaseHoldEnforced(' Enforce ', ' all ', ' all ')).toBe(true);
    expect(generationReleaseHoldEnforced('shadow', 'all', 'all')).toBe(false);
    expect(generationReleaseHoldEnforced('enforce', 'tenant-a', 'all')).toBe(false);
    expect(generationReleaseHoldEnforced('enforce', 'all', 'strategy')).toBe(false);
  });

  it('tenant-aware resolver supports independent strategy and outreach canaries', () => {
    expect(
      generationReleaseModeForTenant('tenant-a', 'strategy', 'shadow', 'tenant-a', 'strategy'),
    ).toBe('shadow');
    expect(
      generationReleaseModeForTenant('tenant-a', 'outreach', 'enforce', 'tenant-a', 'outreach'),
    ).toBe('enforce');
    expect(
      generationReleaseModeForTenant('tenant-b', 'strategy', 'enforce', 'tenant-a', 'strategy'),
    ).toBe('off');
    expect(
      generationReleaseModeForTenant('tenant-a', 'outreach', 'enforce', 'tenant-a', 'strategy'),
    ).toBe('off');
  });

  it('fails safe on truthy-looking or near-miss values', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'annotate', 'enforced']) {
      expect(generationReleaseHoldEnforced(raw, 'all', 'all')).toBe(false);
    }
  });
});
