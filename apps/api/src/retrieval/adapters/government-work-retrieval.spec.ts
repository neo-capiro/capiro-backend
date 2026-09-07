import { ActionRecommendationsRetrievalAdapter } from './action-recommendations-retrieval.adapter.js';
import { HearingsRetrievalAdapter } from './hearings-retrieval.adapter.js';
import { SemanticDataCatalogService } from '../data-catalog/semantic-data-catalog.service.js';
import type { RetrievalDomain, RetrievalRequest } from '../retrieval-v2.types.js';

jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const CLIENT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const catalog = new SemanticDataCatalogService();
const request = (domain: RetrievalDomain): RetrievalRequest => ({
  queryClass: 'lookup', requestedDomains: [domain],
  caller: { tenantId: TENANT, userId: USER, clientIds: [CLIENT], authorizedClientIds: [CLIENT] },
  pageSize: 1,
});
function harness() {
  const tx = {
    client: { findMany: jest.fn().mockResolvedValue([{ id: CLIENT }]) },
    actionRecommendation: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const prisma = { withTenantUser: jest.fn().mockImplementation((_tenant, _user, fn) => fn(tx)) };
  return { tx, prisma };
}

describe('Action recommendation retrieval', () => {
  it('returns source evidence and deadline/status, with a usable cursor instead of dropping later cards', async () => {
    const { tx, prisma } = harness();
    const first = { id: CLIENT, clientId: CLIENT, issueTitle: 'Committee mark changed', evidence: [{ sourceUrl: 'https://example.gov/mark' }],
      deadline: new Date('2026-09-20'), status: 'new', recommendedAction: 'Request a staff briefing', updatedAt: new Date('2026-09-06'), createdAt: new Date('2026-09-05') };
    tx.actionRecommendation.findMany.mockResolvedValue([first, { ...first, id: TENANT }]);
    const result = await new ActionRecommendationsRetrievalAdapter(prisma as never).retrieve(catalog.get('action_recommendations'), request('action_recommendations'));
    expect(result).toMatchObject({ sourceStatus: 'healthy', returned: 1, hasMore: true, nextCursor: CLIENT, coverageComplete: false });
    expect(result.records[0]!.payload).toMatchObject({ recommendedAction: first.recommendedAction, evidence: first.evidence, status: 'new', deadline: '2026-09-20T00:00:00.000Z' });
    expect(tx.actionRecommendation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT, clientId: { in: [CLIENT] } }, orderBy: { id: 'asc' }, take: 2 }));
    expect(prisma.withTenantUser).toHaveBeenCalledWith(TENANT, USER, expect.any(Function));
  });

  it('applies a half-open update window and stable cursor at the data source', async () => {
    const { tx, prisma } = harness();
    tx.actionRecommendation.findMany.mockResolvedValue([]);
    const input = { ...request('action_recommendations'), queryClass: 'change_detection' as const, windowStart: new Date('2026-09-01'), windowEnd: new Date('2026-09-06') };
    const result = await new ActionRecommendationsRetrievalAdapter(prisma as never).retrieve(catalog.get('action_recommendations'), input, CLIENT);
    expect(tx.actionRecommendation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { gt: CLIENT }, updatedAt: { gte: input.windowStart, lt: input.windowEnd } }) }));
    expect(result).toMatchObject({ coverageComplete: true, paginationComplete: true, returned: 0 });
    expect(result.lastSyncAt).toBeUndefined(); // an update time is not a source sync timestamp
  });

  it.each(['forged-envelope', 'revoked-wall'] as const)('denies %s before card retrieval', async (scenario) => {
    const { tx, prisma } = harness();
    const input = request('action_recommendations');
    if (scenario === 'forged-envelope') input.caller.authorizedClientIds = [];
    else tx.client.findMany.mockResolvedValue([]);
    const result = await new ActionRecommendationsRetrievalAdapter(prisma as never).retrieve(catalog.get('action_recommendations'), input);
    expect(result.sourceStatus).toBe('unauthorized');
    expect(tx.actionRecommendation.findMany).not.toHaveBeenCalled();
  });

  it('checks current client tenant, archive status, and user grant even with a valid envelope', async () => {
    const { tx, prisma } = harness();
    tx.actionRecommendation.findMany.mockResolvedValue([]);
    await new ActionRecommendationsRetrievalAdapter(prisma as never).retrieve(catalog.get('action_recommendations'), request('action_recommendations'));
    expect(tx.client.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      tenantId: TENANT, id: { in: [CLIENT] },
      OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: USER } } }],
    } }));
  });

  it('rejects historical snapshots and malformed cursors without a source read', async () => {
    const { prisma } = harness();
    const adapter = new ActionRecommendationsRetrievalAdapter(prisma as never);
    expect((await adapter.retrieve(catalog.get('action_recommendations'), { ...request('action_recommendations'), asOf: new Date() })).stopReason).toBe('historical_snapshot_not_supported');
    expect((await adapter.retrieve(catalog.get('action_recommendations'), request('action_recommendations'), 'bad')).stopReason).toBe('invalid_cursor');
    expect(prisma.withTenantUser).not.toHaveBeenCalled();
  });

  it('excludes authorized archived clients without blocking active-client cards', async () => {
    const { tx, prisma } = harness();
    const input = request('action_recommendations');
    input.caller.clientIds = undefined;
    input.caller.authorizedClientIds = [CLIENT, TENANT];
    tx.client.findMany.mockResolvedValue([{ id: CLIENT, status: 'active' }, { id: TENANT, status: 'archived' }]);
    tx.actionRecommendation.findMany.mockResolvedValue([]);
    const result = await new ActionRecommendationsRetrievalAdapter(prisma as never).retrieve(catalog.get('action_recommendations'), input);
    expect(tx.actionRecommendation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ clientId: { in: [CLIENT] } }) }));
    expect(result).toMatchObject({ sourceStatus: 'degraded', requestedEntityCount: 2, searchedEntityCount: 1, coverageComplete: false, stopReason: 'archived_client_subjects_excluded' });
  });
});

describe('Hearing source retrieval', () => {
  it('continues unscoped public hearing search when an authorized client is archived', async () => {
    const { tx, prisma } = harness();
    const input = request('hearings');
    input.caller.clientIds = undefined;
    tx.client.findMany.mockResolvedValue([{ id: CLIENT, status: 'archived' }]);
    tx.$queryRaw.mockResolvedValue([]);
    const result = await new HearingsRetrievalAdapter(prisma as never).retrieve(catalog.get('hearings'), input);
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(result.sourceStatus).toBe('degraded');
  });

  it('returns actual transcript text, source IDs and timestamps with honest partial coverage', async () => {
    const { tx, prisma } = harness();
    tx.$queryRaw.mockResolvedValue([{ key: 'segment:one', sourceTable: 'public_hearing_transcript_segment', sourceId: 'one', hearingId: 'hearing', occurredAt: null, updatedAt: new Date('2026-09-06'),
      payload: { kind: 'machine_transcript_segment', text: 'Funding testimony', startMs: 3600000, endMs: 3609000, speakerLabel: 'Witness', hasGapBefore: true, isOfficialTranscript: false } }]);
    const result = await new HearingsRetrievalAdapter(prisma as never).retrieve(catalog.get('hearings'), request('hearings'));
    expect(result.records[0]).toMatchObject({ recordId: 'segment:one', occurredAt: null, payload: { text: 'Funding testimony', startMs: 3600000, hasGapBefore: true }, provenance: { sourceRecordId: 'one', hearingId: 'hearing' } });
    expect(result).toMatchObject({ sourceStatus: 'degraded', coverageComplete: false, paginationComplete: true });
    expect(result.stopReason).toContain('browser_session_rail_not_supported');
    expect(result.lastSyncAt).toBeUndefined();
  });

  it('applies tenant/user/authorized-client filters to overlays and never includes non-public hearings', async () => {
    const { tx, prisma } = harness();
    tx.$queryRaw.mockResolvedValue([]);
    await new HearingsRetrievalAdapter(prisma as never).retrieve(catalog.get('hearings'), request('hearings'));
    const sql = tx.$queryRaw.mock.calls[0]![0];
    expect(sql.text).toContain("h.visibility = 'public'");
    expect(sql.text).toContain('sub.user_id =');
    expect(sql.text).toContain('f.user_id =');
    expect(sql.text).toContain('f.client_ids::text[]'); // UUID[] follows and TEXT[] subscriptions differ
    expect(sql.text).toContain('r.tenant_id =');
    expect(sql.text).toContain('r.client_id::text IN');
    expect(sql.values).toEqual(expect.arrayContaining([TENANT, USER, CLIENT]));
    expect(sql.text).not.toContain('intel_transcript_segment'); // no ciphertext projection/decryption bypass
  });

  it('pages complete official text chunks and keeps missing event instants null', async () => {
    const { tx, prisma } = harness();
    tx.$queryRaw.mockResolvedValue([
      { key: 'official:source:0000000001', sourceTable: 'official_hearing_transcript', sourceId: 'source', hearingId: 'h', occurredAt: null, updatedAt: null, payload: { text: 'x'.repeat(6000), characterStart: 6000, characterEnd: 12000, totalCharacters: 15000 } },
      { key: 'official:source:0000000002', sourceTable: 'official_hearing_transcript', sourceId: 'source', hearingId: 'h', occurredAt: null, updatedAt: null, payload: { text: 'later evidence', characterStart: 12000 } },
    ]);
    const result = await new HearingsRetrievalAdapter(prisma as never).retrieve(catalog.get('hearings'), request('hearings'), 'official:source:0000000000');
    expect(result.nextCursor).toBe('official:source:0000000001');
    expect(result.records[0]!.payload.text).toHaveLength(6000);
    expect(result.records[0]!.occurredAt).toBeNull();
    const sql = tx.$queryRaw.mock.calls[0]![0];
    expect(sql.text).toContain('generate_series');
    expect(sql.text).toContain('combined.key >');
    expect(sql.values).toContain('official:source:0000000000');
  });

  it('does not turn a failed source into a complete empty result', async () => {
    const { tx, prisma } = harness();
    tx.$queryRaw.mockRejectedValue(new Error('source read failed'));
    await expect(new HearingsRetrievalAdapter(prisma as never).retrieve(catalog.get('hearings'), request('hearings'))).rejects.toThrow('source read failed');
    // RetrievalV2Service owns exception-to-error coverage conversion.
  });
});

describe('complete hearing evidence chunk continuation', () => {
  it('reconstructs oversized intelligence and escaped transcript payloads with stable source IDs', async () => {
    const { tx, prisma } = harness();
    const payload = { kind: 'hearing_intelligence', title: 'Funding advice', summary: 'Summary '.repeat(2000),
      evidenceText: '\\"\n'.repeat(3000), entities: [{ name: 'Late evidence entity' }],
      speakerName: 'Witness A', startMs: 3_600_000, endMs: 3_610_000, preliminary: true,
      derivedFromMachineTranscript: true };
    const row = { key: 'insight:source', sourceTable: 'public_hearing_insight', sourceId: 'source', hearingId: 'hearing',
      occurredAt: null, updatedAt: null, payload };
    tx.$queryRaw.mockResolvedValue([row]);
    const adapter = new HearingsRetrievalAdapter(prisma as never);
    let cursor: string | undefined;
    const text: string[] = [];
    do {
      const result = await adapter.retrieve(catalog.get('hearings'), request('hearings'), cursor);
      expect(result.records).toHaveLength(1);
      const record = result.records[0]!;
      expect(record.provenance!.sourceRecordId).toBe('source');
      expect(record.payload).toMatchObject({ speakerName: 'Witness A', startMs: 3_600_000,
        endMs: 3_610_000, preliminary: true, derivedFromMachineTranscript: true });
      expect(JSON.stringify(record).length).toBeLessThan(6500);
      expect(record.recordId.length).toBeLessThanOrEqual(80);
      text.push(record.payload.text as string);
      cursor = result.nextCursor;
    } while (cursor);
    expect(JSON.parse(text.join(''))).toEqual(payload);
    expect(text.length).toBeGreaterThan(10);
  });

  it('rejects a changed source while continuing an oversized record', async () => {
    const { tx, prisma } = harness();
    const row = { key: 'segment:source', sourceTable: 'public_hearing_transcript_segment', sourceId: 'source', hearingId: 'hearing',
      occurredAt: null, updatedAt: null, payload: { text: 'x'.repeat(10000) } };
    tx.$queryRaw.mockResolvedValue([row]);
    const adapter = new HearingsRetrievalAdapter(prisma as never);
    const first = await adapter.retrieve(catalog.get('hearings'), request('hearings'));
    tx.$queryRaw.mockResolvedValue([{ ...row, payload: { text: 'changed'.repeat(3000) } }]);
    const next = await adapter.retrieve(catalog.get('hearings'), request('hearings'), first.nextCursor);
    expect(next).toMatchObject({ records: [], coverageComplete: false, stopReason: 'hearing_content_changed_restart_read' });
  });

  it('applies exact hearing and escaped committee filters without admitting unrelated orphan transcripts', async () => {
    const { tx, prisma } = harness();
    tx.$queryRaw.mockResolvedValue([]);
    const input = { ...request('hearings'), hearingFilters: { hearingId: 'hearing-1', chamber: 'House', committeeName: 'A_%' } };
    input.caller.clientIds = undefined;
    await new HearingsRetrievalAdapter(prisma as never).retrieve(catalog.get('hearings'), input);
    const sql = tx.$queryRaw.mock.calls[0]![0];
    expect(sql.text).toContain('AND h.id =');
    expect(sql.text).toContain('lower(h.chamber)');
    expect(sql.values).toEqual(expect.arrayContaining(['hearing-1', 'House', '%A\\_\\%%']));
    expect(sql.values).toContain(false);
  });
});
