import { BadRequestException } from '@nestjs/common';
import {
  clientId, ctx, finding, harness, installHooks, matterId, recordProposal, runId, runResponse,
} from '../../test/fixtures/client-profile-fill-finding-review.js';

installHooks();

describe('Finding review selection and core-first effects', () => {

  test('scopes selection to tenant/client/run and deduplicates ids before the core batch', async () => {
    const core = finding('profile_field');
    const h = harness([core]);
    await expect(h.apply([core.id, core.id])).resolves.toEqual(runResponse);
    const [sql, ...params] = h.callsOf('load')[0]!.args;
    expect(sql).toContain('tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid');
    expect(sql).toContain('id = ANY($4::uuid[])');
    expect(params).toEqual([ctx.tenantId, clientId, runId, [core.id]]);
    expect(h.fill.applyFindings).toHaveBeenCalledWith(ctx, clientId, runId, [core.id]);
    expect(h.events).toEqual(['1:begin', '1:load', '1:commit', 'outside:core', 'outside:run']);
  });

  test('missing selection aborts the entire batch before either core or advanced effects', async () => {
    const core = finding('profile_field');
    const h = harness([core]);
    await expect(h.apply([core.id, 'missing'])).rejects.toThrow('One or more findings are no longer available');
    expect(h.events).toEqual(['1:begin', '1:load', '1:commit']);
    expect(h.committed).toEqual([]);
    expect(h.fill.applyFindings).not.toHaveBeenCalled();
    expect(h.service.getRun).not.toHaveBeenCalled();
  });

  test('empty selection preserves the existing merged-run result without a core call', async () => {
    const h = harness();
    await expect(h.apply()).resolves.toEqual(runResponse);
    expect(h.events).toEqual(['1:begin', '1:load', '1:commit', 'outside:run']);
    expect(h.fill.applyFindings).not.toHaveBeenCalled();
  });

  test('a fulfilled core result containing errors precedes advanced apply, acceptance, and late-bound getRun', async () => {
    const h = harness([finding('federal_footprint'), finding('profile_field')], {
      coreResult: { applied: [], errors: [{ findingId: 'core', message: 'core failed' }] },
    });
    await expect(h.apply()).resolves.toEqual(runResponse);
    expect(h.events).toEqual([
      '1:begin', '1:load', '1:commit', 'outside:core',
      '2:begin', '2:client', '2:footprint', '2:audit', '2:commit',
      '3:begin', '3:accept', '3:commit', 'outside:run',
    ]);
    expect(h.service.getRun).toHaveBeenCalledWith(ctx, clientId, runId);
  });

  test('a thrown core error prevents every advanced write and final run read', async () => {
    const error = new Error('core unavailable');
    const h = harness([finding('profile_field'), finding()], { coreError: error });
    await expect(h.apply()).rejects.toBe(error);
    expect(h.events).toEqual(['1:begin', '1:load', '1:commit', 'outside:core']);
    expect(h.committed).toEqual([]);
  });

});

describe('Advanced finding ordering and partial application', () => {
  test('records precede outcomes while preserving the selected row order within each kind', async () => {
    const rows = [
      finding('advocacy_outcome', { id: 'outcome-b' }),
      finding('advocacy_record', { id: 'record-b', proposedValue: recordProposal({ externalKey: 'record-b' }) }),
      finding('advocacy_record', { id: 'record-a', proposedValue: recordProposal({ externalKey: 'record-a' }) }),
      finding('advocacy_outcome', { id: 'outcome-a' }),
    ];
    const h = harness(rows);
    await h.apply();
    const auditedIds = h.callsOf('audit').map((call) =>
      (call.args[0] as { data: { after: { findingId: string } } }).data.after.findingId,
    );
    expect(auditedIds).toEqual(['record-b', 'record-a', 'outcome-b', 'outcome-a']);
    expect(h.callsOf('accept').map((call) => call.args[1])).toEqual(auditedIds);
    expect(h.callsOf('upsert')).toHaveLength(2);
    expect(h.callsOf('outcome-update')).toHaveLength(2);
  });

  test('unrelated advanced kinds keep their returned row order instead of gaining a new kind priority', async () => {
    const rows = [finding('regulatory_outcome'), finding('federal_footprint'), finding()];
    const h = harness(rows);
    await h.apply();
    expect(h.callsOf('audit').map((call) =>
      (call.args[0] as { data: { after: { findingId: string } } }).data.after.findingId,
    )).toEqual(rows.map((row) => row.id));
  });

  test.each(['accepted', 'rejected'])('a later %s advanced row leaves an already accepted prefix committed', async (status) => {
    const first = finding('federal_footprint');
    const h = harness([first, finding('advocacy_record', { status })]);
    await expect(h.apply()).rejects.toThrow('Only pending findings can be applied');
    expect(h.committed.map((call) => call.operation)).toEqual(['footprint', 'audit', 'accept']);
    expect(h.callsOf('accept')[0]!.args[1]).toBe(first.id);
    expect(h.callsOf('upsert')).toEqual([]);
    expect(h.service.getRun).not.toHaveBeenCalled();
  });

  test.each(['facility_resolution', 'district_nexus', 'profile_completion'])(
    'pending %s remains informational after earlier core and advanced effects', async (kind) => {
      const h = harness([finding('profile_field'), finding('federal_footprint'), finding(kind)]);
      await expect(h.apply()).rejects.toThrow('This item is informational and is not applied to the client record');
      expect(h.fill.applyFindings).toHaveBeenCalledTimes(1);
      expect(h.committed.map((call) => call.operation)).toEqual(['footprint', 'audit', 'accept']);
      expect(h.service.getRun).not.toHaveBeenCalled();
    },
  );

  test('nonpending status is rejected before the informational-kind guard', async () => {
    const h = harness([finding('facility_resolution', { status: 'informational' })]);
    await expect(h.apply()).rejects.toThrow('Only pending findings can be applied');
    expect(h.committed).toEqual([]);
  });

  test('a kind outside the advanced catalog continues through the core review boundary', async () => {
    const row = finding('future_core_kind');
    const h = harness([row]);
    await h.apply();
    expect(h.fill.applyFindings).toHaveBeenCalledWith(ctx, clientId, runId, [row.id]);
    expect(h.callsOf('audit')).toEqual([]);
  });

});

describe('Targeted finding replay and early validation', () => {
  test('already accepted targeted replay reads the current Matter on every call even when the target changes', async () => {
    const row = finding('advocacy_record', { status: 'accepted' });
    const h = harness([row]);
    await expect(h.assign({ newMatter: { title: 'Ignored on replay' } })).resolves.toEqual({
      findingId: row.id, matterId, alreadyApplied: true,
    });
    h.options.recordMatterId = 'corrected-matter';
    await expect(h.assign({ matterId: 'different-target' })).resolves.toEqual({
      findingId: row.id, matterId: 'corrected-matter', alreadyApplied: true,
    });
    expect(h.callsOf('lookup').map((call) => call.args.slice(1))).toEqual([
      [ctx.tenantId, clientId, 'lda:filing-one'], [ctx.tenantId, clientId, 'lda:filing-one'],
    ]);
    expect(h.committed).toEqual([]);
    expect(h.matters.assignSpecificMatterForRecord).not.toHaveBeenCalled();
    expect(h.service.getRun).not.toHaveBeenCalled();
  });

  test('accepted replay with no external key tolerates a null Matter without another lookup', async () => {
    const row = finding('advocacy_record', { status: 'accepted', proposedValue: {} });
    const h = harness([row]);
    await expect(h.assign({ matterId })).resolves.toEqual({ findingId: row.id, matterId: null, alreadyApplied: true });
    expect(h.callsOf('lookup')).toEqual([]);
    expect(h.committed).toEqual([]);
  });

  test('the direct action rejects a target with neither choice before loading a finding', async () => {
    const h = harness([finding()]);
    await expect(h.assign({} as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });
});
