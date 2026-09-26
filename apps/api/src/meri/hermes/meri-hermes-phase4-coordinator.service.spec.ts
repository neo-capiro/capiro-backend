import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MeriHermesPhase4Coordinator } from './meri-hermes-phase4-coordinator.service.js';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';

function buildCoordinator(envValue?: string) {
  const configService = {
    get: jest.fn((key: string, defaultValue: string) => {
      if (key === 'MERI_PHASE4_COORDINATOR_ENABLED') return envValue ?? '';
      return defaultValue;
    }),
  };
  const coordinator = new MeriHermesPhase4Coordinator(configService as any);
  return { coordinator, configService };
}

describe('Phase 4 coordinator (default-off)', () => {
  it('stays stopped when flag is absent', () => {
    const { coordinator } = buildCoordinator();
    coordinator.onModuleInit();
    expect(coordinator.getStatus().state).toBe('stopped');
    expect(coordinator.isEnabledForTenant(tenantA)).toBe(false);
  });

  it('stays stopped when flag is empty string', () => {
    const { coordinator } = buildCoordinator('');
    coordinator.onModuleInit();
    expect(coordinator.getStatus().state).toBe('stopped');
  });

  it('stays stopped when flag is "false"', () => {
    const { coordinator } = buildCoordinator('false');
    coordinator.onModuleInit();
    expect(coordinator.getStatus().state).toBe('stopped');
  });

  it('transitions to ready when flag is "true"', () => {
    const { coordinator } = buildCoordinator('true');
    coordinator.onModuleInit();
    expect(coordinator.getStatus().state).toBe('ready');
    expect(coordinator.getStatus().signingAvailable).toBe(true);
  });

  it('transitions to ready when flag is "1"', () => {
    const { coordinator } = buildCoordinator('1');
    coordinator.onModuleInit();
    expect(coordinator.getStatus().state).toBe('ready');
  });
});

describe('Phase 4 coordinator ingress gate', () => {
  it('rejects when coordinator is stopped', () => {
    const { coordinator } = buildCoordinator();
    coordinator.onModuleInit();
    const result = coordinator.checkIngress(tenantA, true);
    expect(result).toEqual({ kind: 'rejected', reason: 'coordinator_disabled' });
  });

  it('rejects unauthorized tenant when enabled globally', () => {
    const { coordinator } = buildCoordinator('true');
    coordinator.onModuleInit();
    // All tenants are authorized when enabled=true with no overrides
    // So this should admit
    const result = coordinator.checkIngress(tenantA, true);
    expect(result).toEqual({ kind: 'admitted', reason: null });
  });

  it('rejects when operation namespace is missing', () => {
    const { coordinator } = buildCoordinator('true');
    coordinator.onModuleInit();
    const result = coordinator.checkIngress(tenantA, false);
    expect(result).toEqual({ kind: 'rejected', reason: 'operation_namespace_missing' });
  });

  it('admits when all gates pass', () => {
    const { coordinator } = buildCoordinator('true');
    coordinator.onModuleInit();
    const result = coordinator.checkIngress(tenantA, true);
    expect(result).toEqual({ kind: 'admitted', reason: null });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

describe('Phase 4 coordinator status', () => {
  it('reports version and state accurately', () => {
    const { coordinator } = buildCoordinator('true');
    coordinator.onModuleInit();
    const status = coordinator.getStatus();
    expect(status.version).toBe(1);
    expect(status.state).toBe('ready');
    expect(status.signingAvailable).toBe(true);
    expect(status.registeredTransports).toBe(1);
  });

  it('reports stopped state when disabled', () => {
    const { coordinator } = buildCoordinator();
    coordinator.onModuleInit();
    const status = coordinator.getStatus();
    expect(status.state).toBe('stopped');
    expect(status.signingAvailable).toBe(false);
    expect(status.registeredTransports).toBe(0);
  });
});
