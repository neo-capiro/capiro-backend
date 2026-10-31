import { SAM_ACTION_CONTRACT, appendSamRecords, awardKey, mapSamAction, parseAwardId, payloadHash, sourceRevisionOrder,
  transactionInput, usd, type AwardCandidate, type ProducerRun, type SamRecord } from './sam-contract-action.js';
import { buildAcquisitionIdentity } from '../../src/program-element/acquisition-continuity/acquisition-identity.js';
import { projectSamActions, reconcileSamActions, selectAwardObservations, type AwardObservation, type ObservedAction, type QualifiedRun } from './sam-action-projection.js';

const RUN: ProducerRun = { contract: SAM_ACTION_CONTRACT, producerCommit: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`, runId: 'fixture-1', targetId: 'offline-fixture' };
const APPROVAL: QualifiedRun = { ...RUN, approvedAt: '2026-10-01T00:00:00Z', revokedAt: null, awardIdentityKeys: [award().identityKey, award('8000').identityKey] };
function award(agency = '9700', piid = '1', parent: string | null = 'PARENT'): AwardCandidate {
  const awardUniqueId = `CONT_AWD_${piid}_${agency}_${parent ?? '-NONE-'}_${parent ? '9700' : '-NONE-'}`;
  return { piid, awardUniqueId, identityKey: awardKey(awardUniqueId)! };
}
function record(agency = '9700', piid: string | number = '1', parent: string | null = 'PARENT'): SamRecord {
  return { contractId: { subtier: { code: agency }, piid, modificationNumber: 0, transactionNumber: 0,
    ...(parent ? { referencedIDVPiid: parent, referencedIDVSubtier: { code: '9700' } } : {}) },
  coreData: { awardOrIDV: 'AWARD', awardOrIDVType: { code: parent ? 'C' : 'D' } },
  awardDetails: { dollars: { actionObligation: '-100.00' }, dates: { dateSigned: '2026-09-01 00:00:00' },
    transactionData: { lastModifiedDate: '2026-09-02 10:00:00', version: '1.0' } } };
}
function mapped(source = record(), candidates = [award()]) {
  const result = mapSamAction(source, candidates);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
function observed(id: string, source = record(), time = '2026-10-02T00:00:00Z', candidates = [award()]): ObservedAction {
  const input = transactionInput(source, mapped(source, candidates), RUN, time);
  const identity = buildAcquisitionIdentity({ source: input.source, recordKind: 'modification', transactionId: input.sourceTransactionId });
  if (!identity.ok) throw new Error(identity.reason);
  return { ...input, id, sourceSystem: input.source, transactionIdentityKey: identity.identity.key,
    recordedAt: time, supersedesId: null, correctsIdentityKey: null };
}
function project(rows: ObservedAction[], overrides: Partial<Parameters<typeof projectSamActions>[0]> = {}) {
  return projectSamActions({ rows, awards: [award()], qualifiedRuns: [APPROVAL], targetId: RUN.targetId,
    knownAt: '2026-10-31T00:00:00Z', ...overrides });
}

describe('SAM full award and action authority', () => {
  test('F3 rejected identities cause zero store calls and count each outcome', async () => {
    const append = jest.fn(async () => ({ inserted: true }));
    const summary = { mapped: 0, rejected: {}, transactionsInserted: 0, transactionsExisting: 0 };
    const missing = record(); delete missing.contractId!.transactionNumber;
    await appendSamRecords([record(), missing], [], RUN, summary, append);
    expect(append).not.toHaveBeenCalled();
    expect(summary).toEqual({ mapped: 0, rejected: { no_award_match: 1, missing_action_identity: 1 }, transactionsInserted: 0, transactionsExisting: 0 });
    await appendSamRecords([record()], [award()], RUN, summary, append, () => '2026-10-02T00:00:00Z');
    expect(append).toHaveBeenCalledTimes(1); expect(summary.transactionsInserted).toBe(1);
  });
  test('F1 shared PIID and parent, different source agencies resolve independently in either row order', () => {
    const awards = [award('9700'), award('8000')];
    const a = mapped(record('9700'), awards), b = mapped(record('8000'), [...awards].reverse());
    expect(a.awardIdentityKey).not.toBe(b.awardIdentityKey);
    expect(a.sourceTransactionId).not.toBe(b.sourceTransactionId);
    expect(mapped(record('9700'), [...awards].reverse())).toEqual(a);
  });
  test('F2 zero, multiple canonical mappings, mismatched parent and malformed catalog fail closed', () => {
    expect(mapSamAction(record(), [])).toEqual({ ok: false, reason: 'no_award_match' });
    expect(mapSamAction(record(), [award(), { ...award(), identityKey: 'wrong' }])).toEqual({ ok: false, reason: 'multiple_award_matches' });
    expect(mapSamAction(record(), [award('9700', '1', 'OTHER')])).toEqual({ ok: false, reason: 'no_award_match' });
    expect(mapSamAction(record(), [{ ...award(), identityKey: 'wrong' }])).toEqual({ ok: false, reason: 'invalid_catalog_identity' });
    expect(mapped(record(), [award(), award()])).toEqual(mapped()); // repeated award revisions are one identity
  });
  test('F3 direct awards remain valid, but orders require both parent dimensions', () => {
    expect(mapped(record('9700', '1', null), [award('9700', '1', null)]).piid).toBe('1');
    const missing = record(); delete missing.contractId!.referencedIDVSubtier;
    expect(mapSamAction(missing, [award()])).toEqual({ ok: false, reason: 'incomplete_parent' });
    delete missing.contractId!.referencedIDVPiid;
    expect(mapSamAction(missing, [award()])).toEqual({ ok: false, reason: 'incomplete_parent' });
  });
  test('numeric/short PIIDs and transaction/modification zero survive normalization', () => {
    expect(mapped(record('9700', 1))).toMatchObject({ piid: '1', transactionNumber: '0', modificationNumber: '0' });
    expect(mapped(record('9700', 'A'), [award('9700', 'A')]).piid).toBe('A');
  });
  test('missing components never fall back to mutable fields or sentinel literals', () => {
    for (const key of ['transactionNumber', 'modificationNumber'] as const) {
      const source = record(); delete source.contractId![key];
      expect(mapSamAction(source, [award()])).toEqual({ ok: false, reason: 'missing_action_identity' });
    }
    const source = record(); source.contractId!.referencedIDVPiid = '-NONE-';
    expect(mapSamAction(source, [award()]).ok).toBe(false);
    expect(parseAwardId('CONT_AWD_A_B_9700_-NONE-_-NONE-')).toBeNull();
  });
  test('component boundaries cannot collide across delimiters or missing-looking text', () => {
    const a = record(), b = record();
    a.contractId!.modificationNumber = 'a.b'; a.contractId!.transactionNumber = 'c|%[]å';
    b.contractId!.modificationNumber = 'a'; b.contractId!.transactionNumber = 'b.c|%[]å';
    expect(mapped(a).sourceTransactionId).not.toBe(mapped(b).sourceTransactionId);
    expect(JSON.parse(mapped(a).sourceTransactionId).slice(-2)).toEqual(['a.b', 'c|%[]å']);
  });
  test('source identity amendments and IDVs require a separate contract', () => {
    expect(mapSamAction({ ...record(), oldContractId: [{}] }, [award()])).toEqual({ ok: false, reason: 'source_identity_change' });
    const source = record(); source.coreData!.awardOrIDV = 'IDV';
    expect(mapSamAction(source, [award()])).toEqual({ ok: false, reason: 'unsupported_record_kind' });
  });
  test('source amounts are exact signed decimal strings; unknown is not zero', () => {
    expect(usd('-999999999999999999.99')).toBe('-999999999999999999.99');
    expect(usd(-0)).toBe('0.00'); expect(usd(null)).toBeNull(); expect(usd('1.001')).toBeNull();
    expect(usd(1e17)).toBeNull(); expect(usd('1e3')).toBeNull();
    const source = record(); source.awardDetails!.dollars!.actionObligation = null;
    expect(mapSamAction(source, [award()])).toEqual({ ok: false, reason: 'invalid_obligation' });
  });
  test('source wall-clock parsing validates dates and does not assume an unspecified timezone', () => {
    expect(sourceRevisionOrder('2026-09-02 10:00:00')).toBe('2026-09-02T10:00:00.000000');
    for (const bad of ['2026-02-30 00:00:00', '2026-10-01 25:00:00', '2026-10-01T00:00:00Z', 'yesterday']) expect(sourceRevisionOrder(bad)).toBeNull();
  });
  test('raw payload/source identifiers retained without mutating the input', () => {
    const source = record(), before = JSON.stringify(source);
    const input = transactionInput(source, mapped(source), RUN, '2026-10-02T00:00:00Z');
    expect(input.raw.sourcePayload).toEqual(source); expect(JSON.stringify(source)).toBe(before);
    expect(input.raw.acquisitionProvenance.sourcePayloadHash).toBe(payloadHash(source));
    expect(() => transactionInput(source, mapped(source), { ...RUN, runId: '' }, '2026-10-02T00:00:00Z')).toThrow();
  });
});

describe('qualified current/as-of action projection', () => {
  test('award observations preserve full-key cardinality and select a deterministic known-at snapshot', () => {
    const make = (id: string, agency: string, recordedAt: string, name: string): AwardObservation => ({
      id, sourceRecordId: award(agency).awardUniqueId, identityKey: award(agency).identityKey,
      sourceSystem: 'usaspending', recordKind: 'award', recordedAt,
      raw: { generated_internal_id: award(agency).awardUniqueId, 'Award ID': '1', 'Recipient Name': name },
    });
    const rows = [make('a', '9700', '2026-10-01T00:00:00Z', 'A'), make('b', '8000', '2026-10-01T00:00:00Z', 'B'),
      make('c', '9700', '2026-10-03T00:00:00Z', 'C')];
    const before = selectAwardObservations(rows, '2026-10-02T00:00:00Z');
    expect(before.selected).toHaveLength(2); expect(before.selected.map((row) => row.contractorName).sort()).toEqual(['A', 'B']);
    expect(selectAwardObservations([...rows].reverse(), '2026-10-04T00:00:00Z').selected.map((row) => row.contractorName).sort()).toEqual(['B', 'C']);
    const fork = selectAwardObservations([...rows, make('d', '9700', '2026-10-03T00:00:00Z', 'D')], '2026-10-04T00:00:00Z');
    expect(fork.selected).toHaveLength(1); expect(fork.excluded.some((row) => row.reason === 'award_observation_fork')).toBe(true);
    expect(before.selected[0]!.awardingAgency).toBeNull();
  });
  test('F4 repeated observation adds physical history but only one signed logical action', () => {
    const a = observed('a'), b = observed('b', record(), '2026-10-03T00:00:00Z'); b.supersedesId = a.id;
    expect(a.transactionIdentityKey).toBe(b.transactionIdentityKey);
    expect(a.sourceObservedAt).not.toBe(b.sourceObservedAt);
    const result = project([b, a]);
    expect(result.map((r) => r.category)).toEqual(['repeated_observation', 'selected']);
    const sums = reconcileSamActions(result);
    expect(sums.get('raw')!.obligationUsd).toBe('-200.00');
    expect(sums.get('selected')!.obligationUsd).toBe('-100.00'); // logical <= raw would be false
    expect(sums.get('repeated_observation')!.obligationUsd).toBe('-100.00');
  });
  test('same action corrected amount/date selects source revision, including late arrival of the prior version', () => {
    const correction = record(); correction.awardDetails!.dollars!.actionObligation = '80.00';
    correction.awardDetails!.dates!.dateSigned = '2026-09-03';
    correction.awardDetails!.transactionData!.lastModifiedDate = '2026-09-04 10:00:00';
    const newer = observed('new', correction), lateOld = observed('old', record(), '2026-10-03T00:00:00Z');
    lateOld.supersedesId = newer.id;
    expect(newer.transactionIdentityKey).toBe(lateOld.transactionIdentityKey);
    const result = project([lateOld, newer]);
    expect(result.map((r) => r.category)).toEqual(['prior_source_revision', 'selected']);
    expect(reconcileSamActions(result).get('selected')!.obligationUsd).toBe('80.00');
  });
  test('distinct source transactions sharing every amount/date/modification are not collapsed', () => {
    const other = record(); other.contractId!.transactionNumber = 1;
    expect(project([observed('a'), observed('b', other)]).map((r) => r.category)).toEqual(['selected', 'selected']);
  });
  test('equal source timestamps with differing payloads exclude the whole action, independent of row order', () => {
    const conflict = record(); conflict.awardDetails!.dollars!.actionObligation = '80';
    const rows = [observed('a'), observed('b', conflict, '2026-10-03T00:00:00Z')];
    expect(project(rows).map((r) => r.category)).toEqual(['source_revision_fork', 'source_revision_fork']);
    expect(project([...rows].reverse()).every((r) => r.category === 'source_revision_fork')).toBe(true);
  });
  test('knownAt excludes later knowledge; source cutoff excludes later source revisions', () => {
    const source = record(); source.awardDetails!.transactionData!.lastModifiedDate = '2026-09-04 10:00:00';
    const rows = [observed('a'), observed('b', source, '2026-10-04T00:00:00Z')];
    expect(project(rows, { knownAt: '2026-10-03T00:00:00Z' }).map((r) => r.row.id)).toEqual(['a']);
    expect(project(rows, { sourceThrough: '2026-09-03T00:00:00.000000' }).map((r) => r.category)).toEqual(['selected', 'source_after_cutoff']);
  });
  test('no cross-award supersedes or claimed source correction is accepted', () => {
    const a = observed('a'), b = observed('b', record('8000'), '2026-10-03T00:00:00Z', [award('8000')]);
    b.supersedesId = a.id;
    expect(project([a, b], { awards: [award(), award('8000')] })[1]!.category).toBe('invalid_chain');
    a.correctsIdentityKey = 'arbitrary-action'; expect(project([a])[0]!.category).toBe('invalid_chain');
  });
  test('legacy and unqualified claims never join the corrected total; signed outlay remains its own measure', () => {
    const legacy = { ...observed('legacy'), raw: record(), signedOutlayDelta: '-20.00' };
    const result = project([legacy, observed('corrected')]);
    expect(result.map((r) => r.category)).toEqual(['legacy', 'selected']);
    const sums = reconcileSamActions(result);
    expect(sums.get('legacy')!.outlayUsd).toBe('-20.00'); expect(sums.get('selected')!.outlayUsd).toBeNull();
    expect(sums.get('raw')!.outlayKnown).toBe(1);
    expect(project([observed('a')], { qualifiedRuns: [] })[0]!.category).toBe('unqualified_run');
  });
  test('tuple mismatch, revocation, duplicate approvals and future approval fail qualification', () => {
    for (const qualifiedRuns of [[{ ...APPROVAL, imageDigest: `sha256:${'c'.repeat(64)}` }],
      [{ ...APPROVAL, revokedAt: '2026-11-01T00:00:00Z' }], [APPROVAL, APPROVAL],
      [{ ...APPROVAL, approvedAt: '2026-11-01T00:00:00Z' }], [{ ...APPROVAL, awardIdentityKeys: [] }]]) {
      expect(project([observed('a')], { qualifiedRuns })[0]!.category).toBe('unqualified_run');
    }
    expect(project([observed('a')], { targetId: 'another-target' })[0]!.category).toBe('unqualified_run');
  });
  test('tampered derived fields and payload evidence fail closed', () => {
    const row = observed('a'); row.signedObligationDelta = '900.00';
    expect(project([row])[0]!.category).toBe('invalid_provenance');
    expect(project([observed('a')], { awards: [] })[0]!.category).toBe('no_award_match');
  });
  test('empty and null measures remain unknown, not measured zero', () => {
    expect(reconcileSamActions([]).get('raw')).toEqual({ rows: 0, obligationUsd: null, outlayUsd: null, obligationKnown: 0, outlayKnown: 0 });
  });
  test('signed conservation separates old source revisions, actual repeats, selected actions and legacy', () => {
    const correction = record(); correction.awardDetails!.dollars!.actionObligation = '80';
    correction.awardDetails!.transactionData!.lastModifiedDate = '2026-09-04 10:00:00';
    const legacy = { ...observed('legacy'), raw: record(), signedObligationDelta: '-20.00', signedOutlayDelta: '-5.00' };
    const sums = reconcileSamActions(project([observed('old'), observed('current', correction),
      observed('repeat', correction, '2026-10-03T00:00:00Z'), legacy]));
    expect(sums.get('raw')).toMatchObject({ rows: 4, obligationUsd: '40.00', outlayUsd: '-5.00', obligationKnown: 4, outlayKnown: 1 });
    expect(sums.get('selected')!.obligationUsd).toBe('80.00');
    expect(sums.get('prior_source_revision')!.obligationUsd).toBe('-100.00');
    expect(sums.get('repeated_observation')!.obligationUsd).toBe('80.00');
    expect(sums.get('legacy')!.obligationUsd).toBe('-20.00');
  });
});
