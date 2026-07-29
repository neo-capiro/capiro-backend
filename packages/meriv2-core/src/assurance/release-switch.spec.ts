import { describe, expect, it } from '@jest/globals';
import {
  ASSURANCE_SURFACES,
  assuranceReleaseArmedFor,
  resolveAssuranceReleaseMode,
  resolveAssuranceReleaseSurfaces,
} from './risk-gate';

/**
 * The property under test is safety, not parsing: `classifyAssuranceRisk` buffers
 * every external/strategy artifact and any high-risk factual category, so if this
 * switch ever defaulted to armed, deploying the code alone would start replacing
 * ordinary Meri answers with verification refusals.
 */
describe('resolveAssuranceReleaseMode', () => {
  it('is off when unset — deploying must never arm the hold by itself', () => {
    expect(resolveAssuranceReleaseMode(undefined)).toBe('off');
    expect(resolveAssuranceReleaseMode('')).toBe('off');
    expect(resolveAssuranceReleaseMode('   ')).toBe('off');
  });

  it('arms only on an explicit enforce value', () => {
    expect(resolveAssuranceReleaseMode('enforce')).toBe('enforce');
    expect(resolveAssuranceReleaseMode(' ENFORCE ')).toBe('enforce');
    expect(resolveAssuranceReleaseMode('Enforce')).toBe('enforce');
  });

  it('fails safe on truthy-looking or near-miss values rather than guessing', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'annotate', 'enforced', 'hold']) {
      expect(resolveAssuranceReleaseMode(raw)).toBe('off');
    }
  });
});

/**
 * The per-surface switch exists so that arming one surface's withhold cannot arm
 * the others. `MERI_RELEASE_GATE` is already read by two independently-deployed
 * services (orchestrator chat finalize + api-strategy generation hold); every
 * surface added after chat is named here instead, so one flip can never arm six
 * behaviours at once.
 */
describe('resolveAssuranceReleaseSurfaces', () => {
  it('arms nothing when unset — deploying the code alone withholds no output', () => {
    for (const raw of [undefined, '', '   ', ',', ' , , ']) {
      expect([...resolveAssuranceReleaseSurfaces(raw)]).toEqual([]);
    }
    for (const surface of ASSURANCE_SURFACES) {
      expect(assuranceReleaseArmedFor(undefined, surface)).toBe(false);
      expect(assuranceReleaseArmedFor('', surface)).toBe(false);
    }
  });

  it('does NOT inherit MERI_RELEASE_GATE=enforce — the two switches are independent', () => {
    // A deployment that only sets MERI_RELEASE_GATE=enforce (today's chat +
    // api-strategy canary) must leave every newly-gated surface dark.
    for (const surface of ASSURANCE_SURFACES) {
      expect(assuranceReleaseArmedFor('enforce', surface)).toBe(false);
    }
  });

  it('arms only the surfaces actually named', () => {
    expect(assuranceReleaseArmedFor('in-editor', 'in-editor')).toBe(true);
    expect(assuranceReleaseArmedFor('in-editor', 'workspace-gen')).toBe(false);
    expect(assuranceReleaseArmedFor('workspace-gen, steward', 'steward')).toBe(true);
    expect(assuranceReleaseArmedFor('workspace-gen, steward', 'strategy')).toBe(false);
    expect(assuranceReleaseArmedFor(' IN-EDITOR ', 'in-editor')).toBe(true);
  });

  it('honours the explicit all token', () => {
    const armed = resolveAssuranceReleaseSurfaces('all');
    for (const surface of ASSURANCE_SURFACES) expect(armed.has(surface)).toBe(true);
  });

  it('ignores unknown tokens instead of arming or throwing on a typo', () => {
    expect([...resolveAssuranceReleaseSurfaces('in_editor,workspacegen,everything')]).toEqual([]);
    // A typo alongside a real surface arms ONLY the real one.
    expect([...resolveAssuranceReleaseSurfaces('in-editor,workspacegen')]).toEqual(['in-editor']);
  });
});
