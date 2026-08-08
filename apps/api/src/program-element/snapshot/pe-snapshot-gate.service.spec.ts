import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import { PeSnapshotGateService } from './pe-snapshot-gate.service.js';
import type {
  ActiveSnapshotV1,
  SnapshotReadPortV1,
} from '../../defense-budget/promotion/snapshot-read-repository-v1.js';

function activeSnapshot(overrides: Partial<ActiveSnapshotV1> = {}): ActiveSnapshotV1 {
  return {
    snapshotId: 'snap-1',
    domain: 'defense_budget',
    environment: 'test',
    status: 'active',
    activatedAt: '2026-08-01T00:00:00.000Z',
    snapshotHash: 'hash-1',
    ...overrides,
  };
}

function portReturning(snapshot: ActiveSnapshotV1 | null): SnapshotReadPortV1 {
  return {
    loadActiveSnapshot: jest.fn(async () => snapshot),
    loadRows: jest.fn(async () => []),
  };
}

function config(values: Partial<Record<string, unknown>>): ConfigService<AppConfig, true> {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService<AppConfig, true>;
}

describe('PeSnapshotGateService', () => {
  it('forces legacy with no active snapshot, regardless of configured mode', async () => {
    const gate = new PeSnapshotGateService(
      portReturning(null),
      config({ PE_SNAPSHOT_READ_MODE: 'snapshot', NODE_ENV: 'test' }),
    );
    const { decision, activeSnapshot: pointer } = await gate.resolve('tenant-1');
    expect(decision).toEqual({ serve: 'legacy', compare: false, reason: 'no_active_snapshot' });
    expect(pointer).toBeNull();
  });

  it('serves snapshot in snapshot mode when a pointer is active', async () => {
    const gate = new PeSnapshotGateService(
      portReturning(activeSnapshot()),
      config({ PE_SNAPSHOT_READ_MODE: 'snapshot', NODE_ENV: 'test' }),
    );
    const { decision, activeSnapshot: pointer } = await gate.resolve('tenant-1');
    expect(decision).toEqual({ serve: 'snapshot', compare: false, reason: 'mode_snapshot' });
    expect(pointer?.snapshotId).toBe('snap-1');
  });

  it('serves legacy and compares in shadow mode', async () => {
    const gate = new PeSnapshotGateService(
      portReturning(activeSnapshot()),
      config({ PE_SNAPSHOT_READ_MODE: 'shadow', NODE_ENV: 'test' }),
    );
    const { decision } = await gate.resolve(null);
    expect(decision).toEqual({ serve: 'legacy', compare: true, reason: 'mode_shadow' });
  });

  it('routes a canary tenant to snapshot and a non-canary tenant to legacy, both compared', async () => {
    const port = portReturning(activeSnapshot());
    const gate = new PeSnapshotGateService(
      port,
      config({
        PE_SNAPSHOT_READ_MODE: 'snapshot_canary',
        PE_SNAPSHOT_CANARY_TENANTS: 'tenant-a, tenant-b',
        NODE_ENV: 'test',
      }),
    );
    expect((await gate.resolve('tenant-a')).decision).toEqual({
      serve: 'snapshot',
      compare: true,
      reason: 'canary_tenant',
    });
    expect((await gate.resolve('tenant-z')).decision).toEqual({
      serve: 'legacy',
      compare: true,
      reason: 'canary_non_tenant',
    });
  });

  it('resolves a fresh pointer on every call rather than caching across calls', async () => {
    const port = portReturning(activeSnapshot());
    const gate = new PeSnapshotGateService(
      port,
      config({ PE_SNAPSHOT_READ_MODE: 'snapshot', NODE_ENV: 'test' }),
    );
    await gate.resolve('tenant-1');
    await gate.resolve('tenant-1');
    expect(port.loadActiveSnapshot).toHaveBeenCalledTimes(2);
  });

  it('passes loadRows through to the underlying port', async () => {
    const port = portReturning(activeSnapshot());
    const gate = new PeSnapshotGateService(port, config({ NODE_ENV: 'test' }));
    await gate.loadRows({
      snapshotId: 'snap-1',
      canonicalEntity: 'canonical_rdte_program_element',
    });
    expect(port.loadRows).toHaveBeenCalledWith({
      snapshotId: 'snap-1',
      canonicalEntity: 'canonical_rdte_program_element',
    });
  });
});
