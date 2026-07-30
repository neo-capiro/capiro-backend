import { describe, expect, it } from '@jest/globals';
import {
  CONTEXT_PACKET_V2_SURFACES,
  CONTEXT_POLICY_VERSION,
  contextPacketV2Enabled,
  contextPacketV2Overrides,
  resolveContextPacketMode,
} from './context-release-switch';
import { contextSurfacePolicy, surfacePolicies } from './surface-policy';
import type { ContextSurface } from './contract';

describe('resolveContextPacketMode', () => {
  it('defaults to v1 when the environment variable is unset or empty', () => {
    expect(resolveContextPacketMode(undefined)).toBe('v1');
    expect(resolveContextPacketMode('')).toBe('v1');
    expect(resolveContextPacketMode('   ')).toBe('v1');
  });

  it('returns v1 for every truthy-looking value that is not exactly "enforce"', () => {
    for (const raw of ['true', 'TRUE', '1', 'on', 'yes', 'v2', 'V2', '2', 'enforced', 'enforce!']) {
      expect(resolveContextPacketMode(raw)).toBe('v1');
    }
  });

  it('returns v2 only for "enforce", tolerating surrounding whitespace and case', () => {
    expect(resolveContextPacketMode('enforce')).toBe('v2');
    expect(resolveContextPacketMode(' Enforce ')).toBe('v2');
    expect(resolveContextPacketMode('ENFORCE')).toBe('v2');
  });
});

describe('contextPacketV2Enabled', () => {
  it('is false for every surface while the switch is dark', () => {
    for (const policy of surfacePolicies()) {
      expect(contextPacketV2Enabled(undefined, policy.surface)).toBe(false);
      expect(contextPacketV2Enabled('true', policy.surface)).toBe(false);
    }
  });

  it('is true only for allowlisted surfaces once armed', () => {
    for (const surface of CONTEXT_PACKET_V2_SURFACES) {
      expect(contextPacketV2Enabled('enforce', surface)).toBe(true);
    }
  });

  it('stays false for unaudited body-rendering deliverable surfaces', () => {
    for (const surface of ['memo', 'district-brief', 'outreach', 'research'] as ContextSurface[]) {
      expect(contextPacketV2Enabled('enforce', surface)).toBe(false);
    }
  });

  it('is an allowlist: a surface absent from it is dark even when armed', () => {
    const known = new Set<string>(CONTEXT_PACKET_V2_SURFACES);
    const notAllowlisted = surfacePolicies()
      .map((policy) => policy.surface)
      .filter((surface) => !known.has(surface));
    expect(notAllowlisted.length).toBeGreaterThan(0);
    for (const surface of notAllowlisted) {
      expect(contextPacketV2Enabled('enforce', surface)).toBe(false);
    }
  });
});

describe('contextPacketV2Overrides', () => {
  it('returns an empty object while dark, so the caller request is unchanged', () => {
    expect(
      contextPacketV2Overrides(undefined, { surface: 'in-editor', ethicalWallAllowed: true }),
    ).toEqual({});
    expect(
      contextPacketV2Overrides('1', {
        surface: 'in-editor',
        traceId: 't',
        ethicalWallAllowed: true,
      }),
    ).toEqual({});
    expect(
      contextPacketV2Overrides('enforce', {
        surface: 'memo',
        traceId: 't',
        ethicalWallAllowed: true,
      }),
    ).toEqual({});
  });

  it('opts into contract v2 with required persistence for an editor deliverable', () => {
    const overrides = contextPacketV2Overrides('enforce', {
      surface: 'in-editor',
      traceId: 'trace-1',
      promptVersion: 'legacy-in-editor-v2',
      ethicalWallAllowed: true,
    });
    expect(overrides).toEqual({
      contractVersion: 2,
      ethicalWallAllowed: true,
      traceId: 'trace-1',
      promptVersion: 'legacy-in-editor-v2',
      policyVersion: CONTEXT_POLICY_VERSION,
      compilerVersion: 'context-compiler-v2.0',
      tokenBudget: 6_000,
      budgetUnit: 'tokens',
      persistence: 'required',
    });
  });

  it('marks conversational surfaces best-effort and external surfaces required', () => {
    expect(
      contextPacketV2Overrides('enforce', {
        surface: 'ga-chat',
        ethicalWallAllowed: false,
      }),
    ).toMatchObject({ persistence: 'best-effort' });
    expect(
      contextPacketV2Overrides('enforce', {
        surface: 'steward',
        ethicalWallAllowed: false,
      }),
    ).toMatchObject({ persistence: 'best-effort' });
    for (const surface of ['in-editor', 'workspace-editor', 'strategy', 'workspace-gen'] as const) {
      expect(
        contextPacketV2Overrides('enforce', { surface, ethicalWallAllowed: false }),
      ).toMatchObject({ persistence: 'required' });
      expect(contextSurfacePolicy(surface).externalDeliverable).toBe(true);
    }
  });

  it('forwards only a literal true as wall permission', () => {
    const armed = (ethicalWallAllowed: boolean) =>
      contextPacketV2Overrides('enforce', { surface: 'ga-chat', ethicalWallAllowed });

    expect(armed(true)).toMatchObject({ ethicalWallAllowed: true });
    expect(armed(false)).toMatchObject({ ethicalWallAllowed: false });
    for (const sneaky of ['true', 1, {}, [], 'yes']) {
      expect(
        contextPacketV2Overrides('enforce', {
          surface: 'ga-chat',
          ethicalWallAllowed: sneaky as unknown as boolean,
        }),
      ).toMatchObject({ ethicalWallAllowed: false });
    }
  });
});
