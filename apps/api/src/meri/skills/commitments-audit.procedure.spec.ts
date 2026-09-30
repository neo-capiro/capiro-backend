import {
  COMMITMENTS_AUDIT_CAPABILITIES,
  COMMITMENTS_AUDIT_COVERAGE_STATES,
  COMMITMENTS_AUDIT_STATUSES,
  commitmentsAuditProcedureSkill,
} from './commitments-audit.procedure.js';

describe('Commitments & Deliverables procedure contract', () => {
  const manifest = commitmentsAuditProcedureSkill.procedure!;

  it('fixes all CD output fields, statuses, coverage, and requested-window policy', () => {
    expect(manifest.output.fields).toEqual(
      expect.arrayContaining([
        'source',
        'sourceVersion',
        'locator',
        'observedAt',
        'promise',
        'madeAt',
        'madeWhere',
        'owner',
        'dueDate',
        'dependency',
        'acceptance',
        'linkedRecordId',
        'nativeStatus',
        'proposedFollowUp',
        'auditStatus',
        'citations',
      ]),
    );
    expect(manifest.output.statuses).toEqual(COMMITMENTS_AUDIT_STATUSES);
    expect(manifest.output.coverageStates).toEqual(COMMITMENTS_AUDIT_COVERAGE_STATES);
    expect(manifest.output.honorRequestedWindow).toBe(true);
    expect(manifest.output.defaultRecentWindowDays).toBeNull();
    expect(manifest.output.reportPartialCoverage).toBe(true);
  });

  it('preserves modality and leaves unsupported owner and due date unknown', () => {
    expect(manifest.output.preserveModality).toBe(true);
    expect(manifest.output.unknownValue).toBe('unknown');
    expect(manifest.examples.join(' ')).toContain('may');
    expect(manifest.examples.join(' ')).toContain('owner: unknown');
    expect(manifest.examples.join(' ')).toContain('dueDate: unknown');
  });

  it('is a zero-write contract across capabilities, policy, guidance, and completion', () => {
    expect(manifest.allowedCapabilities).toEqual(COMMITMENTS_AUDIT_CAPABILITIES);
    expect(manifest.allowedCapabilities.every((capability) => capability.endsWith('.read'))).toBe(
      true,
    );
    expect(manifest.effectPolicy).toMatchObject({
      mode: 'read_only',
      prohibitedEffects: ['create or update a task', 'send a message', 'write memory'],
    });
    expect(commitmentsAuditProcedureSkill.systemAddendum).toContain(
      'creates no task, message, memory',
    );
    expect(manifest.completion).toContain(
      'Return no task, message, memory, or other external effect',
    );
  });

  it('retains all seven CD benchmark IDs without claiming execution', () => {
    expect(manifest.caseIds).toEqual([
      'CD-01',
      'CD-02',
      'CD-03',
      'CD-04',
      'CD-05',
      'CD-06',
      'CD-07',
    ]);
  });
});
