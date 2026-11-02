import {
  awardEnrichmentFileArgument, enrichAwardCohort, parseAwardEnrichmentFile, validateAwardEnrichmentIds,
  type AwardEnrichmentPorts, type AwardEnrichmentSnapshot, type AwardEnrichmentHead,
} from './procurement-award-enrichment.js';
import { awardKey, payloadHash } from './sam-contract-action.js';

const ID = 'CONT_AWD_0001_9700_-NONE-_-NONE-';
const OTHER = 'CONT_AWD_0001_1700_-NONE-_-NONE-';
const CLOCK = '2026-10-31T12:30:45.123000Z';
function snapshot(id = ID): AwardEnrichmentSnapshot {
  return { awardUniqueId: id, piid: '0001', sourceObservedAt: CLOCK, sourceRecord: {
    generated_internal_id: id, 'Award ID': '0001', 'Recipient Name': 'SYNTHETIC VENDOR',
    'Recipient UEI': 'SYNTHETIC001', 'Awarding Agency': 'Synthetic Agency', 'Awarding Sub Agency': null,
    Description: 'Synthetic contract snapshot', 'Award Amount': '90000000000000.01',
  } };
}
function harness(rows = [snapshot()], heads: AwardEnrichmentHead[] = []) {
  const readAwards = jest.fn(async () => rows), readHeads = jest.fn(async () => heads);
  const appendRecord = jest.fn(async (input) => ({ id: `synthetic-${input.sourceRecordId}`, inserted: true,
    identityKey: awardKey(input.sourceRecordId)! }));
  return { readAwards, readHeads, appendRecord } satisfies AwardEnrichmentPorts;
}
const commit = (awardIds = [ID]) => ({ awardIds, commit: true, env: { PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'true' } });

describe('finite procurement catalog enrichment', () => {
  test('keeps full award dimensions and leading-zero numeric PIIDs separate', async () => {
    const h = harness([snapshot(OTHER), snapshot()]);
    const result = await enrichAwardCohort(h, commit([ID, OTHER]));
    expect(result).toMatchObject({ status: 'COMPLETED', requested: 2, inserted: 2, coverage: 'finite_catalog_observations_only' });
    expect(result.outcomes.map((row) => row.awardIdentityKey)).toEqual([awardKey(ID), awardKey(OTHER)]);
    expect(h.appendRecord.mock.calls.map(([row]) => row.raw.generated_internal_id)).toEqual([ID, OTHER]);
    expect(h.appendRecord.mock.calls[0]![0]).toMatchObject({ source: 'usaspending', recordKind: 'award', sourceRecordId: ID,
      sourceObservedAt: CLOCK, raw: snapshot().sourceRecord });
    expect(result.outcomes[0]).toMatchObject({ recipientIdentity: 'source_reported_uei', sourcePayloadSha256: payloadHash(snapshot().sourceRecord) });
    expect(result).not.toHaveProperty('totalObligation');
  });

  test.each([[], Array.from({ length: 26 }, (_, i) => `CONT_AWD_${i}_9700_-NONE-_-NONE-`), [ID, ID],
    ['0001'], ['CONT_AWD_ 1_9700_-NONE-_-NONE-'], ['CONT_AWD_1_9700_PARENT_-NONE-']].map((awardIds) => ({ awardIds })))('refuses malformed or oversized input before reads: %j', async ({ awardIds }) => {
    const h = harness();
    await expect(enrichAwardCohort(h, commit(awardIds))).rejects.toThrow(/distinct exact canonical/);
    expect(h.readAwards).not.toHaveBeenCalled(); expect(h.readHeads).not.toHaveBeenCalled(); expect(h.appendRecord).not.toHaveBeenCalled();
  });

  test.each([
    { commit: false, env: { PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'true' } },
    { commit: true, env: { PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'TRUE' } },
    { commit: true, env: {} },
  ])('requires both write keys: %j', async (options) => {
    const h = harness(); const receipt = await enrichAwardCohort(h, { awardIds: [ID], ...options });
    expect(receipt).toMatchObject({ mode: 'DRY_RUN', status: 'VALIDATED', inserted: 0 });
    expect(h.appendRecord).not.toHaveBeenCalled();
  });

  test.each([
    { sourceRecord: null, reason: 'missing_source_snapshot' },
    { sourceRecord: { generatedInternalId: ID, piid: '0001' }, reason: 'source_identity_mismatch' },
    { sourceRecord: { ...(snapshot().sourceRecord as object), generated_internal_id: OTHER }, reason: 'source_identity_mismatch' },
    { sourceRecord: { ...(snapshot().sourceRecord as object), 'Award ID': '1' }, reason: 'source_identity_mismatch' },
    { sourceRecord: { ...(snapshot().sourceRecord as object), 'Recipient UEI': 'synthetic001' }, reason: 'invalid_recipient_uei' },
    { sourceRecord: { ...(snapshot().sourceRecord as object), 'Recipient UEI': 123 }, reason: 'invalid_recipient_uei' },
    { sourceRecord: { ...(snapshot().sourceRecord as object), 'Recipient Name': {} }, reason: 'invalid_attribute' },
  ])('refuses source defect across whole cohort before first write: $reason', async ({ sourceRecord, reason }) => {
    const h = harness([snapshot(OTHER), { ...snapshot(), sourceRecord }]);
    const receipt = await enrichAwardCohort(h, commit([OTHER, ID]));
    expect(receipt.status).toBe('REFUSED'); expect(receipt.outcomes[1]).toMatchObject({ state: 'refused', reason });
    expect(h.appendRecord).not.toHaveBeenCalled();
  });

  test('missing UEI stays unresolved and never resolves from a legal name', async () => {
    const row = snapshot(); (row.sourceRecord as Record<string, unknown>)['Recipient UEI'] = null;
    const h = harness([row]); const receipt = await enrichAwardCohort(h, commit());
    expect(receipt.outcomes[0]).toMatchObject({ recipientIdentity: 'unresolved', state: 'inserted' });
    expect(h.appendRecord.mock.calls[0]![0].raw['Recipient UEI']).toBeNull();
  });

  test('a missing catalog award refuses; source scope cannot add an unrequested award', async () => {
    const h = harness([]); const receipt = await enrichAwardCohort(h, commit());
    expect(receipt.outcomes).toEqual([{ awardIdentityKey: awardKey(ID), state: 'refused', reason: 'missing_source_award' }]);
    expect(h.appendRecord).not.toHaveBeenCalled();
    await expect(enrichAwardCohort(harness([snapshot(OTHER)]), commit())).rejects.toThrow(/source scope mismatch/);
  });

  test.each([
    { clock: null, expected: 'existing_source_clock_unknown' },
    { clock: '2026-10-31T12:30:45.123001Z', expected: 'stale_source_snapshot' },
  ])('compares exact source clock without rounding: $expected', async ({ clock, expected }) => {
    const h = harness([snapshot()], [{ identityKey: awardKey(ID)!, sourceRecord: snapshot().sourceRecord,
      sourceObservedAt: clock, recordedAt: CLOCK }]);
    const receipt = await enrichAwardCohort(h, commit());
    expect(receipt.outcomes[0]).toMatchObject({ state: 'refused', reason: expected }); expect(h.appendRecord).not.toHaveBeenCalled();
  });

  test('refuses a sub-millisecond source snapshot instead of allowing existing store to round it', async () => {
    const h = harness([{ ...snapshot(), sourceObservedAt: '2026-10-31T12:30:45.123001Z' }]);
    const receipt = await enrichAwardCohort(h, commit());
    expect(receipt.outcomes[0]).toMatchObject({ reason: 'unsupported_source_clock_precision' }); expect(h.appendRecord).not.toHaveBeenCalled();
  });

  test('same-clock contradictory raw snapshots and equal-recorded-time forks remain refused', async () => {
    const raw = { ...(snapshot().sourceRecord as object), 'Recipient UEI': 'SYNTHETIC002' };
    const head = { identityKey: awardKey(ID)!, sourceRecord: raw, sourceObservedAt: CLOCK, recordedAt: CLOCK };
    expect((await enrichAwardCohort(harness([snapshot()], [head]), commit())).outcomes[0]).toMatchObject({ reason: 'conflicting_source_snapshot' });
    const fork = harness([snapshot()], [head, { ...head, sourceRecord: snapshot().sourceRecord }]);
    expect((await enrichAwardCohort(fork, commit())).outcomes[0]).toMatchObject({ reason: 'existing_catalog_fork' });
    expect(fork.appendRecord).not.toHaveBeenCalled();
  });

  test('an append acknowledgement failure stops with unknown outcome and never retries', async () => {
    const h = harness([snapshot(), snapshot(OTHER)]); h.appendRecord.mockRejectedValueOnce(new Error('private driver error'));
    const receipt = await enrichAwardCohort(h, commit([ID, OTHER]));
    expect(receipt).toMatchObject({ status: 'WRITE_OUTCOME_UNRESOLVED', inserted: 0, existing: 0 });
    expect(receipt.outcomes.map((row) => row.state)).toEqual(['write_outcome_unresolved', 'validated']);
    expect(h.appendRecord).toHaveBeenCalledTimes(1); expect(JSON.stringify(receipt)).not.toContain('private driver error');
  });

  test('missing read rights prevents all writes and is not turned into an empty cohort', async () => {
    const h = harness(); h.readHeads.mockRejectedValue(new Error('permission denied'));
    await expect(enrichAwardCohort(h, commit())).rejects.toThrow('permission denied'); expect(h.appendRecord).not.toHaveBeenCalled();
  });

  test('bounded file format rejects ambiguous modes and cannot silently deduplicate', () => {
    expect(parseAwardEnrichmentFile(JSON.stringify([ID]))).toEqual([ID]);
    expect(() => parseAwardEnrichmentFile(' '.repeat(16385))).toThrow(/exceeds/);
    expect(() => parseAwardEnrichmentFile(ID)).toThrow(/JSON array/);
    expect(() => validateAwardEnrichmentIds([ID, ID])).toThrow(/distinct/);
    expect(awardEnrichmentFileArgument(['--award-ids-file', 'scope.json', '--commit'])).toBe('scope.json');
    expect(awardEnrichmentFileArgument(['--cap', '1'])).toBeNull();
    expect(() => awardEnrichmentFileArgument(['--award-ids-file', 'scope.json', '--cap', '1'])).toThrow(/only/);
    expect(() => awardEnrichmentFileArgument(['--award-ids-file'])).toThrow(/only/);
  });
});
