import {
  fixture,
  client,
  ctx,
  clientId,
  runId,
  task,
  now,
  installHooks,
  labels,
  advocacySql,
  findingSql,
  failuresSql,
  leaseSql,
} from '../../test/fixtures/client-profile-fill-completion-audit.js';

installHooks();
const sqlText = (value: string) => value.replace(/\s+/g, ' ').trim();
describe('Completion audit tenant snapshot', () => {
  it('reads the exact scoped client fields and three counts in one snapshot transaction', async () => {
    const h = fixture();
    await h.audit();
    expect(h.callsOf('client')[0]!.args).toEqual([
      {
        where: { id: clientId, tenantId: ctx.tenantId },
        select: {
          website: true,
          description: true,
          uei: true,
          cageCode: true,
          ldaClientIds: true,
          intakeData: true,
          _count: {
            select: {
              capabilities: true,
              people: true,
              facilities: true,
              meetings: true,
              mailThreads: true,
            },
          },
        },
      },
    ]);
    expect(h.callsOf('facilities-count')[0]!.args).toEqual([
      { where: { tenantId: ctx.tenantId, clientId, congressionalDistrict: { not: null } } },
    ]);
    expect(sqlText(h.callsOf('advocacy-count')[0]!.sql!)).toBe(sqlText(advocacySql));
    expect(h.callsOf('advocacy-count')[0]!.args).toEqual([ctx.tenantId, clientId]);
    expect(sqlText(h.callsOf('finding-count')[0]!.sql!)).toBe(sqlText(findingSql));
    expect(h.callsOf('finding-count')[0]!.args).toEqual([ctx.tenantId, clientId, runId]);
    expect(
      h.calls
        .slice(0, 4)
        .map(({ operation, transaction, tenantId }) => ({ operation, transaction, tenantId })),
    ).toEqual(
      ['client', 'facilities-count', 'advocacy-count', 'finding-count'].map((operation) => ({
        operation,
        transaction: 1,
        tenantId: ctx.tenantId,
      })),
    );
    expect(h.phases.indexOf('1:commit')).toBeLessThan(h.phases.indexOf('2:failures'));
  });
  it('refuses a missing client before reading counts, failed tasks or the finding ledger', async () => {
    const h = fixture({ client: null });
    await expect(h.audit()).rejects.toThrow('Client not found');
    expect(h.calls.map((call) => call.operation)).toEqual(['client']);
    expect(h.phases).toEqual(['1:begin', '1:client', '1:rollback']);
    expect(h.ledger).not.toHaveBeenCalled();
  });
});

describe('Completion audit snapshot count concurrency', () => {
  it('starts all three count reads before any count promise resolves and waits for the full snapshot', async () => {
    let facilities!: (count: number) => void;
    let advocacy!: (rows: Array<{ count: number }>) => void;
    let findings!: (rows: Array<{ kind: string; count: number }>) => void;
    const holdCounts = {
      facilities: new Promise<number>((resolve) => {
        facilities = resolve;
      }),
      advocacy: new Promise<Array<{ count: number }>>((resolve) => {
        advocacy = resolve;
      }),
      findings: new Promise<Array<{ kind: string; count: number }>>((resolve) => {
        findings = resolve;
      }),
    };
    const h = fixture({ holdCounts });
    const audit = h.audit();
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    expect(h.calls.map((call) => call.operation)).toEqual([
      'client',
      'facilities-count',
      'advocacy-count',
      'finding-count',
    ]);
    facilities(0);
    advocacy([]);
    await Promise.resolve();
    expect(h.callsOf('failures')).toEqual([]);
    findings([]);
    expect(await audit).toBe(1);
    expect(h.callsOf('failures')).toHaveLength(1);
  });
});

describe('Completion audit persisted evidence projection', () => {
  it('records a zero score for an empty profile even when all evidence ledgers have no rows', async () => {
    const h = fixture();
    expect(await h.audit()).toBe(1);
    expect(h.finding().proposedValue).toEqual({
      score: 0,
      completed: [],
      missing: labels,
      warnings: [],
      calculatedAt: now.toISOString(),
    });
  });
  it('records all thirteen domains from their actual persisted sources without changing canonical scoring', async () => {
    const profile = client({
      website: 'https://example.invalid',
      description: 'Research',
      uei: 'UEI',
      ldaClientIds: [42],
      intakeData: { federalMarket: {} },
      _count: { capabilities: 1, people: 1, facilities: 1, meetings: 1 },
    });
    const h = fixture({
      client: profile,
      resolvedFacilities: 1,
      advocacyRows: [{ count: 1 }],
      findingRows: ['lda_history', 'program_element', 'bill_recommendation'].map((kind) => ({
        kind,
        count: 1,
      })),
    });
    await h.audit();
    expect(h.finding().proposedValue).toMatchObject({ score: 100, completed: labels, missing: [] });
  });
  it('counts supported current-run finding kinds with numeric coercion while ignoring unrelated kinds', async () => {
    const kinds = [
      'capability',
      'facility',
      'federal_footprint',
      'lda_history',
      'advocacy_record',
      'program_element',
      'bill_recommendation',
    ];
    const h = fixture({
      findingRows: [
        ...kinds.map((kind) => ({ kind, count: '2' })),
        { kind: 'profile_completion', count: 50 },
        { kind: 'relationship_link', count: 50 },
      ],
    });
    await h.audit();
    expect(h.finding().proposedValue).toMatchObject({
      score: 54,
      completed: [
        'Capabilities',
        'Facilities',
        'Federal Market footprint',
        'Lobbying history',
        'Advocacy history',
        'Program Elements',
        'Bill recommendations',
      ],
    });
  });
  it('uses stored advocacy records even when this run has no advocacy findings', async () => {
    const h = fixture({ advocacyRows: [{ count: '1' }] });
    await h.audit();
    expect(h.finding().proposedValue).toMatchObject({ score: 8, completed: ['Advocacy history'] });
  });
});

describe('Completion audit profile policy boundaries', () => {
  it.each([
    { counts: { people: 1, meetings: 0, mailThreads: 0 }, completed: [] },
    { counts: { people: 0, meetings: 1, mailThreads: 1 }, completed: [] },
    {
      counts: { people: 1, meetings: 0, mailThreads: 1 },
      completed: ['Relationships and history'],
    },
  ])(
    'requires both people and recorded history for relationships: %p',
    async ({ counts, completed }) => {
      const h = fixture({ client: client({ _count: counts }) });
      await h.audit();
      expect(h.finding().proposedValue.completed).toEqual(completed);
    },
  );
  it('trims website and overview while retaining the existing truthiness rule for government identifiers', async () => {
    const h = fixture({ client: client({ website: ' ', description: '\n ', uei: ' ' }) });
    await h.audit();
    expect(h.finding().proposedValue).toMatchObject({
      score: 8,
      completed: ['Government identifiers'],
    });
  });
  it.each([
    { intakeData: { federalMarket: {} }, completed: ['Federal Market footprint'] },
    { intakeData: [{ federalMarket: true }], completed: [] },
  ])(
    'preserves the persisted intake record boundary for Federal Market: %p',
    async ({ intakeData, completed }) => {
      const h = fixture({ client: client({ intakeData }) });
      await h.audit();
      expect(h.finding().proposedValue.completed).toEqual(completed);
    },
  );
  it('keeps facility existence distinct from a resolved congressional district', async () => {
    const h = fixture({ client: client({ _count: { facilities: 1 } }), resolvedFacilities: 0 });
    await h.audit();
    expect(h.finding().proposedValue.completed).toEqual(['Facilities']);
  });
});

describe('Completion audit warnings and calculation timing', () => {
  it('reads failed tasks separately after the snapshot and preserves warning order and nullable messages', async () => {
    const h = fixture({
      failedTasks: [
        { taskType: 'advocacy_history', errorMessage: null },
        { taskType: 'federal_market', errorMessage: '' },
        { taskType: 'district_nexus', errorMessage: 'District lookup failed' },
      ],
    });
    await h.audit();
    expect(sqlText(h.callsOf('failures')[0]!.sql!)).toBe(sqlText(failuresSql));
    expect(h.callsOf('failures')[0]).toMatchObject({
      transaction: 2,
      tenantId: ctx.tenantId,
      args: [ctx.tenantId, clientId, runId],
    });
    expect(h.finding().proposedValue).toMatchObject({
      score: 0,
      warnings: [
        { task: 'advocacy_history', message: 'Source unavailable' },
        { task: 'federal_market', message: '' },
        { task: 'district_nexus', message: 'District lookup failed' },
      ],
    });
  });
  it('calculates the score before failed-task reading and timestamps the payload after that read but before lease locking', async () => {
    const profile = client();
    const afterFailures = new Date('2026-10-13T12:01:00Z');
    const h = fixture({
      client: profile,
      onFailures: () => {
        profile.website = 'https://added-after-snapshot.invalid';
        jest.setSystemTime(afterFailures);
      },
      onLease: () => {
        jest.setSystemTime(new Date('2026-10-13T12:02:00Z'));
      },
    });
    await h.audit();
    expect(h.finding().proposedValue).toMatchObject({
      score: 0,
      completed: [],
      calculatedAt: afterFailures.toISOString(),
    });
  });
});

describe('Completion audit informational finding and real task fencing', () => {
  it('forwards the original task object and persists the exact informational envelope through the real ledger', async () => {
    const auditTask = { ...task, workerId: 'audit-worker:lease' };
    const h = fixture();
    await h.audit(auditTask);
    expect(h.ledger.mock.calls[0]![4]).toBe(auditTask);
    expect(h.finding()).toMatchObject({
      runId,
      tenantId: ctx.tenantId,
      clientId,
      kind: 'profile_completion',
      targetKey: 'profile-completion',
      source: 'completion_audit',
      factKind: 'fact',
      currentValue: null,
      confidence: 1,
      status: 'informational',
    });
    expect(h.finding().evidence).toEqual([
      {
        label: '0% of the defined client profile domains are complete',
        source: 'Capiro deterministic completion audit',
        metadata: { completed: [], missing: labels },
      },
    ]);
    expect(sqlText(h.callsOf('lease')[0]!.sql!)).toBe(sqlText(leaseSql));
    expect(h.callsOf('lease')[0]!.args).toEqual([
      auditTask.id,
      ctx.tenantId,
      clientId,
      runId,
      auditTask.workerId,
    ]);
  });
  it('locks the lease before terminal checking and writes in one third tenant transaction', async () => {
    const h = fixture();
    await h.audit();
    const ledgerCalls = h.calls.filter((call) => call.transaction === 3);
    expect(ledgerCalls.map((call) => call.operation)).toEqual([
      'lease',
      'terminal',
      'retire',
      'insert',
    ]);
    expect(ledgerCalls.every((call) => call.tenantId === ctx.tenantId)).toBe(true);
    expect(h.callsOf('terminal')[0]!.args).toEqual([
      ctx.tenantId,
      clientId,
      h.finding().contentHash,
    ]);
    expect(h.callsOf('retire')[0]!.args).toEqual([
      ctx.tenantId,
      clientId,
      h.finding().contentHash,
      runId,
    ]);
    expect(h.callsOf('insert')[0]!.sql).toContain('ON CONFLICT (run_id, content_hash) DO NOTHING');
    expect(h.finding().contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([null, { ...task, workerId: 'different-lease' }, { ...task, id: 'missing-task' }])(
    'refuses writes when the durable task lease is absent or different: %p',
    async (lease) => {
      const h = fixture({ lease });
      expect(await h.audit()).toBe(0);
      expect(
        h.calls.filter((call) => call.transaction === 3).map((call) => call.operation),
      ).toEqual(['lease']);
      expect(h.callsOf('insert')).toEqual([]);
    },
  );
  it('passes a null worker lease unchanged and fails closed', async () => {
    const nullLease = { ...task, workerId: null };
    const h = fixture({ lease: nullLease });
    expect(await h.audit(nullLease)).toBe(0);
    expect(h.callsOf('lease')[0]!.args[4]).toBeNull();
    expect(h.callsOf('terminal')).toEqual([]);
  });
});

describe('Completion audit durability outcomes', () => {
  it('uses explicit audit scope in the lease predicates rather than differing task metadata', async () => {
    const otherMetadata = {
      ...task,
      tenantId: 'other-tenant',
      clientId: 'other-client',
      runId: 'other-run',
    };
    const h = fixture();
    expect(await h.audit(otherMetadata)).toBe(1);
    expect(h.callsOf('lease')[0]!.args).toEqual([
      task.id,
      ctx.tenantId,
      clientId,
      runId,
      task.workerId,
    ]);
    expect(h.ledger.mock.calls[0]![4]).toBe(otherMetadata);
  });
  it('keeps accepted/rejected hash history without retiring or inserting another finding', async () => {
    const h = fixture({ terminal: true });
    expect(await h.audit()).toBe(0);
    expect(h.calls.filter((call) => call.transaction === 3).map((call) => call.operation)).toEqual([
      'lease',
      'terminal',
    ]);
  });
  it('returns zero when the actual conflict-safe insert reports no new row', async () => {
    const h = fixture({ inserted: 0 });
    expect(await h.audit()).toBe(0);
    expect(h.callsOf('insert')).toHaveLength(1);
    expect(h.finding().status).toBe('informational');
  });
  it('propagates a lease-read error after computing the payload without writing a stale score', async () => {
    const h = fixture({ errors: { lease: new Error('lease read unavailable') } });
    await expect(h.audit()).rejects.toThrow('lease read unavailable');
    expect(h.ledger).toHaveBeenCalledTimes(1);
    expect(h.callsOf('insert')).toEqual([]);
    expect(h.phases).toContain('3:rollback');
  });
});

describe('Completion audit read failures preserve effect boundaries', () => {
  it('does not read warnings or emit when one snapshot count fails', async () => {
    const h = fixture({ errors: { 'advocacy-count': new Error('snapshot count unavailable') } });
    await expect(h.audit()).rejects.toThrow('snapshot count unavailable');
    expect(h.callsOf('finding-count')).toHaveLength(1);
    expect(h.callsOf('failures')).toEqual([]);
    expect(h.ledger).not.toHaveBeenCalled();
    expect(h.phases).toContain('1:rollback');
  });
  it('does not emit if the separate failed-task read fails after the snapshot commits', async () => {
    const h = fixture({ errors: { failures: new Error('warnings unavailable') } });
    await expect(h.audit()).rejects.toThrow('warnings unavailable');
    expect(h.phases).toContain('1:commit');
    expect(h.phases).toContain('2:rollback');
    expect(h.ledger).not.toHaveBeenCalled();
    expect(h.callsOf('insert')).toEqual([]);
  });
});
