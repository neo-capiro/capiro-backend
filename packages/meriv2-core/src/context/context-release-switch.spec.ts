import { describe, expect, it } from '@jest/globals';
import {
  CONTEXT_PACKET_V2_SURFACES,
  CONTEXT_PACKET_V2_TENANT_FLAG,
  CONTEXT_POLICY_VERSION,
  contextPacketSurfaceFlag,
  contextPacketV2Enabled,
  contextPacketV2Overrides,
  resolveContextPacketMode,
  resolveTenantContextPacketMode,
  tenantContextPacketCanaryEnabled,
} from './context-release-switch';
import {
  appliedContextSurfacePolicy,
  contextSurfacePolicy,
  surfacePolicies,
} from './surface-policy';

const settings = (flags: Record<string, unknown>) => ({ clioFeatureFlags: flags });
const enabled = (surface: (typeof CONTEXT_PACKET_V2_SURFACES)[number]) =>
  settings({
    [CONTEXT_PACKET_V2_TENANT_FLAG]: true,
    [contextPacketSurfaceFlag(surface)]: true,
  });

describe('Phase 8 Context Packet rollout switch', () => {
  it('defaults and unknown values fail closed to off', () => {
    for (const raw of [undefined, '', 'true', '1', 'on', 'v2', 'enforced', 'enforce!']) {
      expect(resolveContextPacketMode(raw)).toBe('off');
    }
  });

  it('accepts only exact shadow and enforce modes, case-insensitively', () => {
    expect(resolveContextPacketMode(' shadow ')).toBe('shadow');
    expect(resolveContextPacketMode('SHADOW')).toBe('shadow');
    expect(resolveContextPacketMode(' Enforce ')).toBe('enforce');
    expect(resolveContextPacketMode('ENFORCE')).toBe('enforce');
  });

  it('requires both the server-read tenant canary and the exact surface opt-in', () => {
    expect(tenantContextPacketCanaryEnabled(enabled('ga-chat'), 'ga-chat')).toBe(true);
    expect(
      tenantContextPacketCanaryEnabled(
        settings({ [CONTEXT_PACKET_V2_TENANT_FLAG]: true }),
        'ga-chat',
      ),
    ).toBe(false);
    expect(
      tenantContextPacketCanaryEnabled(
        settings({ [contextPacketSurfaceFlag('ga-chat')]: true }),
        'ga-chat',
      ),
    ).toBe(false);
    expect(
      tenantContextPacketCanaryEnabled(
        settings({
          [CONTEXT_PACKET_V2_TENANT_FLAG]: true,
          [contextPacketSurfaceFlag('ga-chat')]: false,
        }),
        'ga-chat',
      ),
    ).toBe(false);
    expect(tenantContextPacketCanaryEnabled(settings({}), 'ga-chat')).toBe(false);
    expect(tenantContextPacketCanaryEnabled(null, 'ga-chat')).toBe(false);
  });

  it('keeps tenant B and every unselected surface off while tenant A can canary one surface', () => {
    const tenantA = enabled('memo');
    const tenantB = settings({
      [CONTEXT_PACKET_V2_TENANT_FLAG]: true,
      [contextPacketSurfaceFlag('memo')]: false,
    });
    expect(resolveTenantContextPacketMode('shadow', tenantA, 'memo')).toBe('shadow');
    expect(resolveTenantContextPacketMode('shadow', tenantA, 'outreach')).toBe('off');
    expect(resolveTenantContextPacketMode('shadow', tenantB, 'memo')).toBe('off');
    expect(resolveTenantContextPacketMode('enforce', tenantA, 'memo')).toBe('enforce');
    expect(resolveTenantContextPacketMode('off', tenantA, 'memo')).toBe('off');
  });
});

describe('Phase 8 surface policy', () => {
  it('defines every known surface and includes the formerly excluded deliverables', () => {
    expect(CONTEXT_PACKET_V2_SURFACES).toEqual(surfacePolicies().map((policy) => policy.surface));
    for (const surface of ['outreach', 'memo', 'district-brief', 'research'] as const) {
      expect(CONTEXT_PACKET_V2_SURFACES).toContain(surface);
      expect(contextSurfacePolicy(surface).externalDeliverable).toBe(true);
      expect(contextSurfacePolicy(surface).renderEnvelope).toBe('plain');
    }
  });

  it('has explicit required, optional, persistence, budget, sensitivity and render policy', () => {
    for (const policy of surfacePolicies()) {
      expect(policy.requiredLayers.length).toBeGreaterThan(0);
      expect(policy.tokenBudget).toBeGreaterThan(0);
      expect(['required', 'best-effort']).toContain(policy.persistence);
      expect(policy.allowedSensitivities.length).toBeGreaterThan(0);
      expect(['typed', 'plain']).toContain(policy.renderEnvelope);
      expect(policy.layers).toEqual(
        expect.arrayContaining([
          ...policy.requiredLayers,
          ...policy.clientRequiredLayers,
          ...policy.optionalLayers,
          ...policy.clientOptionalLayers,
        ]),
      );
    }
  });

  it('adds client-required layers only when a client is in scope', () => {
    expect(appliedContextSurfacePolicy('memo', null).requiredLayers).toEqual(['firm-identity']);
    expect(appliedContextSurfacePolicy('memo', 'client-1').requiredLayers).toEqual([
      'firm-identity',
      'client-steering',
    ]);
  });
});

describe('legacy request helper compatibility', () => {
  it('is dark for off and shadow because neither may replace model input', () => {
    expect(
      contextPacketV2Overrides(undefined, { surface: 'in-editor', ethicalWallAllowed: true }),
    ).toEqual({});
    expect(
      contextPacketV2Overrides('shadow', { surface: 'in-editor', ethicalWallAllowed: true }),
    ).toEqual({});
  });

  it('produces v2 defaults only under enforce', () => {
    const overrides = contextPacketV2Overrides('enforce', {
      surface: 'in-editor',
      traceId: 'trace-1',
      promptVersion: 'prompt-v2',
      ethicalWallAllowed: true,
    });
    expect(overrides).toMatchObject({
      contractVersion: 2,
      ethicalWallAllowed: true,
      traceId: 'trace-1',
      promptVersion: 'prompt-v2',
      policyVersion: CONTEXT_POLICY_VERSION,
      tokenBudget: 6_000,
      budgetUnit: 'tokens',
      persistence: 'required',
    });
    expect(contextPacketV2Enabled('enforce', 'memo')).toBe(true);
    expect(contextPacketV2Enabled('shadow', 'memo')).toBe(false);
  });
});
