/**
 * Phase 7 Workstream K — the Prisma adapter, against a fake delegate.
 *
 * The independent review of Workstream E found that its Prisma adapter had no
 * unit spec and five refusal branches went untested (P1-9/P1-10). This exists
 * so K does not repeat that.
 */
import {
  createManualOverrideRepositoryPrismaV1,
  manualOverrideFromRowV1,
} from './manual-override-repository-prisma-v1.js';
import type { ManualOverrideTargetV1 } from './manual-override-service-v1.js';

/** Stands in for the `NUMERIC(24,9)` value the client returns as a Decimal. */
const decimal = (value: string) => ({ toString: () => value });

function row(o: Record<string, unknown> = {}) {
  return {
    overrideId: 'ovr-1',
    canonicalEntity: 'canonical_rdte_program_element_year',
    canonicalNaturalKey: '0601101A|2027',
    fiscalYear: 2027,
    fundingField: 'request',
    moneyOriginalValue: '1250',
    moneyOriginalUnit: 'thousands',
    moneyValueMillions: decimal('1.250000000'),
    authorActorId: 'analyst-1',
    approverActorId: null,
    approverRole: null,
    reason: 'transposed in the published PDF',
    evidenceIds: ['issue-42'],
    changeRequestRef: null,
    status: 'proposed',
    version: 1,
    priorOverrideId: null,
    effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
    effectiveTo: null,
    proposedAt: new Date('2026-07-31T00:00:00.000Z'),
    approvedAt: null,
    revokedAt: null,
    ...o,
  };
}

function delegate(o: Partial<Record<string, jest.Mock>> = {}) {
  return {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    ...o,
  } as never;
}

const TARGET: ManualOverrideTargetV1 = {
  canonicalEntity: 'canonical_rdte_program_element_year',
  naturalKey: '0601101A|2027',
  fiscalYear: 2027,
  fundingField: 'request',
};

describe('Phase 7 WS K — rows back into records', () => {
  it('parses a proposed row', () => {
    const record = manualOverrideFromRowV1(row());
    expect(record.status).toBe('proposed');
    expect(record.governance.approverActorId).toBeUndefined();
    expect(record.effectiveFrom).toBe('2026-08-01T00:00:00.000Z');
    expect(record.proposedAt).toBe('2026-07-31T00:00:00.000Z');
  });

  it('carries NUMERIC money across as a string, never a number', () => {
    const record = manualOverrideFromRowV1(row());
    expect(typeof record.value.valueMillions).toBe('string');
  });

  /*
   * Postgres pads a NUMERIC to its declared scale, so NUMERIC(24,9) returns
   * "1.250000000" for a stored 1.25. Canonical form strips trailing fractional
   * zeros, so the padded string is not canonical and the record schema refuses
   * it — every override would have failed to read back without normalization.
   */
  it('normalizes the scale padding Postgres adds to a NUMERIC', () => {
    expect(manualOverrideFromRowV1(row()).value.valueMillions).toBe('1.25');
    expect(
      manualOverrideFromRowV1(row({ moneyValueMillions: decimal('12.345678000') })).value
        .valueMillions,
    ).toBe('12.345678');
    expect(
      manualOverrideFromRowV1(row({ moneyValueMillions: decimal('900.000000000') })).value
        .valueMillions,
    ).toBe('900');
  });

  it('drops no significant digit while normalizing', () => {
    expect(
      manualOverrideFromRowV1(row({ moneyValueMillions: decimal('0.000000001') })).value
        .valueMillions,
    ).toBe('0.000000001');
  });

  it('parses an approved row with its approver', () => {
    const record = manualOverrideFromRowV1(
      row({
        status: 'approved',
        approverActorId: 'admin-1',
        approverRole: 'capiro_admin',
        approvedAt: new Date('2026-08-01T00:00:00.000Z'),
      }),
    );
    expect(record.governance.approverActorId).toBe('admin-1');
    expect(record.approvedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('refuses a row that bypassed the service and is internally inconsistent', () => {
    // Approved, but naming no approver — a shape the CHECK constraint forbids.
    expect(() => manualOverrideFromRowV1(row({ status: 'approved' }))).toThrow();
    // Proposed, but carrying an approver anyway.
    expect(() =>
      manualOverrideFromRowV1(row({ approverActorId: 'admin-1', approverRole: 'capiro_admin' })),
    ).toThrow();
  });
});

describe('Phase 7 WS K — the repository port', () => {
  it('looks up the latest version for a target by descending version', async () => {
    const d = delegate({
      findFirst: jest
        .fn()
        .mockResolvedValue({ overrideId: 'ovr-9', version: 3, status: 'approved' }),
    });
    const repo = createManualOverrideRepositoryPrismaV1(d);

    expect(await repo.findLatestForTarget(TARGET)).toEqual({
      overrideId: 'ovr-9',
      version: 3,
      status: 'approved',
    });
    const call = (d as unknown as { findFirst: jest.Mock }).findFirst.mock.calls[0][0];
    expect(call.orderBy).toEqual({ version: 'desc' });
    expect(call.where).toEqual({
      canonicalEntity: TARGET.canonicalEntity,
      canonicalNaturalKey: TARGET.naturalKey,
      fiscalYear: 2027,
      fundingField: 'request',
    });
  });

  it('returns null rather than undefined when a target has no override', async () => {
    const repo = createManualOverrideRepositoryPrismaV1(delegate());
    expect(await repo.findLatestForTarget(TARGET)).toBeNull();
    expect(await repo.findById('nope')).toBeNull();
  });

  it('writes the exact decimal string it was given', async () => {
    const d = delegate();
    const repo = createManualOverrideRepositoryPrismaV1(d);
    const record = manualOverrideFromRowV1(row({ moneyValueMillions: decimal('12.345678') }));

    await repo.insert(record, 'a'.repeat(64));

    const data = (d as unknown as { create: jest.Mock }).create.mock.calls[0][0].data;
    expect(data.moneyValueMillions).toBe('12.345678');
    expect(data.overrideHash).toBe('a'.repeat(64));
    expect(data.canonicalNaturalKey).toBe('0601101A|2027');
  });

  it('guards approval on the row still being proposed', async () => {
    const d = delegate();
    const repo = createManualOverrideRepositoryPrismaV1(d);

    await repo.markApproved({
      overrideId: 'ovr-1',
      approverActorId: 'admin-1',
      approvedAt: '2026-08-01T00:00:00.000Z',
    });

    const call = (d as unknown as { updateMany: jest.Mock }).updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ overrideId: 'ovr-1', status: 'proposed' });
    expect(call.data.status).toBe('approved');
    expect(call.data.approverRole).toBe('capiro_admin');
  });

  it('fails the loser of a concurrent approval as a no-op, not an overwrite', async () => {
    const d = delegate({ updateMany: jest.fn().mockResolvedValue({ count: 0 }) });
    const repo = createManualOverrideRepositoryPrismaV1(d);

    await expect(
      repo.markApproved({
        overrideId: 'ovr-1',
        approverActorId: 'admin-2',
        approvedAt: '2026-08-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/was not awaiting approval/);
  });
});
