import {
  canonicalJson,
  governanceStateFromRow,
  governanceStatesEqual,
  hashBackfillPlan,
  hashGovernanceState,
  parseMemoryGovernanceBackfillArgs,
  type GovernanceState,
} from './memory-governance-backfill';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

const state: GovernanceState = {
  memoryClass: 'legacy_unclassified',
  memoryAuthority: 'legacy_unclassified',
  memoryScope: 'firm',
  governedStatus: 'pending_review',
  sourceType: 'unknown',
  sourceId: null,
  reviewDueAt: null,
};

describe('Phase 11 governance backfill state contract', () => {
  it('defaults to a prepare-only dry run with no execution authority', () => {
    expect(parseMemoryGovernanceBackfillArgs(['--tenant-id', TENANT_ID])).toEqual({
      tenantId: TENANT_ID,
      action: 'prepare',
      jobId: null,
      confirmTenant: null,
      confirmJob: null,
    });
  });

  it('requires exact tenant and job confirmation for execute and rollback', () => {
    expect(
      parseMemoryGovernanceBackfillArgs([
        '--tenant-id',
        TENANT_ID,
        '--execute',
        '--job-id',
        JOB_ID,
        '--confirm-tenant',
        TENANT_ID,
        '--confirm-job',
        JOB_ID,
      ]),
    ).toMatchObject({ action: 'execute', tenantId: TENANT_ID, jobId: JOB_ID });

    expect(() =>
      parseMemoryGovernanceBackfillArgs([
        '--tenant-id',
        TENANT_ID,
        '--rollback',
        '--job-id',
        JOB_ID,
        '--confirm-tenant',
        TENANT_ID,
        '--confirm-job',
        TENANT_ID,
      ]),
    ).toThrow('--confirm-job must exactly equal --job-id');

    expect(() =>
      parseMemoryGovernanceBackfillArgs([
        '--tenant-id',
        TENANT_ID,
        '--execute',
        '--job-id',
        JOB_ID,
        '--confirm-job',
        JOB_ID,
      ]),
    ).toThrow('execute requires --confirm-tenant');
  });

  it('rejects mixed actions and confirmation flags in prepare mode', () => {
    expect(() =>
      parseMemoryGovernanceBackfillArgs([
        '--tenant-id',
        TENANT_ID,
        '--execute',
        '--rollback',
      ]),
    ).toThrow('--execute and --rollback are mutually exclusive');

    expect(() =>
      parseMemoryGovernanceBackfillArgs([
        '--tenant-id',
        TENANT_ID,
        '--job-id',
        JOB_ID,
      ]),
    ).toThrow('prepare mode does not accept');
  });

  it('canonicalizes object keys and produces stable exact-state hashes', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
    expect(hashGovernanceState({ ...state })).toBe(
      hashGovernanceState({
        governedStatus: 'pending_review',
        memoryScope: 'firm',
        memoryClass: 'legacy_unclassified',
        memoryAuthority: 'legacy_unclassified',
        sourceId: null,
        reviewDueAt: null,
        sourceType: 'unknown',
      }),
    );
    expect(
      governanceStatesEqual(state, { ...state, sourceType: 'firm_playbook' }),
    ).toBe(false);
  });

  it('normalizes timestamps before hashing and detects every rollback field', () => {
    const normalized = governanceStateFromRow({
      ...state,
      reviewDueAt: new Date('2026-08-01T12:34:56.000Z'),
    });
    expect(normalized.reviewDueAt).toBe('2026-08-01T12:34:56.000Z');

    for (const changed of [
      { memoryClass: 'institutional_authoritative' },
      { memoryAuthority: 'firm_approved' },
      { memoryScope: 'client' },
      { governedStatus: 'active' },
      { sourceType: 'firm_playbook' },
      { sourceId: 'source-1' },
      { reviewDueAt: '2026-08-02T00:00:00.000Z' },
    ]) {
      expect(hashGovernanceState({ ...state, ...changed })).not.toBe(
        hashGovernanceState(state),
      );
    }
  });

  it('makes the plan hash independent of query order but sensitive to any row decision', () => {
    const first = {
      memoryItemId: TENANT_ID,
      shouldUpdate: true,
      quarantined: false,
      reason: 'deterministic',
      beforeHash: 'a'.repeat(64),
      expectedPostHash: 'b'.repeat(64),
    };
    const second = {
      memoryItemId: JOB_ID,
      shouldUpdate: false,
      quarantined: true,
      reason: 'ambiguous',
      beforeHash: 'c'.repeat(64),
      expectedPostHash: 'c'.repeat(64),
    };
    expect(hashBackfillPlan([first, second])).toBe(
      hashBackfillPlan([second, first]),
    );
    expect(hashBackfillPlan([first, second])).not.toBe(
      hashBackfillPlan([{ ...first, shouldUpdate: false }, second]),
    );
  });
});
