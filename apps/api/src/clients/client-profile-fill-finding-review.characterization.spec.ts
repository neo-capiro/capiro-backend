import { BadRequestException } from '@nestjs/common';
import {
  clientId,
  ctx,
  finding,
  fixtureId,
  harness,
  installHooks,
  matterId,
  recordProposal,
  runId,
} from '../../test/fixtures/client-profile-fill-finding-review.js';

installHooks();

describe('Revision-bound selection and atomic effects', () => {
  test('scopes selected findings to tenant/client/run and applies core effects in the review transaction', async () => {
    const core = finding('profile_field'),
      h = harness([core, finding('federal_footprint')]);
    await expect(h.apply([core.id])).resolves.toMatchObject({
      status: 'completed',
      applied: [core.id],
      errors: [],
    });
    const [sql, ...params] = h.callsOf('load')[0]!.args;
    expect(sql).toContain('tenant_id=$1::uuid AND client_id=$2::uuid AND run_id=$3::uuid');
    expect(sql).toContain('FOR UPDATE');
    expect(params).toEqual([ctx.tenantId, clientId, runId]);
    expect(h.fill.applyFindingInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ tx: h.transactions[0]!.tx }),
      ctx,
      clientId,
      expect.objectContaining({ id: core.id, status: 'pending' }),
    );
    expect(h.callsOf('core')[0]!.transaction).toBe(h.callsOf('accept')[0]!.transaction);
    expect(h.callsOf('footprint')).toEqual([]);
    expect(h.service.getRun).not.toHaveBeenCalled();
    expect(h.events.indexOf('1:commit')).toBeLessThan(h.events.indexOf('outside:after-applied'));
  });
  test('duplicate selected IDs are refused before any transaction', async () => {
    const core = finding('profile_field'),
      h = harness([core]);
    await expect(h.apply([core.id, core.id])).rejects.toBeInstanceOf(BadRequestException);
    expect(h.transactions).toEqual([]);
    expect(h.committed).toEqual([]);
  });
  test('missing selection durably refuses the entire batch before core or advanced effects', async () => {
    const core = finding('profile_field'),
      missing = fixtureId('missing'),
      h = harness([core, finding()]);
    const command = h.command([core.id, missing]);
    await expect(h.submit(command)).resolves.toMatchObject({
      status: 'refused',
      applied: [],
      errors: [
        { findingId: core.id, message: expect.stringContaining('selected finding changed') },
        { findingId: missing, message: expect.stringContaining('selected finding changed') },
      ],
    });
    expect(h.committed.map((c) => c.operation)).toEqual(['receipt']);
    expect(h.fill.applyFindingInTransaction).not.toHaveBeenCalled();
    expect(h.callsOf('upsert')).toEqual([]);
    await expect(h.submit(command)).resolves.toMatchObject({ status: 'refused', replayed: true });
  });
  test.each(['empty', 'client revision', 'finding revision'])(
    'missing %s snapshot is refused before any transaction',
    async (invalid) => {
      const h = harness([finding()]),
        command = h.command();
      if (invalid === 'empty') command.findings = [];
      else if (invalid === 'client revision') command.expectedClientRevision = '';
      else command.findings[0]!.revision = '';
      await expect(h.submit(command)).rejects.toBeInstanceOf(BadRequestException);
      expect(h.transactions).toEqual([]);
      expect(h.committed).toEqual([]);
    },
  );
  test.each(['client', 'finding'])(
    'stale %s revision creates only a refusal receipt',
    async (stale) => {
      const h = harness([finding()]),
        command = h.command();
      if (stale === 'client') h.options.client = { id: clientId, intakeData: { changed: true } };
      else h.rows[0]!.proposedValue = recordProposal({ title: 'Changed after review' });
      await expect(h.submit(command)).resolves.toMatchObject({
        status: 'refused',
        applied: [],
        errors: [{ findingId: h.rows[0]!.id, message: expect.stringContaining('changed') }],
      });
      expect(h.committed.map((c) => c.operation)).toEqual(['receipt']);
      expect(h.callsOf('savepoint')).toEqual([]);
    },
  );
  test('core failure rolls back its savepoint while an independently reviewed advanced finding completes', async () => {
    const core = finding('profile_field'),
      advanced = finding('federal_footprint');
    const h = harness([core, advanced], { coreError: new Error('secret provider failure') });
    await expect(h.apply()).resolves.toMatchObject({
      status: 'partial',
      applied: [advanced.id],
      errors: [
        {
          findingId: core.id,
          message: 'Could not apply this finding. No changes from this finding were saved.',
        },
      ],
    });
    expect(h.committed.map((c) => c.operation)).toEqual([
      'footprint',
      'audit',
      'accept',
      'receipt',
    ]);
    expect(h.callsOf('savepoint-rollback')).toHaveLength(1);
    expect(h.transactions.map((t) => t.result)).toEqual(['commit']);
  });
  test.each(['commitError', 'receiptError'] as const)(
    '%s rolls back all findings and schedules no postcommit work',
    async (failure) => {
      const error = new Error('outer transaction unavailable');
      const h = harness([finding(), finding('federal_footprint')], { [failure]: error });
      await expect(h.apply()).rejects.toBe(error);
      expect(h.committed).toEqual([]);
      expect(h.rows.every((row) => row.status === 'pending')).toBe(true);
      expect(h.callsOf('automatic')).toEqual([]);
      expect(h.callsOf('after-applied')).toEqual([]);
    },
  );
});

describe('Advanced finding ordering and partial application', () => {
  test('advocacy records precede outcomes without losing either selected record', async () => {
    const records = ['record-b', 'record-a'].map((id) =>
      finding('advocacy_record', {
        id: fixtureId(id),
        proposedValue: recordProposal({ externalKey: id }),
      }),
    );
    const outcomes = ['outcome-b', 'outcome-a'].map((id) =>
      finding('advocacy_outcome', { id: fixtureId(id) }),
    );
    const h = harness([outcomes[0]!, records[0]!, records[1]!, outcomes[1]!]);
    await expect(h.apply()).resolves.toMatchObject({ status: 'completed', errors: [] });
    const auditedIds = h
      .callsOf('audit')
      .map((c) => (c.args[0] as { data: { after: { findingId: string } } }).data.after.findingId);
    expect(new Set(auditedIds.slice(0, 2))).toEqual(new Set(records.map((row) => row.id)));
    expect(auditedIds.slice(2)).toEqual(outcomes.map((row) => row.id));
    expect(h.callsOf('accept').map((c) => c.args[1])).toEqual(auditedIds);
    expect(h.callsOf('upsert')).toHaveLength(2);
    expect(h.callsOf('outcome-update')).toHaveLength(2);
  });
  test('unrelated advanced kinds retain selected order', async () => {
    const rows = [finding('regulatory_outcome'), finding('federal_footprint')],
      h = harness(rows);
    await h.apply();
    expect(
      h
        .callsOf('audit')
        .map((c) => (c.args[0] as { data: { after: { findingId: string } } }).data.after.findingId),
    ).toEqual(rows.map((row) => row.id));
  });
  test.each(['accepted', 'rejected'])(
    '%s findings never rewrite their records while another finding can succeed',
    async (status) => {
      const first = finding('federal_footprint'),
        terminal = finding('advocacy_record', { status }),
        h = harness([first, terminal]);
      await expect(h.apply()).resolves.toMatchObject({
        status: status === 'accepted' ? 'completed' : 'partial',
        applied: [first.id],
        alreadyApplied: status === 'accepted' ? [terminal.id] : [],
        errors:
          status === 'accepted'
            ? []
            : [{ findingId: terminal.id, message: 'Only pending findings can be applied' }],
      });
      expect(h.committed.map((c) => c.operation)).toEqual([
        'footprint',
        'audit',
        'accept',
        'receipt',
      ]);
      expect(h.callsOf('upsert')).toEqual([]);
    },
  );
  test.each(['facility_resolution', 'district_nexus', 'profile_completion'])(
    '%s stays informational while other reviewed findings commit',
    async (kind) => {
      const rows = [finding('profile_field'), finding('federal_footprint'), finding(kind)],
        h = harness(rows);
      await expect(h.apply()).resolves.toMatchObject({
        status: 'partial',
        applied: rows.slice(0, 2).map((row) => row.id),
        errors: [
          {
            findingId: rows[2]!.id,
            message: 'This item is informational and is not applied to the client record',
          },
        ],
      });
      expect(h.fill.applyFindingInTransaction).toHaveBeenCalledTimes(1);
      expect(h.callsOf('accept')).toHaveLength(2);
      expect(h.callsOf('savepoint-rollback')).toHaveLength(1);
    },
  );
  test('nonpending status is refused before informational-kind validation', async () => {
    const h = harness([finding('facility_resolution', { status: 'informational' })]);
    await expect(h.apply()).resolves.toMatchObject({
      status: 'refused',
      errors: [{ findingId: h.rows[0]!.id, message: 'Only pending findings can be applied' }],
    });
    expect(h.committed.map((c) => c.operation)).toEqual(['receipt']);
  });
  test('a kind outside the advanced catalog uses the core transactional boundary', async () => {
    const row = finding('future_core_kind'),
      h = harness([row]);
    await h.apply();
    expect(h.fill.applyFindingInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ tx: h.transactions[0]!.tx }),
      ctx,
      clientId,
      expect.objectContaining({ id: row.id }),
    );
    expect(h.callsOf('audit')).toEqual([]);
    expect(h.callsOf('accept')).toHaveLength(1);
  });
});

describe('Targeted replay and early validation', () => {
  test('exact replay returns the committed receipt without new writes and refuses target substitution', async () => {
    const row = finding(),
      h = harness([row]),
      command = h.command();
    const submit = (target: { matterId: string }) =>
      h.service.applyAdvocacyFindingToMatter(ctx, clientId, runId, row.id, target, command);
    await expect(submit({ matterId })).resolves.toMatchObject({
      applied: [row.id],
      replayed: false,
    });
    await expect(submit({ matterId })).resolves.toMatchObject({
      applied: [row.id],
      replayed: true,
    });
    expect(h.callsOf('upsert')).toHaveLength(1);
    expect(h.callsOf('target')).toHaveLength(1);
    expect(h.callsOf('accept')).toHaveLength(1);
    await expect(submit({ matterId: fixtureId('different-target') })).rejects.toThrow(
      'Application request identity or inputs changed',
    );
    expect(h.callsOf('target')).toHaveLength(1);
  });
  test('accepted finding returns alreadyApplied without a Matter lookup or writer', async () => {
    const row = finding('advocacy_record', { status: 'accepted', proposedValue: {} }),
      h = harness([row]);
    await expect(h.assign({ matterId })).resolves.toMatchObject({
      applied: [],
      alreadyApplied: [row.id],
      status: 'completed',
    });
    expect(h.callsOf('lookup')).toEqual([]);
    expect(h.callsOf('target')).toEqual([]);
    expect(h.callsOf('upsert')).toEqual([]);
  });
  test('a target with neither choice is refused before opening a transaction', async () => {
    const h = harness([finding()]);
    await expect(h.assign({} as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.withTenantUser).not.toHaveBeenCalled();
  });
});
