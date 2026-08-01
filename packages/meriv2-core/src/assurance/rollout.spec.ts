import { describe, expect, it } from '@jest/globals';
import {
  assuranceRolloutEnabled,
  assuranceRolloutEnforced,
  resolveAssuranceCanarySurfaces,
  resolveAssuranceGlobalMode,
  resolveAssuranceRolloutMode,
  resolveAssuranceTenantCanaries,
} from './rollout';

describe('Phase 16 assurance rollout', () => {
  it('defaults to off and rejects truthy-looking near misses', () => {
    for (const raw of [undefined, '', 'on', 'true', '1', 'annotate', 'enforced']) {
      expect(resolveAssuranceGlobalMode(raw)).toBe('off');
    }
  });

  it('supports exact shadow and enforce global ceilings', () => {
    expect(resolveAssuranceGlobalMode(' SHADOW ')).toBe('shadow');
    expect(resolveAssuranceGlobalMode('Enforce')).toBe('enforce');
  });

  it('requires global mode, a server-resolved tenant canary, and surface selection', () => {
    const common = { tenantId: 'tenant-a', surface: 'workspace-gen' as const };
    expect(
      resolveAssuranceRolloutMode({
        ...common,
        globalModeRaw: 'enforce',
        tenantCanariesRaw: undefined,
        surfacesRaw: 'workspace-gen',
      }),
    ).toBe('off');
    expect(
      resolveAssuranceRolloutMode({
        ...common,
        globalModeRaw: 'enforce',
        tenantCanariesRaw: 'tenant-a',
        surfacesRaw: undefined,
      }),
    ).toBe('off');
    expect(
      resolveAssuranceRolloutMode({
        ...common,
        globalModeRaw: 'off',
        tenantCanariesRaw: 'tenant-a',
        surfacesRaw: 'workspace-gen',
      }),
    ).toBe('off');
  });

  it('preserves shadow as observe-only and enforce as the only holding mode', () => {
    const input = {
      tenantCanariesRaw: 'tenant-a',
      surfacesRaw: 'chat,workspace-gen',
      tenantId: 'tenant-a',
      surface: 'chat' as const,
    };
    const shadow = resolveAssuranceRolloutMode({ ...input, globalModeRaw: 'shadow' });
    const enforce = resolveAssuranceRolloutMode({ ...input, globalModeRaw: 'enforce' });
    expect(shadow).toBe('shadow');
    expect(assuranceRolloutEnabled(shadow)).toBe(true);
    expect(assuranceRolloutEnforced(shadow)).toBe(false);
    expect(enforce).toBe('enforce');
    expect(assuranceRolloutEnforced(enforce)).toBe(true);
  });

  it('does not widen one tenant or surface into another', () => {
    expect(
      resolveAssuranceRolloutMode({
        globalModeRaw: 'enforce',
        tenantCanariesRaw: 'tenant-a',
        surfacesRaw: 'chat',
        tenantId: 'tenant-b',
        surface: 'chat',
      }),
    ).toBe('off');
    expect(
      resolveAssuranceRolloutMode({
        globalModeRaw: 'enforce',
        tenantCanariesRaw: 'tenant-a',
        surfacesRaw: 'chat',
        tenantId: 'tenant-a',
        surface: 'strategy',
      }),
    ).toBe('off');
  });

  it('supports explicit all while ignoring unknown surface tokens', () => {
    expect([...resolveAssuranceTenantCanaries('all')]).toEqual(['all']);
    expect(resolveAssuranceCanarySurfaces('all').has('steward')).toBe(true);
    expect([...resolveAssuranceCanarySurfaces('workspacegen,in-editor')]).toEqual(['in-editor']);
  });
});
