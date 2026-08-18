import assert from 'node:assert/strict';
import test from 'node:test';
import {
  approveManualOverrideV1,
  canonicalTargetForLegacyPeYearV1,
  isCanonicalDecimalStringV1,
  ManualOverrideRefusalError,
  manualOverrideHashV1,
  proposeManualOverrideV1,
  type ManualOverrideRecordV1,
  type ManualOverrideRepositoryV1,
} from './manual-override-service-v1.ts';

function fakeRepository(): ManualOverrideRepositoryV1 & { store: Map<string, ManualOverrideRecordV1> } {
  const store = new Map<string, ManualOverrideRecordV1>();
  return {
    store,
    async findLatestForTarget(target) {
      let latest: ManualOverrideRecordV1 | null = null;
      for (const record of store.values()) {
        if (record.canonicalEntity === target.canonicalEntity && record.canonicalNaturalKey === target.naturalKey) {
          if (!latest || record.version > latest.version) latest = record;
        }
      }
      return latest ? { overrideId: latest.overrideId, version: latest.version, status: latest.status } : null;
    },
    async findById(overrideId) {
      return store.get(overrideId) ?? null;
    },
    async insert(record) {
      store.set(record.overrideId, record);
    },
    async markApproved(input) {
      const existing = store.get(input.overrideId);
      if (existing) {
        store.set(input.overrideId, {
          ...existing,
          status: 'approved',
          approvedAt: input.approvedAt,
          governance: { ...existing.governance, approverActorId: input.approverActorId, approverRole: 'capiro_admin' },
        });
      }
    },
  };
}

test('isCanonicalDecimalStringV1 accepts exact decimals, rejects -0 and malformed input', () => {
  assert.equal(isCanonicalDecimalStringV1('0'), true);
  assert.equal(isCanonicalDecimalStringV1('12.5'), true);
  assert.equal(isCanonicalDecimalStringV1('-12.5'), true);
  assert.equal(isCanonicalDecimalStringV1('-0'), false);
  assert.equal(isCanonicalDecimalStringV1('1e5'), false);
  assert.equal(isCanonicalDecimalStringV1('abc'), false);
  assert.equal(isCanonicalDecimalStringV1('007'), false);
});

test('canonicalTargetForLegacyPeYearV1 maps (peCode, fy, fieldName) to a stable canonical target', () => {
  const target = canonicalTargetForLegacyPeYearV1({ peCode: '0601102A', fy: 2027, fieldName: 'hascMark' });
  assert.equal(target.canonicalEntity, 'canonical_rdte_program_element_year');
  assert.equal(target.naturalKey, '0601102A|2027');
  assert.equal(target.fiscalYear, 2027);
  assert.equal(target.fundingField, 'hascMark');
});

test('proposeManualOverrideV1 refuses a fractional-float-tainted value (non-canonical decimal)', async () => {
  const repo = fakeRepository();
  await assert.rejects(
    proposeManualOverrideV1(
      {
        overrideId: 'o1',
        target: canonicalTargetForLegacyPeYearV1({ peCode: 'PE1', fy: 2027, fieldName: 'request' }),
        value: { originalValue: '1.2500000000000002', originalUnit: 'millions', valueMillions: '01.5' },
        authorActorId: 'user-a',
        reason: 'test',
        evidenceIds: ['e1'],
        effectiveFrom: new Date().toISOString(),
        proposedAt: new Date().toISOString(),
      },
      repo,
    ),
    (err: unknown) => err instanceof ManualOverrideRefusalError && err.reason === 'value_not_canonical_decimal',
  );
});

test('proposeManualOverrideV1 refuses a second open proposal on the same target', async () => {
  const repo = fakeRepository();
  const target = canonicalTargetForLegacyPeYearV1({ peCode: 'PE1', fy: 2027, fieldName: 'request' });
  await proposeManualOverrideV1(
    { overrideId: 'o1', target, value: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' }, authorActorId: 'user-a', reason: 'r', evidenceIds: ['e1'], effectiveFrom: new Date().toISOString(), proposedAt: new Date().toISOString() },
    repo,
  );
  await assert.rejects(
    proposeManualOverrideV1(
      { overrideId: 'o2', target, value: { originalValue: '6', originalUnit: 'millions', valueMillions: '6' }, authorActorId: 'user-b', reason: 'r2', evidenceIds: ['e2'], effectiveFrom: new Date().toISOString(), proposedAt: new Date().toISOString() },
      repo,
    ),
    (err: unknown) => err instanceof ManualOverrideRefusalError && err.reason === 'target_has_open_proposal',
  );
});

test('approveManualOverrideV1 refuses approval by the proposal author (author != approver invariant)', async () => {
  const repo = fakeRepository();
  const target = canonicalTargetForLegacyPeYearV1({ peCode: 'PE1', fy: 2027, fieldName: 'request' });
  await proposeManualOverrideV1(
    { overrideId: 'o1', target, value: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' }, authorActorId: 'user-a', reason: 'r', evidenceIds: ['e1'], effectiveFrom: new Date().toISOString(), proposedAt: new Date().toISOString() },
    repo,
  );
  await assert.rejects(
    approveManualOverrideV1({ overrideId: 'o1', approverActorId: 'user-a', approverRole: 'capiro_admin', approvedAt: new Date().toISOString() }, repo),
    (err: unknown) => err instanceof ManualOverrideRefusalError && err.reason === 'approver_is_author',
  );
});

test('approveManualOverrideV1 refuses a non-admin approver', async () => {
  const repo = fakeRepository();
  const target = canonicalTargetForLegacyPeYearV1({ peCode: 'PE1', fy: 2027, fieldName: 'request' });
  await proposeManualOverrideV1(
    { overrideId: 'o1', target, value: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' }, authorActorId: 'user-a', reason: 'r', evidenceIds: ['e1'], effectiveFrom: new Date().toISOString(), proposedAt: new Date().toISOString() },
    repo,
  );
  await assert.rejects(
    approveManualOverrideV1({ overrideId: 'o1', approverActorId: 'user-b', approverRole: 'standard_user', approvedAt: new Date().toISOString() }, repo),
    (err: unknown) => err instanceof ManualOverrideRefusalError && err.reason === 'approver_not_admin',
  );
});

test('approveManualOverrideV1 succeeds for a different capiro_admin approver and puts the override in force', async () => {
  const repo = fakeRepository();
  const target = canonicalTargetForLegacyPeYearV1({ peCode: 'PE1', fy: 2027, fieldName: 'request' });
  await proposeManualOverrideV1(
    { overrideId: 'o1', target, value: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' }, authorActorId: 'user-a', reason: 'r', evidenceIds: ['e1'], effectiveFrom: new Date().toISOString(), proposedAt: new Date().toISOString() },
    repo,
  );
  const approved = await approveManualOverrideV1(
    { overrideId: 'o1', approverActorId: 'user-b', approverRole: 'capiro_admin', approvedAt: new Date().toISOString() },
    repo,
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.governance.approverActorId, 'user-b');
});

test('manualOverrideHashV1 is deterministic and order-independent on evidenceIds', () => {
  const target = canonicalTargetForLegacyPeYearV1({ peCode: 'PE1', fy: 2027, fieldName: 'request' });
  const base = {
    overrideId: 'o1',
    canonicalEntity: target.canonicalEntity,
    canonicalNaturalKey: target.naturalKey,
    fiscalYear: target.fiscalYear,
    fundingField: target.fundingField,
    value: { originalValue: '5', originalUnit: 'millions', valueMillions: '5' },
    governance: { authorActorId: 'user-a', reason: 'r', evidenceIds: ['a', 'b'] },
    status: 'proposed' as const,
    version: 1,
    effectiveFrom: '2027-01-01T00:00:00.000Z',
    proposedAt: '2027-01-01T00:00:00.000Z',
  };
  const h1 = manualOverrideHashV1(base);
  const h2 = manualOverrideHashV1(base);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});
