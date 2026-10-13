import {
  advocacy,
  clientId,
  ctx,
  harness,
  row,
  runId,
} from '../../test/fixtures/client-profile-fill-reconciliation.js';

afterEach(() => jest.restoreAllMocks());

describe('Completion reconciliation — scoped snapshot and exact duplicates', () => {
  test('reads only the scoped pending snapshot in priority order before the independent association scan', async () => {
    const h = harness();
    expect(await h.reconcile()).toBe(0);
    expect(h.state.calls.map((call) => call.operation)).toEqual(['pending', 'associations']);
    expect(h.state.calls[0]!.args).toEqual([ctx.tenantId, clientId, runId]);
    expect(h.state.calls[0]!.sql).toContain("AND status = 'pending'");
    expect(h.state.calls[0]!.sql).toContain('ORDER BY confidence DESC, created_at ASC');
    expect(h.state.calls.map((call) => call.transaction)).toEqual([1, 2]);
    expect(h.findingWrites()).toEqual([]);
  });
  test('keeps the first priority row and retires later equal-value rows individually despite differing object key order and SQL zero counts', async () => {
    const rows = [
      row('winner'),
      row('second', { proposedValue: { sector: 'Defense', name: 'Acme' } }),
      row('third'),
    ];
    const h = harness({ rows, duplicateAffected: 0 });
    expect(await h.reconcile()).toBe(2);
    const updates = h.state.calls.filter((call) => call.operation === 'duplicate-update');
    expect(updates.map((call) => call.args)).toEqual([
      ['second', ctx.tenantId],
      ['third', ctx.tenantId],
    ]);
    expect(updates.map((call) => call.transaction)).toEqual([2, 3]);
    expect(updates.every((call) => call.sql.includes("status = 'pending'"))).toBe(true);
    expect(h.state.transactions.map((tx) => tx.result)).toEqual([
      'commit',
      'commit',
      'commit',
      'commit',
    ]);
    expect(rows.map((value) => value.status)).toEqual(['pending', 'pending', 'pending']);
    expect(h.findingWrites()).toEqual([]);
  });
  test('keeps distinct kind or target groups independent without discarding their equal values', async () => {
    const h = harness({
      rows: [
        row('first'),
        row('different-kind', { kind: 'capability' }),
        row('different-target', { targetKey: 'profile:sector' }),
      ],
    });
    expect(await h.reconcile()).toBe(0);
    expect(h.state.committedCalls).toEqual([]);
  });
});

describe('Completion reconciliation — informational conflicts and insertion counts', () => {
  test.each([
    { name: 'inserted', insertResults: [1], terminal: false, count: 1 },
    { name: 'same-run duplicate', insertResults: [0], terminal: false, count: 0 },
    { name: 'already reviewed', insertResults: [], terminal: true, count: 0 },
  ])(
    'counts a $name conflict as $count without choosing or applying a proposal',
    async ({ insertResults, terminal, count }) => {
      const h = harness({
        rows: [
          row('high', { confidence: '0.95' }),
          row('low', { source: 'lda', confidence: '0.5', proposedValue: { name: 'Other' } }),
        ],
        insertResults,
        terminal,
      });
      expect(await h.reconcile()).toBe(count);
      expect(h.state.calls.filter((call) => call.operation === 'duplicate-update')).toEqual([]);
      if (terminal) {
        expect(h.findingWrites()).toEqual([]);
        return;
      }
      const finding = h.findingWrites()[0]!;
      expect(finding).toMatchObject({
        runId,
        tenantId: ctx.tenantId,
        clientId,
        kind: 'profile_completion',
        source: 'reconciliation',
        factKind: 'recommendation',
        currentValue: null,
        confidence: 1,
        status: 'informational',
        proposedValue: {
          type: 'conflict',
          target: 'profile_field:profile:name',
          findingIds: ['high', 'low'],
          message:
            'Multiple sources proposed different values. Review them individually; none was auto-selected.',
        },
        evidence: [
          {
            label: 'public_web proposed a value for profile:name',
            source: 'public_web',
            metadata: { findingId: 'high', confidence: 0.95 },
          },
          {
            label: 'lda proposed a value for profile:name',
            source: 'lda',
            metadata: { findingId: 'low', confidence: 0.5 },
          },
        ],
      });
      expect(finding.targetKey).toMatch(/^conflict:[a-f0-9]{20}$/);
    },
  );
});

describe('Completion reconciliation — canonical Matter association authority', () => {
  test.each([
    {
      status: 'pending',
      kind: 'program_element',
      proposal: { peCode: 'PE123' },
      type: 'program_element',
    },
    {
      status: 'informational',
      kind: 'program_element',
      proposal: { peCode: 'PE123' },
      type: 'program_element',
    },
    {
      status: 'accepted',
      kind: 'program_element',
      proposal: { peCode: 'PE123' },
      type: 'program_element',
    },
    {
      status: 'rejected',
      kind: 'bill_recommendation',
      proposal: { billId: 'PE123' },
      type: 'bill',
    },
  ])(
    'links a $status $kind by exact Matter identifier with the original actor and no status narrowing',
    async ({ status, kind, proposal, type }) => {
      const h = harness({
        associations: [{ id: 'source-finding', kind, status, proposedValue: proposal }],
        matterIds: { PE123: 'matter-one' },
      });
      expect(await h.reconcile()).toBe(1);
      const scan = h.state.calls.find((call) => call.operation === 'associations')!;
      expect(scan.args).toEqual([ctx.tenantId, clientId, runId]);
      expect(scan.sql).not.toContain('status =');
      const lookup = h.state.calls.find((call) => call.operation === 'matter-lookup')!;
      expect(lookup.args).toEqual([ctx.tenantId, clientId, 'PE123']);
      expect(lookup.sql).toContain(
        kind === 'program_element' ? 'primary_pe_code = $3' : 'primary_bill_id = $3',
      );
      const link = h.state.calls.find((call) => call.operation === 'matter-link')!;
      expect(link.args).toEqual([
        ctx.tenantId,
        'matter-one',
        type,
        'PE123',
        'PE123',
        JSON.stringify({ findingId: 'source-finding' }),
        ctx.userId,
      ]);
      expect(link.sql).toContain('ON CONFLICT (matter_id, link_type, link_key) DO UPDATE');
      expect(link.sql).toContain('metadata_jsonb || EXCLUDED.metadata_jsonb');
      expect(link.transaction).not.toBe(lookup.transaction);
    },
  );
  test('skips absent identifiers and unmatched Matters without creating a Matter or linking another client', async () => {
    const h = harness({
      associations: [
        { id: 'blank', kind: 'program_element', proposedValue: { peCode: '' } },
        { id: 'absent', kind: 'bill_recommendation', proposedValue: {} },
        { id: 'unmatched', kind: 'bill_recommendation', proposedValue: { billId: 'HR1' } },
      ],
    });
    expect(await h.reconcile()).toBe(0);
    expect(h.state.calls.filter((call) => call.operation === 'matter-lookup')).toHaveLength(1);
    expect(h.state.calls.filter((call) => call.operation === 'matter-link')).toEqual([]);
  });
});

describe('Completion reconciliation — phase ordering and best-effort links', () => {
  test('commits canonical Matter association before writing a review-only possible-duplicate finding', async () => {
    const h = harness({
      rows: [advocacy('b'), advocacy('a')],
      associations: [
        {
          id: 'pe',
          kind: 'program_element',
          proposedValue: { peCode: 'PE123', title: 'Capability' },
        },
      ],
      matterIds: { PE123: 'matter-one' },
    });
    expect(await h.reconcile()).toBe(2);
    const operations = h.state.calls.map((call) => call.operation);
    expect(operations.indexOf('matter-link')).toBeLessThan(operations.indexOf('terminal-check'));
    const finding = h.findingWrites()[0]!;
    expect(finding).toMatchObject({
      kind: 'advocacy_duplicate_candidate',
      source: 'reconciliation',
      status: 'informational',
      factKind: 'recommendation',
      confidence: 0.6,
      currentValue: null,
      proposedValue: {
        type: 'possible_duplicate',
        findingIds: ['b', 'a'],
        message:
          'Two different sources may describe the same advocacy activity on the same day. Review before accepting both.',
      },
      evidence: [
        { source: 'client_submission', metadata: { findingId: 'b' } },
        { source: 'lda', metadata: { findingId: 'a' } },
      ],
    });
    expect(finding.targetKey).toMatch(/^advocacy-duplicate:[a-f0-9]{20}$/);
    expect(h.state.calls.filter((call) => call.operation === 'duplicate-update')).toEqual([]);
  });
  test('logs sanitized link failure, continues to another canonical link and still emits duplicate flags', async () => {
    const h = harness({
      rows: [advocacy('a'), advocacy('b')],
      associations: [
        { id: 'pe', kind: 'program_element', proposedValue: { peCode: 'PE123' } },
        {
          id: 'bill',
          kind: 'bill_recommendation',
          proposedValue: { billId: 'HR1', title: 'Bill title' },
        },
      ],
      matterIds: { PE123: 'matter-one', HR1: 'matter-two' },
      linkErrors: { PE123: new Error('authorization: pretend-secret') },
    });
    expect(await h.reconcile()).toBe(2);
    expect(h.warning).toHaveBeenCalledWith(
      'Advocacy matter finding link failed for client-one/matter-one: authorization=[redacted]',
    );
    expect(h.state.transactions.filter((tx) => tx.result === 'rollback')).toHaveLength(1);
    const links = h.state.committedCalls.filter((call) => call.operation === 'matter-link');
    expect(links).toHaveLength(1);
    expect(links[0]!.args.slice(1, 5)).toEqual(['matter-two', 'bill', 'HR1', 'Bill title']);
    expect(h.findingWrites()[0]!.kind).toBe('advocacy_duplicate_candidate');
  });
});

describe('Completion reconciliation — duplicate signal boundaries', () => {
  test.each([
    {
      name: 'different UTC day',
      overrides: {
        proposedValue: { title: 'alpha bravo charlie delta echo', activityDate: '2026-10-14' },
      },
    },
    {
      name: 'missing date',
      overrides: { proposedValue: { title: 'alpha bravo charlie delta echo' } },
    },
    {
      name: 'low overlap',
      overrides: {
        proposedValue: { title: 'alpha bravo foxtrot golf hotel', activityDate: '2026-10-13' },
      },
    },
    { name: 'missing title', overrides: { proposedValue: { activityDate: '2026-10-13' } } },
    { name: 'rejected snapshot row', overrides: { status: 'rejected' } },
  ])('does not flag $name as the same event', async ({ overrides }) => {
    const h = harness({ rows: [advocacy('a'), advocacy('b', overrides)] });
    expect(await h.reconcile()).toBe(0);
    expect(h.findingWrites()).toEqual([]);
  });
  test.each([1, 0])(
    'uses same UTC day and the inclusive 60 percent threshold while counting only %s inserted flag',
    async (inserted) => {
      const h = harness({
        rows: [
          advocacy('a', {
            proposedValue: {
              title: 'alpha bravo charlie delta echo',
              activityDate: '2026-10-13T23:30:00-04:00',
            },
          }),
          advocacy('b', {
            proposedValue: {
              title: 'alpha bravo charlie foxtrot golf',
              activityDate: '2026-10-14T08:00:00Z',
            },
          }),
        ],
        insertResults: [inserted],
      });
      expect(await h.reconcile()).toBe(inserted);
      expect(h.findingWrites()).toHaveLength(1);
    },
  );
  test('does not flag a pair with the same exact target after its equal-value duplicate retirement', async () => {
    const h = harness({ rows: [advocacy('a'), advocacy('b', { targetKey: 'advocacy:a' })] });
    expect(await h.reconcile()).toBe(1);
    expect(h.findingWrites()).toEqual([]);
    expect(h.state.calls.filter((call) => call.operation === 'duplicate-update')).toHaveLength(1);
  });
});

describe('Completion reconciliation — partial commits and propagation', () => {
  test('preserves the first duplicate retirement when a later per-duplicate transaction fails and stops later phases', async () => {
    const h = harness({ rows: [row('winner'), row('second'), row('third')], failDuplicateAt: 2 });
    await expect(h.reconcile()).rejects.toThrow('duplicate unavailable');
    expect(h.state.committedCalls.map((call) => [call.operation, call.args[0]])).toEqual([
      ['duplicate-update', 'second'],
    ]);
    expect(h.state.transactions.map((tx) => tx.result)).toEqual(['commit', 'commit', 'rollback']);
    expect(h.state.calls.some((call) => call.operation === 'associations')).toBe(false);
  });
  test('does not roll back prior duplicate retirement when the independent association scan fails', async () => {
    const h = harness({
      rows: [row('winner'), row('second')],
      associationError: new Error('association unavailable'),
    });
    await expect(h.reconcile()).rejects.toThrow('association unavailable');
    expect(h.state.committedCalls.map((call) => call.operation)).toEqual(['duplicate-update']);
    expect(h.state.transactions.map((tx) => tx.result)).toEqual(['commit', 'commit', 'rollback']);
  });
  test('preserves an already committed Matter link when duplicate-finding persistence fails later', async () => {
    const h = harness({
      rows: [advocacy('a'), advocacy('b')],
      associations: [{ id: 'pe', kind: 'program_element', proposedValue: { peCode: 'PE123' } }],
      matterIds: { PE123: 'matter-one' },
      insertResults: [new Error('finding unavailable')],
    });
    await expect(h.reconcile()).rejects.toThrow('finding unavailable');
    expect(h.state.committedCalls.map((call) => call.operation)).toEqual(['matter-link']);
    expect(h.state.transactions.at(-1)!.result).toBe('rollback');
    expect(h.state.committedCalls.some((call) => call.operation === 'retire-prior')).toBe(false);
  });
});
