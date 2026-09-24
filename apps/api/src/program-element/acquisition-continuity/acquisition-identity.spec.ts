import {
  buildAcquisitionIdentity,
  buildAcquisitionRelationship,
} from './acquisition-identity.js';

describe('buildAcquisitionIdentity', () => {
  test('uses USAspending generated award ID as the primary award identity', () => {
    const result = buildAcquisitionIdentity({
      source: 'usaspending',
      recordKind: 'award',
      generatedAwardId: 'CONT_AWD_001',
      piid: 'FA-123',
    });
    expect(result).toMatchObject({
      ok: true,
      identity: { authority: 'usaspending_generated_award_id', key: 'usaspending|award|CONT_AWD_001' },
    });
  });

  test('rejects PIID-only identity', () => {
    expect(buildAcquisitionIdentity({ source: 'fpds', recordKind: 'award', piid: 'FA-123' })).toEqual({
      ok: false,
      reason: 'PIID alone is not an authoritative acquisition identity',
    });
  });

  test('forms parent + PIID identity for an order and retains its parent link', () => {
    const result = buildAcquisitionIdentity({
      source: 'fpds', recordKind: 'order', parentAwardId: 'IDIQ-42', piid: 'ORDER-9',
      parentIdentityKey: 'fpds|award|IDIQ-42',
    });
    expect(result).toMatchObject({
      ok: true,
      identity: {
        authority: 'parent_award_and_piid',
        key: 'fpds|order|IDIQ-42|ORDER-9',
        parentIdentityKey: 'fpds|award|IDIQ-42',
      },
    });
  });

  test('models a modification as a child of an order in the award chain', () => {
    const order = buildAcquisitionIdentity({
      source: 'fpds', recordKind: 'order', parentAwardId: 'IDIQ-42', piid: 'ORDER-9',
      parentIdentityKey: 'fpds|award|IDIQ-42',
    });
    expect(order.ok).toBe(true);
    if (!order.ok) return;
    const modification = buildAcquisitionIdentity({
      source: 'fpds', recordKind: 'modification', parentAwardId: 'IDIQ-42', piid: 'ORDER-9',
      modificationNumber: 'P0003', parentIdentityKey: order.identity.key,
    });
    expect(modification).toMatchObject({
      ok: true,
      identity: {
        authority: 'parent_piid_modification',
        key: 'fpds|modification|IDIQ-42|ORDER-9|P0003',
        parentIdentityKey: order.identity.key,
      },
    });
  });

  test('uses stable transaction identity for a corrected action observation', () => {
    const first = buildAcquisitionIdentity({
      source: 'usaspending', recordKind: 'modification', transactionId: 'TX-77', modificationNumber: 'P0002',
    });
    const correctedObservation = buildAcquisitionIdentity({
      source: 'usaspending', recordKind: 'modification', transactionId: 'TX-77', modificationNumber: 'P0002',
    });
    expect(first).toMatchObject({ ok: true, identity: { authority: 'source_transaction_id' } });
    expect(correctedObservation).toEqual(first);
  });

  test('keeps acquisition record kinds distinct even when provider IDs match', () => {
    const notice = buildAcquisitionIdentity({ source: 'sam', recordKind: 'notice', noticeId: 'N1' });
    const solicitation = buildAcquisitionIdentity({ source: 'sam', recordKind: 'solicitation', solicitationId: 'N1' });
    expect(notice.ok && solicitation.ok && notice.identity.key).not.toEqual(
      notice.ok && solicitation.ok && solicitation.identity.key,
    );
  });
});

describe('buildAcquisitionRelationship', () => {
  test('keeps an unsupported join unresolved with reason, freshness, and coverage', () => {
    const result = buildAcquisitionRelationship({
      source: 'usaspending', sourceRecordId: 'award-1', fromIdentityKey: 'pe-1', toIdentityKey: 'award-1',
      relationshipClass: 'unresolved', unresolvedReason: 'No source-stated award-to-PE allocation was found.',
      sourceFreshness: { observedAt: '2026-09-24T12:00:00Z', sourceAsOf: null },
      coverage: { state: 'partial', note: 'File C is incomplete for this award family.' },
    });
    expect(result).toMatchObject({ ok: true, relationship: { relationshipClass: 'unresolved', allocatedAmountUsd: null } });
  });

  test('refuses dollars on reviewed associations and inferred relevance', () => {
    for (const relationshipClass of ['reviewed_association', 'inferred_relevance', 'unresolved'] as const) {
      const result = buildAcquisitionRelationship({
        source: 'source', sourceRecordId: 'r1', fromIdentityKey: 'p1', toIdentityKey: 'a1',
        relationshipClass, allocatedAmountUsd: '10.00',
        ...(relationshipClass === 'unresolved' ? {
          unresolvedReason: 'unknown', sourceFreshness: { observedAt: null, sourceAsOf: null },
          coverage: { state: 'unknown', note: 'unknown' },
        } : {}),
      });
      expect(result.ok).toBe(false);
    }
  });
});
