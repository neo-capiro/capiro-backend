import { describe, expect, it, jest } from '@jest/globals';
import {
  CONTEXT_PACKET_V2_ENV,
  CONTEXT_PACKET_V2_TENANT_FLAG,
  compileContextPacketForRollout,
  contextPacketV2Enabled,
  contextPacketV2Overrides,
  contextPacketV2TenantEnabled,
  resolveContextPacketMode,
  resolveContextPacketRollout,
} from './context-release-switch';
import type { CompiledContextPacket, ContextRequest } from './contract';

const request: ContextRequest = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clientId: 'client-1',
  surface: 'chat',
  layers: ['firm-identity', 'client-steering'],
  contractVersion: 2,
  ethicalWallAllowed: true,
  tokenBudget: 999,
  traceId: 'browser-trace',
};

function packet(version: 1 | 2): CompiledContextPacket {
  return {
    packetId: `packet-${version}`,
    version,
    surface: 'chat',
    tenantId: 'tenant-1',
    userId: 'user-1',
    clientId: 'client-1',
    ref: {},
    items: [],
    exclusions: [],
    rendered: [],
    traceHash: `hash-${version}`,
    persisted: true,
    compiledAt: '2026-07-30T00:00:00.000Z',
    ...(version === 2
      ? {
          effectiveTenantId: 'tenant-1',
          actorUserId: 'user-1',
          traceId: null,
          promptVersion: null,
          policyVersion: 'context-policy-v2.0',
          compilerVersion: 'context-compiler-v2',
          requiredLayers: ['firm-identity', 'client-steering'] as const,
          health: {
            status: 'healthy' as const,
            missingRequiredLayers: [],
            conflictCount: 0,
            sourceFailureCount: 0,
            reasons: [],
          },
          totalTokenBudget: 1,
          usedTokens: 0,
          truncated: false,
          incomplete: false,
        }
      : {}),
  } as CompiledContextPacket;
}

describe('Context Packet v2 rollout', () => {
  it('uses the new three-state environment and fails closed on near misses', () => {
    expect(CONTEXT_PACKET_V2_ENV).toBe('MERIV2_CONTEXT_PACKET_V2');
    expect(resolveContextPacketMode(undefined)).toBe('off');
    expect(resolveContextPacketMode('shadow')).toBe('shadow');
    expect(resolveContextPacketMode(' Enforce ')).toBe('enforce');
    for (const raw of ['true', '1', 'on', 'v2', 'enforced', 'CONTEXT_PACKET_V2']) {
      expect(resolveContextPacketMode(raw)).toBe('off');
    }
  });

  it('requires an explicit per-tenant true and an audited surface', () => {
    expect(CONTEXT_PACKET_V2_TENANT_FLAG).toBe('meriv2.contextPacketV2');
    expect(contextPacketV2TenantEnabled({})).toBe(false);
    expect(
      contextPacketV2TenantEnabled({
        clioFeatureFlags: { [CONTEXT_PACKET_V2_TENANT_FLAG]: true },
      }),
    ).toBe(true);
    expect(resolveContextPacketRollout('enforce', false, 'chat')).toBe('off');
    expect(resolveContextPacketRollout('enforce', true, 'memo')).toBe('off');
    expect(resolveContextPacketRollout('shadow', true, 'chat')).toBe('shadow');
    expect(contextPacketV2Enabled('enforce', 'chat', true)).toBe(true);
  });

  it('keeps the legacy request helper dark unless the tenant is explicitly enabled', () => {
    expect(
      contextPacketV2Overrides('enforce', {
        surface: 'chat',
        ethicalWallAllowed: true,
      }),
    ).toEqual({});
    expect(
      contextPacketV2Overrides('enforce', {
        surface: 'chat',
        ethicalWallAllowed: true,
        tenantEnabled: true,
      }),
    ).toMatchObject({ contractVersion: 2, ethicalWallAllowed: true });
  });

  it('shadow persists both contracts but returns v1 and strips caller-supplied control fields', async () => {
    const compile = jest.fn(async (req: ContextRequest) => packet(req.contractVersion === 2 ? 2 : 1));
    const result = await compileContextPacketForRollout({
      request,
      mode: 'shadow',
      ethicalWallAllowed: false,
      compile,
    });
    expect(result.version).toBe(1);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[0]![0]).not.toHaveProperty('contractVersion');
    expect(compile.mock.calls[0]![0]).not.toHaveProperty('ethicalWallAllowed');
    expect(compile.mock.calls[1]![0]).toMatchObject({
      contractVersion: 2,
      ethicalWallAllowed: false,
      persistence: 'best-effort',
    });
  });

  it('shadow failure returns v1 and reports only a bounded error code', async () => {
    const onShadowError = jest.fn();
    const compile = jest
      .fn<(req: ContextRequest) => Promise<CompiledContextPacket>>()
      .mockResolvedValueOnce(packet(1))
      .mockRejectedValueOnce(new Error('CLASSIFIED BODY'));
    await expect(
      compileContextPacketForRollout({
        request,
        mode: 'shadow',
        ethicalWallAllowed: true,
        compile,
        onShadowError,
      }),
    ).resolves.toMatchObject({ version: 1 });
    expect(onShadowError).toHaveBeenCalledWith('error');
    expect(JSON.stringify(onShadowError.mock.calls)).not.toContain('CLASSIFIED BODY');
  });

  it('enforce returns v2 and off returns v1 with one compile each', async () => {
    for (const [mode, version] of [
      ['off', 1],
      ['enforce', 2],
    ] as const) {
      const compile = jest.fn(async (req: ContextRequest) => packet(req.contractVersion === 2 ? 2 : 1));
      const result = await compileContextPacketForRollout({
        request,
        mode,
        ethicalWallAllowed: true,
        compile,
      });
      expect(result.version).toBe(version);
      expect(compile).toHaveBeenCalledTimes(1);
    }
  });
});
