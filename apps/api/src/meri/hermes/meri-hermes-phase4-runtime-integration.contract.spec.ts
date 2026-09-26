import {
  MERI_PHASE4_RUNTIME_VERSION,
  MERI_PHASE4_COORDINATOR_FLAG,
  isMeriPhase4CoordinatorEnabled,
  meriPhase4IngressAdmitted,
  meriPhase4IngressRejected,
  isMeriPhase4CoordinatorStatusV1,
  type MeriPhase4CoordinatorConfigV1,
  type MeriPhase4CoordinatorStatusV1,
} from './meri-hermes-phase4-runtime-integration.contract.js';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';

describe('Phase 4 coordinator feature flag', () => {
  it('exports the flag constant', () => {
    expect(MERI_PHASE4_COORDINATOR_FLAG).toBe('MERI_PHASE4_COORDINATOR_ENABLED');
  });

  it('returns false when master switch is off and no overrides', () => {
    const config: MeriPhase4CoordinatorConfigV1 = {
      version: MERI_PHASE4_RUNTIME_VERSION,
      enabled: false,
      tenantOverrides: new Map(),
    };
    expect(isMeriPhase4CoordinatorEnabled(config, tenantA)).toBe(false);
  });

  it('returns true when master switch is on', () => {
    const config: MeriPhase4CoordinatorConfigV1 = {
      version: MERI_PHASE4_RUNTIME_VERSION,
      enabled: true,
      tenantOverrides: new Map(),
    };
    expect(isMeriPhase4CoordinatorEnabled(config, tenantA)).toBe(true);
  });

  it('per-tenant override wins over master switch', () => {
    const config: MeriPhase4CoordinatorConfigV1 = {
      version: MERI_PHASE4_RUNTIME_VERSION,
      enabled: false,
      tenantOverrides: new Map([[tenantA, true]]),
    };
    expect(isMeriPhase4CoordinatorEnabled(config, tenantA)).toBe(true);
    expect(isMeriPhase4CoordinatorEnabled(config, tenantB)).toBe(false);
  });

  it('per-tenant disable overrides master enable', () => {
    const config: MeriPhase4CoordinatorConfigV1 = {
      version: MERI_PHASE4_RUNTIME_VERSION,
      enabled: true,
      tenantOverrides: new Map([[tenantA, false]]),
    };
    expect(isMeriPhase4CoordinatorEnabled(config, tenantA)).toBe(false);
    expect(isMeriPhase4CoordinatorEnabled(config, tenantB)).toBe(true);
  });

  it('returns false for invalid config', () => {
    expect(isMeriPhase4CoordinatorEnabled(null as any, tenantA)).toBe(false);
    expect(isMeriPhase4CoordinatorEnabled({ version: 99 } as any, tenantA)).toBe(false);
  });
});

describe('Phase 4 ingress gate', () => {
  it('admitted result is frozen with null reason', () => {
    const result = meriPhase4IngressAdmitted();
    expect(result).toEqual({ kind: 'admitted', reason: null });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejected result is frozen with typed reason', () => {
    const result = meriPhase4IngressRejected('coordinator_disabled');
    expect(result).toEqual({ kind: 'rejected', reason: 'coordinator_disabled' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('all rejection reasons produce valid results', () => {
    const reasons = [
      'coordinator_disabled', 'dispatch_identity_mismatch',
      'route_resolver_incompatible', 'operation_namespace_missing',
      'signing_key_unavailable', 'signing_key_revoked',
      'tenant_not_authorized', 'worker_credential_expired',
      'stop_requested',
    ] as const;
    for (const reason of reasons) {
      const result = meriPhase4IngressRejected(reason);
      expect(result.kind).toBe('rejected');
      expect(result.reason).toBe(reason);
    }
  });
});

describe('Phase 4 coordinator status', () => {
  const validStatus: MeriPhase4CoordinatorStatusV1 = {
    version: MERI_PHASE4_RUNTIME_VERSION,
    state: 'ready',
    signingAvailable: true,
    activeKeyId: 'meri-phase4-signer-key-001',
    registeredTransports: 1,
    enabledTenants: 3,
  };

  it('validates a well-formed status', () => {
    expect(isMeriPhase4CoordinatorStatusV1(validStatus)).toBe(true);
  });

  it('accepts all coordinator states', () => {
    for (const state of ['initializing', 'ready', 'degraded',
      'shutting_down', 'stopped'] as const) {
      expect(isMeriPhase4CoordinatorStatusV1({
        ...validStatus, state,
      })).toBe(true);
    }
  });

  it('accepts null activeKeyId', () => {
    expect(isMeriPhase4CoordinatorStatusV1({
      ...validStatus, activeKeyId: null, signingAvailable: false,
    })).toBe(true);
  });

  it('rejects invalid state', () => {
    expect(isMeriPhase4CoordinatorStatusV1({
      ...validStatus, state: 'crashed',
    })).toBe(false);
  });

  it('rejects null and primitives', () => {
    expect(isMeriPhase4CoordinatorStatusV1(null)).toBe(false);
    expect(isMeriPhase4CoordinatorStatusV1(42)).toBe(false);
  });
});
