import { NotFoundException } from '@nestjs/common';
import {
  clientId, ctx, finding, harness, installHooks, matterId, now, recordProposal,
} from '../../test/fixtures/client-profile-fill-finding-review.js';

installHooks();

describe('Canonical advocacy record validation and coercion', () => {
  test.each<[string, string, unknown]>([
    ['externalKey', 'Advocacy external key', '  '], ['title', 'Advocacy title', null],
    ['recordType', 'Advocacy record type', 7], ['sourceType', 'Advocacy source type', []],
  ])('%s is validated before any application write', async (field, label, value) => {
    const h = harness([finding('advocacy_record', { proposedValue: recordProposal({ [String(field)]: value }) })]);
    await expect(h.apply()).rejects.toThrow(`${label} is required`);
    expect(h.events).toEqual(['1:begin', '1:load', '1:commit']);
    expect(h.committed).toEqual([]);
  });

  test('defaults optional strings/date/evidence/metadata and preserves the canonical upsert parameters', async () => {
    const row = finding('advocacy_record', { confidence: '0.8', proposedValue: recordProposal({
      title: '  Funding request  ', sourceId: 9, sourceUrl: ' ', metadata: [], evidenceClass: 'unknown',
    }) });
    const h = harness([row]);
    await h.apply();
    const [sql, ...params] = h.callsOf('upsert')[0]!.args;
    expect(params).toEqual([
      ctx.tenantId, clientId, 'federal_lobbying', 'Funding request', null, '', null, null,
      'lda', null, null, 'INFERRED', 0.8, 'lda:filing-one', '{}', ctx.userId,
    ]);
    expect(sql).toContain('ON CONFLICT (tenant_id, client_id, external_key) DO UPDATE');
    expect(sql).toContain('outcome = COALESCE(EXCLUDED.outcome, client_advocacy_record.outcome)');
    expect(sql).toContain('metadata_jsonb = client_advocacy_record.metadata_jsonb || EXCLUDED.metadata_jsonb');
    expect(h.matters.assignMatterForRecord).toHaveBeenCalledWith(ctx, clientId, 'lda:filing-one', {
      recordType: 'federal_lobbying', title: 'Funding request', metadata: {}, activityDate: null,
    });
  });

  test.each<[string, unknown, number]>([
    ['PUBLIC_VERIFIED', '0.25', 0.25], ['CLIENT_VERIFIED', 4, 1],
    ['PRIVATE_ACTIVITY', -4, 0], ['INFERRED', null, 0.9],
  ])('preserves %s evidence and confidence coercion/clamping', async (evidenceClass, confidence, expected) => {
    const h = harness([finding('advocacy_record', { proposedValue: recordProposal({ evidenceClass, confidence }) })]);
    await h.apply();
    expect(h.callsOf('upsert')[0]!.args.slice(12, 14)).toEqual([evidenceClass, expected]);
  });

});

describe('Advocacy record confirmed attribution before writes', () => {
  test.each<[string, string, Record<string, unknown>]>([
    ['fara', 'registration-one', { registrationNumber: 'registration-one' }],
    ['testimony', 'hearing-one::Witness, Client', { hearingId: 'hearing-one', witness: 'Witness, Client' }],
  ])('confirmed %s mapping is read before upsert and augments rather than replaces metadata', async (sourceType, key, keys) => {
    const metadata = { ...keys, retained: true, clientMatch: { method: 'name_similarity', score: 0.77 } };
    const row = finding('advocacy_record', { proposedValue: recordProposal({ sourceType, metadata }) });
    const h = harness([row], { confirmedKeys: [String(key)] });
    await h.apply();
    expect(h.callsOf('mapping')[0]!.args[0]).toEqual({
      where: { clientId, source: sourceType, confirmed: true }, select: { externalId: true },
    });
    expect(h.callsOf('mapping')[0]!.transaction).toBe(2);
    expect(h.callsOf('upsert')[0]!.transaction).toBe(3);
    const persisted = JSON.parse(String(h.callsOf('upsert')[0]!.args[15]));
    expect(persisted).toEqual({ ...metadata, clientMatch: {
      method: 'confirmed_client_intel_mapping', score: 0.77, verifiedAt: now.toISOString(),
    } });
    const audit = h.callsOf('audit')[0]!.args[0] as { data: { after: { value: { metadata: unknown } } } };
    expect(audit.data.after.value.metadata).toEqual(persisted);
  });

  test.each(['fara', 'testimony'])('unconfirmed %s never writes/audits/assigns/accepts', async (sourceType) => {
    const row = finding('advocacy_record', { proposedValue: recordProposal({ sourceType, metadata: {
      registrationNumber: 'registration-one', hearingId: 'hearing-one', witness: 'Witness, Client',
    } }) });
    const h = harness([row], { confirmedKeys: ['different-record'] });
    await expect(h.apply()).rejects.toThrow(
      'Verify this record’s organization-to-client mapping before accepting it as advocacy. A name match alone is insufficient.',
    );
    expect(h.events).toEqual(['1:begin', '1:load', '1:commit', '2:begin', '2:mapping', '2:commit']);
    expect(h.committed).toEqual([]);
    expect(h.matters.assignMatterForRecord).not.toHaveBeenCalled();
    expect(h.service.getRun).not.toHaveBeenCalled();
  });

});

describe('Advocacy record assignment and acceptance transaction boundaries', () => {
  test('human assignment shares the record/audit tx and acceptance follows its commit', async () => {
    const row = finding('advocacy_record', { proposedValue: recordProposal({ activityDate: '2026-01-15' }) });
    const h = harness([row]);
    await expect(h.assign({ matterId })).resolves.toEqual({ findingId: row.id, matterId, alreadyApplied: false });
    expect(h.events).toEqual([
      '1:begin', '1:load', '1:commit', '2:begin', '2:upsert', '2:audit', '2:target', '2:commit',
      '3:begin', '3:accept', '3:commit',
    ]);
    expect(h.matters.assignSpecificMatterForRecord).toHaveBeenCalledWith(
      h.transactions[1]!.tx, ctx, clientId, 'lda:filing-one', { matterId }, '2026-01-15',
    );
    expect(h.callsOf('upsert')[0]!.transaction).toBe(h.callsOf('audit')[0]!.transaction);
    expect(h.callsOf('accept')[0]!.transaction).not.toBe(h.callsOf('target')[0]!.transaction);
    expect(h.matters.assignMatterForRecord).not.toHaveBeenCalled();
  });

  test('human assignment failure rolls back record and audit and blocks acceptance', async () => {
    const error = new Error('target belongs to another client');
    const h = harness([finding()], { targetError: error });
    await expect(h.assign({ matterId })).rejects.toBe(error);
    expect(h.transactions.map((transaction) => transaction.result)).toEqual(['commit', 'rollback']);
    expect(h.committed).toEqual([]);
    expect(h.callsOf('target')[0]!.args[0]).toBe(h.transactions[1]!.tx);
    expect(h.callsOf('accept')).toEqual([]);
    expect(h.warning).not.toHaveBeenCalled();
  });

  test('automatic assignment runs after commit and its sanitized warning still precedes acceptance', async () => {
    const h = harness([finding()], { automaticError: new Error('Authorization: secret, provider offline') });
    await h.apply();
    expect(h.events).toEqual([
      '1:begin', '1:load', '1:commit', '2:begin', '2:upsert', '2:audit', '2:commit',
      'outside:automatic', 'outside:warning', '3:begin', '3:accept', '3:commit', 'outside:run',
    ]);
    expect(h.callsOf('automatic')[0]!.transaction).toBeNull();
    expect(h.warning).toHaveBeenCalledWith(
      `Advocacy matter assignment failed for ${clientId}/lda:filing-one: Authorization=[redacted], provider offline`,
    );
    expect(h.committed.map((call) => call.operation)).toEqual(['upsert', 'audit', 'accept']);
  });

  test('an acceptance failure leaves the earlier record/audit commit and automatic assignment intact', async () => {
    const error = new Error('acceptance unavailable');
    const h = harness([finding()], { acceptanceError: error });
    await expect(h.apply()).rejects.toBe(error);
    expect(h.transactions.map((transaction) => transaction.result)).toEqual(['commit', 'commit', 'rollback']);
    expect(h.committed.map((call) => call.operation)).toEqual(['upsert', 'audit']);
    expect(h.callsOf('automatic')).toHaveLength(1);
    expect(h.service.getRun).not.toHaveBeenCalled();
  });
});

describe('outcome application', () => {
  test.each([0, 2])('advocacy outcome changed-count %s rolls back without audit, lookup, link, or acceptance', async (outcomeChanged) => {
    const h = harness([finding('advocacy_outcome')], { outcomeChanged });
    await expect(h.apply()).rejects.toThrow('Apply the related advocacy record before linking its outcome');
    expect(h.events).toEqual(['1:begin', '1:load', '1:commit', '2:begin', '2:outcome-update', '2:rollback']);
    expect(h.committed).toEqual([]);
  });

  test('advocacy update/audit/Matter lookup share a tx and the existing event is linked after commit', async () => {
    const row = finding('advocacy_outcome');
    const h = harness([row]);
    await h.apply();
    expect(h.events).toEqual([
      '1:begin', '1:load', '1:commit', '2:begin', '2:outcome-update', '2:audit', '2:lookup', '2:commit',
      'outside:link', '3:begin', '3:accept', '3:commit', 'outside:run',
    ]);
    const [sql, ...params] = h.callsOf('outcome-update')[0]!.args;
    expect(sql).toContain("status = 'outcome_observed'");
    expect(sql).toContain("'causationClaimed', false");
    expect(params).toEqual([ctx.tenantId, clientId, 'lda:filing-one', 'funding', JSON.stringify(row.proposedValue)]);
    expect(h.matters.linkToMatter).toHaveBeenCalledWith(ctx, matterId, {
      linkType: 'outcome_event', linkKey: 'event-one', label: 'Observed outcome: funding',
      metadata: { causationClaimed: false, outcomeKind: 'funding' },
    });
    expect(h.callsOf('link')[0]!.transaction).toBeNull();
    expect(h.callsOf('event-create')).toEqual([]);
  });

  test.each(['matter', 'event'])('advocacy outcome skips a Matter link when its %s identifier is absent', async (absent) => {
    const row = finding('advocacy_outcome', { proposedValue: {
      advocacyExternalKey: 'lda:filing-one', outcomeKind: 'funding',
      ...(absent === 'event' ? {} : { outcomeEventId: 'event-one' }),
    } });
    const h = harness([row], { recordMatterId: absent === 'matter' ? null : matterId });
    await h.apply();
    expect(h.matters.linkToMatter).not.toHaveBeenCalled();
    expect(h.callsOf('accept')).toHaveLength(1);
  });

});

describe('Regulatory outcome recording and postcommit links', () => {
  test('regulatory event evidence, notes, observedAt, and audit commit before the new event Matter link', async () => {
    const row = finding('regulatory_outcome', { proposedValue: {
      matterId, documentNumber: ' 2026-00002 ', docketId: ' DOD-2026-1 ', documentType: ' PROPOSED_RULE ',
      agencyNames: ['Department of Defense'], publicationDate: ' 2026-03-01T00:00:00.000Z ',
    } });
    const h = harness([row]);
    await h.apply();
    expect(h.events).toEqual([
      '1:begin', '1:load', '1:commit', '2:begin', '2:event-create', '2:audit', '2:commit',
      'outside:link', '3:begin', '3:accept', '3:commit', 'outside:run',
    ]);
    expect(h.callsOf('event-create')[0]!.args[0]).toEqual({ data: {
      tenantId: ctx.tenantId, clientId, kind: 'regulatory_action_published', sourceType: 'regulatory_document',
      sourceId: '2026-00002', recordedBy: ctx.userId, observedAt: new Date('2026-03-01T00:00:00.000Z'),
      evidence: { docketId: 'DOD-2026-1', documentNumber: '2026-00002', documentType: 'PROPOSED_RULE',
        agencyNames: ['Department of Defense'], publicationDate: '2026-03-01T00:00:00.000Z',
        matchedOn: 'docket_id', causationClaimed: false },
      notes: "Government movement observed on docket DOD-2026-1 after the client's attributable Regulations.gov advocacy — causation not claimed.",
    } });
    expect(h.matters.linkToMatter).toHaveBeenCalledWith(ctx, matterId, {
      linkType: 'outcome_event', linkKey: 'created-event',
      label: 'Observed government movement: PROPOSED_RULE on docket DOD-2026-1',
      metadata: { causationClaimed: false, matchedOn: 'docket_id', relationship: 'strongly_aligned', documentNumber: '2026-00002' },
    });
  });

  test('regulatory missing optional evidence uses null/empty defaults and omits observedAt', async () => {
    const h = harness([finding('regulatory_outcome', { proposedValue: {
      matterId, documentNumber: '2026-00002', docketId: 'DOD-2026-1', agencyNames: 'invalid',
    } })]);
    await h.apply();
    const { data } = h.callsOf('event-create')[0]!.args[0] as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty('observedAt');
    expect(data.evidence).toEqual({ docketId: 'DOD-2026-1', documentNumber: '2026-00002',
      documentType: null, agencyNames: [], publicationDate: null, matchedOn: 'docket_id', causationClaimed: false });
    expect(h.callsOf('link')[0]!.args[2]).toMatchObject({
      label: 'Observed government movement: Federal Register document on docket DOD-2026-1',
    });
  });

  test.each(['advocacy_outcome', 'regulatory_outcome'])('%s link failure warns after commit and still accepts', async (kind) => {
    const h = harness([finding(kind)], { linkError: new Error('Bearer: secret') });
    await h.apply();
    expect(h.callsOf('link')[0]!.transaction).toBeNull();
    expect(h.events.slice(-6)).toEqual([
      'outside:link', 'outside:warning', '3:begin', '3:accept', '3:commit', 'outside:run',
    ]);
    expect(h.warning).toHaveBeenCalledWith(
      `${kind === 'advocacy_outcome' ? 'Advocacy' : 'Regulatory'} matter outcome link failed for ${clientId}/${matterId}: Bearer=[redacted]`,
    );
    expect(h.callsOf('accept')).toHaveLength(1);
  });
});

describe('federal footprint and shared audit', () => {
  test('a missing client rolls back the footprint attempt before audit or acceptance', async () => {
    const h = harness([finding('federal_footprint')], { client: null });
    await expect(h.apply()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.events).toEqual(['1:begin', '1:load', '1:commit', '2:begin', '2:client', '2:rollback']);
    expect(h.committed).toEqual([]);
  });

  test('footprint captures the actual before value and exact actor/source audit in its write tx', async () => {
    const row = finding('federal_footprint');
    const h = harness([row], { client: { id: clientId, intakeData: { federalMarket: { awards: 1 } } } });
    await h.apply();
    expect(h.callsOf('client')[0]!.args[0]).toEqual({
      where: { id: clientId, tenantId: ctx.tenantId }, select: { intakeData: true },
    });
    expect(h.callsOf('footprint')[0]!.args.slice(1)).toEqual([
      clientId, ctx.tenantId, row.id, JSON.stringify(row.proposedValue),
    ]);
    expect(h.callsOf('audit')[0]!.args[0]).toEqual({ data: {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: 'user_admin', action: 'client_profile_fill.apply',
      entityType: 'client_profile_fill:federal_footprint', entityId: clientId,
      before: { findingId: row.id, value: { awards: 1 } },
      after: { findingId: row.id, targetKey: row.targetKey, source: row.source, value: row.proposedValue },
    } });
    expect(h.callsOf('footprint')[0]!.transaction).toBe(h.callsOf('audit')[0]!.transaction);
    const [acceptSql, ...acceptParams] = h.callsOf('accept')[0]!.args;
    expect(acceptParams).toEqual([row.id, ctx.tenantId, clientId, ctx.userId]);
    expect(acceptSql).toContain("AND status = 'pending'");
    expect(acceptSql).toContain('rejection_reason = NULL');
  });

  test('an absent actor role and undefined previous federal value serialize as audit nulls', async () => {
    const h = harness([finding('federal_footprint')]);
    await h.apply(undefined, { ...ctx, role: undefined } as unknown as typeof ctx);
    const { data } = h.callsOf('audit')[0]!.args[0] as { data: Record<string, unknown> };
    expect(data.actorRole).toBeNull();
    expect(data.before).toEqual({ findingId: 'finding-federal_footprint', value: null });
  });

  test.each(['federal_footprint', 'advocacy_record', 'advocacy_outcome', 'regulatory_outcome'])(
    '%s audit failure rolls back the application and skips postcommit effects and acceptance', async (kind) => {
      const error = new Error('audit unavailable');
      const h = harness([finding(kind)], { auditError: error });
      await expect(h.apply()).rejects.toBe(error);
      expect(h.transactions.map((transaction) => transaction.result)).toEqual(['commit', 'rollback']);
      expect(h.committed).toEqual([]);
      expect(h.callsOf('automatic')).toEqual([]);
      expect(h.callsOf('link')).toEqual([]);
      expect(h.callsOf('accept')).toEqual([]);
    },
  );
});
