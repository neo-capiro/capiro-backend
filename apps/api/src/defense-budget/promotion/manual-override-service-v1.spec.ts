/**
 * Phase 7 Workstream K — proposing and approving, against an in-memory port.
 */
import {
  ManualOverrideRefusalError,
  approveManualOverrideV1,
  canonicalTargetForLegacyPeYearV1,
  fundingFieldForLegacyFieldNameV1,
  proposeManualOverrideV1,
  type ManualOverrideRepositoryV1,
  type ManualOverrideTargetV1,
  type ProposeManualOverrideInputV1,
} from './manual-override-service-v1.js';
import {
  manualOverrideTargetKeyV1,
  type DefenseBudgetManualOverrideV1,
} from './manual-override-v1.js';

function repository(): ManualOverrideRepositoryV1 & { rows: DefenseBudgetManualOverrideV1[] } {
  const rows: DefenseBudgetManualOverrideV1[] = [];
  return {
    rows,
    async findLatestForTarget(target: ManualOverrideTargetV1) {
      const key = manualOverrideTargetKeyV1(target);
      const matches = rows
        .filter((r) => manualOverrideTargetKeyV1(r) === key)
        .sort((a, b) => b.version - a.version);
      const latest = matches[0];
      return latest == null
        ? null
        : { overrideId: latest.overrideId, version: latest.version, status: latest.status };
    },
    async findById(overrideId: string) {
      return rows.find((r) => r.overrideId === overrideId) ?? null;
    },
    async insert(record) {
      rows.push(record);
    },
    async markApproved({ overrideId, approverActorId, approvedAt }) {
      const index = rows.findIndex((r) => r.overrideId === overrideId);
      const existing = rows[index];
      if (existing == null) throw new Error('missing row');
      rows[index] = {
        ...existing,
        status: 'approved',
        approvedAt,
        governance: {
          ...existing.governance,
          approverActorId,
          approverRole: 'capiro_admin',
        },
      };
    },
  };
}

const TARGET: ManualOverrideTargetV1 = {
  canonicalEntity: 'canonical_rdte_program_element_year',
  naturalKey: '0601101A|2027',
  fiscalYear: 2027,
  fundingField: 'request',
};

function proposal(o: Partial<ProposeManualOverrideInputV1> = {}): ProposeManualOverrideInputV1 {
  return {
    overrideId: 'ovr-1',
    target: TARGET,
    value: { originalValue: '1250', originalUnit: 'thousands', valueMillions: '1.25' },
    authorActorId: 'analyst-1',
    reason: 'transposed in the published PDF',
    evidenceIds: ['issue-42'],
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    proposedAt: '2026-07-31T00:00:00.000Z',
    ...o,
  };
}

async function refusalOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ManualOverrideRefusalError) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('Phase 7 WS K — the legacy queue vocabulary', () => {
  it('maps a program_element_year column to its funding field', () => {
    expect(fundingFieldForLegacyFieldNameV1('ndaaConference')).toBe('ndaaConference');
    expect(fundingFieldForLegacyFieldNameV1('request')).toBe('request');
  });

  it('refuses a column name that is not a funding field', () => {
    expect(() => fundingFieldForLegacyFieldNameV1('notes')).toThrow(ManualOverrideRefusalError);
  });

  it('resolves a legacy peCode/fy entry to the canonical PE-year identity', () => {
    expect(
      canonicalTargetForLegacyPeYearV1({ peCode: '0601101A', fy: 2027, fieldName: 'request' }),
    ).toEqual({
      canonicalEntity: 'canonical_rdte_program_element_year',
      naturalKey: '0601101A|2027',
      fiscalYear: 2027,
      fundingField: 'request',
    });
  });
});

describe('Phase 7 WS K — propose', () => {
  it('authors a proposal that names no approver and is version 1', async () => {
    const repo = repository();
    const record = await proposeManualOverrideV1(proposal(), repo);
    expect(record.status).toBe('proposed');
    expect(record.version).toBe(1);
    expect(record.priorOverrideId).toBeUndefined();
    expect(record.governance.approverActorId).toBeUndefined();
    expect(repo.rows).toHaveLength(1);
  });

  it('keeps money exact rather than rounding it', async () => {
    const repo = repository();
    const record = await proposeManualOverrideV1(
      proposal({
        value: { originalValue: '12.345678', originalUnit: 'millions', valueMillions: '12.345678' },
      }),
      repo,
    );
    expect(record.value.valueMillions).toBe('12.345678');
  });

  it('refuses a value that has been through a float', async () => {
    const repo = repository();
    expect(
      await refusalOf(() =>
        proposeManualOverrideV1(
          proposal({
            value: {
              originalValue: '1.2000000000000002',
              originalUnit: 'millions',
              valueMillions: '1,25',
            },
          }),
          repo,
        ),
      ),
    ).toBe('value_not_canonical_decimal');
  });

  it('refuses a second open proposal for the same target', async () => {
    const repo = repository();
    await proposeManualOverrideV1(proposal(), repo);
    expect(
      await refusalOf(() => proposeManualOverrideV1(proposal({ overrideId: 'ovr-2' }), repo)),
    ).toBe('target_has_open_proposal');
  });

  it('chains a later correction onto the version it supersedes', async () => {
    const repo = repository();
    await proposeManualOverrideV1(proposal(), repo);
    await approveManualOverrideV1(
      {
        overrideId: 'ovr-1',
        approverActorId: 'admin-1',
        approverRole: 'capiro_admin',
        approvedAt: '2026-08-01T00:00:00.000Z',
      },
      repo,
    );

    const v2 = await proposeManualOverrideV1(proposal({ overrideId: 'ovr-2' }), repo);
    expect(v2.version).toBe(2);
    expect(v2.priorOverrideId).toBe('ovr-1');
  });

  it('keeps proposals for different targets independent', async () => {
    const repo = repository();
    await proposeManualOverrideV1(proposal(), repo);
    const other = await proposeManualOverrideV1(
      proposal({
        overrideId: 'ovr-2',
        target: { ...TARGET, naturalKey: '0601102A|2027' },
      }),
      repo,
    );
    expect(other.version).toBe(1);
  });
});

describe('Phase 7 WS K — approve', () => {
  const approval = (o: Record<string, unknown> = {}) => ({
    overrideId: 'ovr-1',
    approverActorId: 'admin-1',
    approverRole: 'capiro_admin',
    approvedAt: '2026-08-01T00:00:00.000Z',
    ...o,
  });

  it('puts a proposal into force under a second admin', async () => {
    const repo = repository();
    await proposeManualOverrideV1(proposal(), repo);
    const approved = await approveManualOverrideV1(approval(), repo);

    expect(approved.status).toBe('approved');
    expect(approved.governance.approverActorId).toBe('admin-1');
    expect(approved.governance.authorActorId).toBe('analyst-1');
    expect(approved.approvedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('refuses approval by the author', async () => {
    const repo = repository();
    await proposeManualOverrideV1(proposal(), repo);
    expect(
      await refusalOf(() =>
        approveManualOverrideV1(approval({ approverActorId: 'analyst-1' }), repo),
      ),
    ).toBe('approver_is_author');
  });

  it('refuses approval by someone who is not a capiro_admin', async () => {
    const repo = repository();
    await proposeManualOverrideV1(proposal(), repo);
    expect(
      await refusalOf(() =>
        approveManualOverrideV1(approval({ approverRole: 'capiro_user' }), repo),
      ),
    ).toBe('approver_not_admin');
  });

  it('refuses a second approval of the same proposal', async () => {
    const repo = repository();
    await proposeManualOverrideV1(proposal(), repo);
    await approveManualOverrideV1(approval(), repo);
    expect(
      await refusalOf(() =>
        approveManualOverrideV1(approval({ approverActorId: 'admin-2' }), repo),
      ),
    ).toBe('proposal_not_pending');
  });

  it('refuses approving something that does not exist', async () => {
    expect(
      await refusalOf(() =>
        approveManualOverrideV1(approval({ overrideId: 'nope' }), repository()),
      ),
    ).toBe('proposal_not_found');
  });

  it('leaves the correction itself untouched by approval', async () => {
    const repo = repository();
    const proposed = await proposeManualOverrideV1(proposal(), repo);
    const approved = await approveManualOverrideV1(approval(), repo);

    expect(approved.value).toEqual(proposed.value);
    expect(approved.naturalKey).toBe(proposed.naturalKey);
    expect(approved.governance.reason).toBe(proposed.governance.reason);
    expect(approved.governance.evidenceIds).toEqual(proposed.governance.evidenceIds);
    expect(approved.version).toBe(proposed.version);
    expect(approved.proposedAt).toBe(proposed.proposedAt);
  });
});
