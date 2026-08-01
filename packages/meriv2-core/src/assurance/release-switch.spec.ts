import { describe, expect, it } from '@jest/globals';
import {
  ASSURANCE_SURFACES,
  assuranceReleaseArmedFor,
  resolveAssuranceReleaseMode,
  resolveAssuranceReleaseSurfaces,
} from './risk-gate';

describe('resolveAssuranceReleaseMode legacy chat path', () => {
  it('is off when any required control is absent', () => {
    expect(resolveAssuranceReleaseMode(undefined, 'all', 'chat')).toBe('off');
    expect(resolveAssuranceReleaseMode('enforce', undefined, 'chat')).toBe('off');
    expect(resolveAssuranceReleaseMode('enforce', 'all', undefined)).toBe('off');
  });

  it('supports exact shadow and enforce only for explicit all-tenant chat canary', () => {
    expect(resolveAssuranceReleaseMode('shadow', 'all', 'chat')).toBe('shadow');
    expect(resolveAssuranceReleaseMode('enforce', 'all', 'chat')).toBe('enforce');
    expect(resolveAssuranceReleaseMode(' ENFORCE ', ' all ', 'all')).toBe('enforce');
  });

  it('fails safe on truthy-looking or near-miss values', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'annotate', 'enforced', 'hold']) {
      expect(resolveAssuranceReleaseMode(raw, 'all', 'chat')).toBe('off');
    }
  });
});

describe('resolveAssuranceReleaseSurfaces', () => {
  it('parses no surfaces when unset', () => {
    for (const raw of [undefined, '', '   ', ',', ' , , ']) {
      expect([...resolveAssuranceReleaseSurfaces(raw)]).toEqual([]);
    }
  });

  it('legacy no-tenant arming requires global enforce and all tenants', () => {
    expect(assuranceReleaseArmedFor('in-editor', 'in-editor', undefined, 'all')).toBe(false);
    expect(assuranceReleaseArmedFor('in-editor', 'in-editor', 'enforce', undefined)).toBe(false);
    expect(assuranceReleaseArmedFor('in-editor', 'in-editor', 'enforce', 'all')).toBe(true);
  });

  it('arms only the surfaces actually named', () => {
    expect(assuranceReleaseArmedFor('in-editor', 'in-editor', 'enforce', 'all')).toBe(true);
    expect(assuranceReleaseArmedFor('in-editor', 'workspace-gen', 'enforce', 'all')).toBe(false);
    expect(assuranceReleaseArmedFor('workspace-gen, steward', 'steward', 'enforce', 'all')).toBe(
      true,
    );
    expect(assuranceReleaseArmedFor('workspace-gen, steward', 'strategy', 'enforce', 'all')).toBe(
      false,
    );
  });

  it('honours the explicit all token', () => {
    const armed = resolveAssuranceReleaseSurfaces('all');
    for (const surface of ASSURANCE_SURFACES) expect(armed.has(surface)).toBe(true);
  });

  it('ignores unknown tokens instead of arming on a typo', () => {
    expect([...resolveAssuranceReleaseSurfaces('in_editor,workspacegen,everything')]).toEqual([]);
    expect([...resolveAssuranceReleaseSurfaces('in-editor,workspacegen')]).toEqual(['in-editor']);
  });
});
