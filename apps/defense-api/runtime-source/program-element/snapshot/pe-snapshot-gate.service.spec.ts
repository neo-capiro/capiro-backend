import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import { PeSnapshotGateService } from './pe-snapshot-gate.service.js';
import type {
  ActiveSnapshotV1,
  SnapshotCanonicalRowV1,
  SnapshotReadPortV1,
} from '../../defense-budget/promotion/snapshot-read-repository-v1.js';
import type { DefenseBudgetManualOverrideV1 } from '../../defense-budget/promotion/manual-override-v1.js';
import type { TenantContextStore } from '../../tenant/tenant-context.store.js';

const SNAPSHOT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

function activeSnapshot(overrides: Partial<ActiveSnapshotV1> = {}): ActiveSnapshotV1 {
  return {
    snapshotId: SNAPSHOT_ID,
    domain: 'defense_budget',
    environment: 'test',
    status: 'active',
    activatedAt: '2026-08-01T00:00:00.000Z',
    snapshotHash: 'hash-1',
    ...overrides,
  };
}

function snapshotRow(overrides: Partial<SnapshotCanonicalRowV1> = {}): SnapshotCanonicalRowV1 {
  return {
    snapshotId: SNAPSHOT_ID,
    canonicalEntity: 'canonical_om_sag_year',
    canonicalNaturalKey: 'ARMY|OMA|SAG-1|2027|request',
    parentNaturalKey: 'ARMY|OMA|SAG-1',
    family: 'om',
    fiscalYear: 2027,
    fundingField: 'request',
    stage: null,
    canonicalRowHash: 'a'.repeat(64),
    money: { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' },
    quantity: null,
    unitCostDollars: null,
    textValue: null,
    dateValue: null,
    attributes: {},
    directOrDerived: 'direct',
    lineage: {
      sourceProjectionId: 'projection-1',
      verificationCandidateId: 'candidate-1',
      verificationRunId: 'run-1',
      artifactId: 'artifact-1',
      sourceDocumentId: 'document-1',
      enactmentProofId: null,
    },
    ...overrides,
  };
}

function manualOverride(
  overrides: Partial<DefenseBudgetManualOverrideV1> = {},
): DefenseBudgetManualOverrideV1 {
  return {
    schemaVersion: 'defense_budget_manual_override_v1',
    overrideId: 'override-1',
    canonicalEntity: 'canonical_om_sag_year',
    naturalKey: 'ARMY|OMA|SAG-1|2027|request',
    fiscalYear: 2027,
    fundingField: 'request',
    value: { originalValue: '9000', originalUnit: 'thousands', valueMillions: '9' },
    governance: {
      authorActorId: 'author-1',
      approverActorId: 'approver-1',
      approverRole: 'capiro_admin',
      reason: 'reviewed correction',
      evidenceIds: ['evidence-1'],
    },
    status: 'approved',
    version: 1,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    proposedAt: '2026-07-31T00:00:00.000Z',
    approvedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as DefenseBudgetManualOverrideV1;
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

function tenantStore(tenantId: string): TenantContextStore {
  return {
    get: () => ({
      tenantId,
      tenantSlug: 'test-tenant',
      userId: 'user-1',
      clerkUserId: 'clerk-1',
      role: 'standard_user',
    }),
  } as unknown as TenantContextStore;
}

describe('PeSnapshotGateService', () => {
  const originalSnapshotEnvironment = process.env.PE_SNAPSHOT_ENVIRONMENT;

  afterEach(() => {
    if (originalSnapshotEnvironment == null) delete process.env.PE_SNAPSHOT_ENVIRONMENT;
    else process.env.PE_SNAPSHOT_ENVIRONMENT = originalSnapshotEnvironment;
  });

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
    expect(pointer?.snapshotId).toBe(SNAPSHOT_ID);
  });

  it('serves legacy and compares in shadow mode', async () => {
    const gate = new PeSnapshotGateService(
      portReturning(activeSnapshot()),
      config({ PE_SNAPSHOT_READ_MODE: 'shadow', NODE_ENV: 'test' }),
    );
    expect((await gate.resolve(null)).decision).toEqual({
      serve: 'legacy',
      compare: true,
      reason: 'mode_shadow',
    });
  });

  it('routes canary tenants with the verified request tenant', async () => {
    const gate = new PeSnapshotGateService(
      portReturning(activeSnapshot()),
      config({
        PE_SNAPSHOT_READ_MODE: 'snapshot_canary',
        PE_SNAPSHOT_CANARY_TENANTS: 'tenant-a,tenant-b',
        NODE_ENV: 'test',
      }),
      undefined,
      tenantStore('tenant-a'),
    );
    expect((await gate.resolve(null)).decision).toEqual({
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

  it('uses the explicit snapshot environment key for pointer reads and SLO dimensions', async () => {
    process.env.PE_SNAPSHOT_ENVIRONMENT = 'capiro-dev';
    const port = portReturning(activeSnapshot({ environment: 'capiro-dev' }));
    const gate = new PeSnapshotGateService(
      port,
      config({ PE_SNAPSHOT_READ_MODE: 'snapshot', NODE_ENV: 'production' }),
    );

    await gate.resolve('tenant-1');
    expect(port.loadActiveSnapshot).toHaveBeenCalledWith('defense_budget', 'capiro-dev');
    expect(gate.sloDescriptor().environment).toBe('capiro-dev');
  });

  it('resolves a fresh pointer on every call rather than caching across requests', async () => {
    const port = portReturning(activeSnapshot());
    const gate = new PeSnapshotGateService(
      port,
      config({ PE_SNAPSHOT_READ_MODE: 'snapshot', NODE_ENV: 'test' }),
    );
    await gate.resolve('tenant-1');
    await gate.resolve('tenant-1');
    expect(port.loadActiveSnapshot).toHaveBeenCalledTimes(2);
  });

  it('rollback switch forces legacy even for an active canary tenant', async () => {
    const gate = new PeSnapshotGateService(
      portReturning(activeSnapshot()),
      config({
        PE_SNAPSHOT_READ_MODE: 'snapshot_canary',
        PE_SNAPSHOT_CANARY_TENANTS: 'tenant-a',
        PE_SNAPSHOT_CANARY_ROLLBACK: 'on',
        NODE_ENV: 'test',
      }),
    );
    expect((await gate.resolve('tenant-a')).decision).toEqual({
      serve: 'legacy',
      compare: false,
      reason: 'canary_rollback_engaged',
    });
  });

  it('applies an approved governed override and preserves the official value', async () => {
    const port: SnapshotReadPortV1 = {
      loadActiveSnapshot: jest.fn(async () => activeSnapshot()),
      loadRows: jest.fn(async () => [snapshotRow()]),
      loadManualOverridesForRows: jest.fn(async () => [manualOverride()]),
    };
    const gate = new PeSnapshotGateService(port, config({ NODE_ENV: 'test' }));

    const rows = await gate.loadRows({
      snapshotId: SNAPSHOT_ID,
      canonicalEntity: 'canonical_om_sag_year',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.money?.valueMillions).toBe('9');
    expect(rows[0]?.officialMoney?.valueMillions).toBe('1.25');
    expect(rows[0]?.override).toMatchObject({
      overrideId: 'override-1',
      approverActorId: 'approver-1',
      label: 'manual_override',
    });
    expect(port.loadManualOverridesForRows).toHaveBeenCalledWith([snapshotRow()]);
  });

  it('does not let a proposed replacement suppress an approved correction', async () => {
    const approved = manualOverride({ overrideId: 'override-1', version: 1 });
    const proposed = manualOverride({
      overrideId: 'override-2',
      version: 2,
      status: 'proposed',
      approvedAt: undefined,
      governance: {
        authorActorId: 'author-2',
        reason: 'candidate replacement',
        evidenceIds: ['evidence-2'],
      },
    } as never);
    const port: SnapshotReadPortV1 = {
      loadActiveSnapshot: jest.fn(async () => activeSnapshot()),
      loadRows: jest.fn(async () => [snapshotRow()]),
      loadManualOverridesForRows: jest.fn(async () => [proposed, approved]),
    };
    const gate = new PeSnapshotGateService(port, config({ NODE_ENV: 'test' }));

    const rows = await gate.loadRows({ snapshotId: SNAPSHOT_ID });
    expect(rows[0]?.money?.valueMillions).toBe('9');
    expect(rows[0]?.override?.overrideId).toBe('override-1');
  });

  it('refuses a foreign snapshot row before applying any override', async () => {
    const port: SnapshotReadPortV1 = {
      loadActiveSnapshot: jest.fn(async () => activeSnapshot()),
      loadRows: jest.fn(async () => [snapshotRow({ snapshotId: 'bbbbbbbb-0000-0000-0000-000000000002' })]),
      loadManualOverridesForRows: jest.fn(async () => [manualOverride()]),
    };
    const gate = new PeSnapshotGateService(port, config({ NODE_ENV: 'test' }));

    await expect(gate.loadRows({ snapshotId: SNAPSHOT_ID })).rejects.toThrow(/snapshot mix/i);
    expect(port.loadManualOverridesForRows).not.toHaveBeenCalled();
  });

  it('keeps an explicit no-override shape for narrow ports without override support', async () => {
    const port: SnapshotReadPortV1 = {
      loadActiveSnapshot: jest.fn(async () => activeSnapshot()),
      loadRows: jest.fn(async () => [snapshotRow()]),
    };
    const gate = new PeSnapshotGateService(port, config({ NODE_ENV: 'test' }));
    const rows = await gate.loadRows({ snapshotId: SNAPSHOT_ID });
    expect(rows[0]?.override).toBeNull();
    expect(rows[0]?.officialMoney).toBeNull();
  });
});
