jest.mock('../context/context-plane-gateway.service.js', () => ({
  ContextPlaneGatewayService: class {},
}));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

import {
  buildModelContextProjection,
  buildSteeringEvidenceProjection,
} from './meri-context-plane.service.js';
import type { RetrievalRecord } from '../retrieval/retrieval-v2.types.js';
import { validateFormBCitations } from '@capiro/shared';

const record = (body: string): RetrievalRecord => ({
  domain: 'meetings',
  recordId: 'meeting-1',
  payload: { title: 'Committee preparation', body },
  provenance: { sourceUrl: 'https://example.gov/meeting' },
});

describe('governed model evidence projection', () => {
  it('admits task evidence when a large client/strategy rail would otherwise exhaust the packet first', () => {
    const strategies: RetrievalRecord[] = Array.from({ length: 60 }, (_, index) => ({
      domain: 'strategies_work', recordId: `strategy:${index}`,
      payload: { title: `Strategy ${index}`, body: 'Long source work. '.repeat(300) },
    }));
    const sources: RetrievalRecord[] = [
      ...strategies,
      { domain: 'meetings', recordId: 'meeting:commitment', payload: { body: 'The client committed to provide technical data by Friday.' } },
      { domain: 'hearings', recordId: 'segment:relevant', payload: { text: 'The pilot remains proposed.', speakerLabel: 'Witness', startMs: 120000 } },
    ];
    const result = buildModelContextProjection(sources);
    expect(result.truncated).toBe(true);
    expect(result.records.map((row) => row.recordId)).toEqual(expect.arrayContaining(['strategy:0', 'meeting:commitment', 'segment:relevant']));
    expect(result.text).toContain('provide technical data by Friday');
    expect(result.text).toContain('The pilot remains proposed');
    const keptStrategies = result.records.filter((row) => row.domain === 'strategies_work');
    expect(keptStrategies.map((row) => row.recordId)).toEqual(strategies.slice(0, keptStrategies.length).map((row) => row.recordId));
    expect(result.text.length).toBeLessThanOrEqual(72_000);
  });

  it('preserves hearing attribution after a long transcript and distinguishes event, update and observation dates', () => {
    const result = buildModelContextProjection([{
      domain: 'hearings', recordId: 'segment:one',
      occurredAt: new Date('2026-09-01T12:00:00Z'), updatedAt: new Date('2026-09-02T10:00:00Z'),
      payload: {
        text: 'The department proposes a pilot. '.repeat(300),
        speakerLabel: 'Witness A', startMs: 3_600_000, endMs: 3_610_000,
        isOfficialTranscript: false, transcriptionConfidence: 0.91,
        sourceUrl: 'https://committee.house.gov/hearing/one', fetchedAt: '2026-09-02T11:00:00Z',
      },
      provenance: { sourceRecordId: 'one', sourceTable: 'public_hearing_transcript_segment' },
    }]);
    expect(result.records[0]).toMatchObject({
      payload: {
        speakerLabel: 'Witness A', startMs: 3_600_000, endMs: 3_610_000,
        isOfficialTranscript: false, sourceUrl: 'https://committee.house.gov/hearing/one',
        fetchedAt: '2026-09-02T11:00:00Z', contentTruncated: true,
        excerpts: { text: expect.stringContaining('department proposes') },
      },
      provenance: {
        recordOccurredAt: '2026-09-01T12:00:00.000Z', recordUpdatedAt: '2026-09-02T10:00:00.000Z',
      },
    });
    expect(result.records[0]?.provenance).not.toHaveProperty('observedAt');
    expect(result.records[0]?.provenance).not.toHaveProperty('retrievedAt');
    expect(JSON.stringify(result.records[0]!.payload).length).toBeLessThanOrEqual(3_000);
    expect(result.text).toContain(JSON.stringify(result.records[0]));
  });

  it('retains canonical funding claims, FY, units and document section instead of a JSON prefix', () => {
    const claim = { amount: 12.5, fiscalYear: 2027, units: 'millions_usd', stage: 'HAC-D', track: 'appropriation', isProjection: false };
    const source = {
      domain: 'program_elements' as const, recordId: '0605053A',
      payload: { description: 'Long program narrative. '.repeat(300), peCode: '0605053A', projectId: 'J001', currentClaim: claim },
      provenance: { details: 'Long source background. '.repeat(200), sourceUrl: 'https://example.gov/budget.pdf', documentSection: 'R-2A, project J001', page: 42, observedAt: '2026-09-01T00:00:00Z' },
    };
    const result = buildModelContextProjection([source]);
    expect(result.records[0]?.payload).toMatchObject({ peCode: '0605053A', projectId: 'J001', currentClaim: claim });
    expect(result.records[0]?.provenance).toMatchObject({ sourceUrl: 'https://example.gov/budget.pdf', documentSection: 'R-2A, project J001', page: 42, observedAt: '2026-09-01T00:00:00Z', contentTruncated: true });
    expect(JSON.stringify(result.records[0]!.provenance).length).toBeLessThanOrEqual(800);
  });

  it('uses stable citable aliases for long temporal graph composite IDs while preserving canonical identity', () => {
    const sourceRecordId =
      '12345678-1234-1234-1234-123456789012:23456789-2345-2345-2345-234567890123:34567890-3456-3456-3456-345678901234';
    const source = { ...record('Relationship fact'), recordId: sourceRecordId };
    const first = buildModelContextProjection([source]);
    const second = buildModelContextProjection([source]);
    const alias = first.records[0]!.recordId;
    expect(alias.length).toBeLessThanOrEqual(80);
    expect(second.records[0]!.recordId).toBe(alias);
    expect(first.records[0]!.sourceRecordId).toBe(sourceRecordId);
    expect(
      validateFormBCitations(`[S:context_plane:${alias}]`, { context_plane: first.text }).valid,
    ).toHaveLength(1);
  });
  it('keeps admitted steering citable with provenance and omits excluded or unrendered facts', () => {
    const result = buildSteeringEvidenceProjection({
      items: [
        {
          id: 'memory-approved',
          sourceRef: 'https://example.gov/source',
          sourceContentHash: 'original-hash',
          authority: 'human_confirmed',
          status: 'active',
          humanApproved: true,
          chars: 1000,
          omittedSections: ['Historical details'],
        },
        { id: 'not-rendered', sourceRef: 'private-ref' },
      ],
      rendered: [
        {
          id: 'memory-approved',
          title: 'Client constraint',
          body: '  Enacted funding only.  ',
          contentHash: 'rendered-hash',
          layer: 'client-steering',
        },
        { id: 'not-admitted', title: 'Unapproved', body: 'Must not appear' },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      recordId: 'steering:memory-approved',
      payload: { textContent: 'Enacted funding only.', authority: 'human_confirmed' },
      provenance: { sourceRef: 'https://example.gov/source', humanApproved: true },
      projection: { truncated: true, originalCharacters: 1000 },
    });
    expect(JSON.stringify(result)).not.toContain('Must not appear');
    expect(JSON.stringify(result)).not.toContain('not-rendered');
  });
  it('marks individual payload clipping and withholds the unseen tail from the ledger envelope', () => {
    const result = buildModelContextProjection([record(`${'a'.repeat(4_000)} hidden-tail`)]);
    expect(result.truncated).toBe(true);
    expect(result.records[0]?.projection.truncated).toBe(true);
    expect(result.records[0]?.payload.contentTruncated).toBe(true);
    expect(JSON.stringify(result.records)).not.toContain('hidden-tail');
    expect(result.text).toContain('[S:context_plane:meeting-1]');
    expect(result.text).toContain(JSON.stringify(result.records[0]));
  });
  it('marks provenance clipping as incomplete evidence too', () => {
    const input = { ...record('Complete body'), provenance: { details: 'p'.repeat(900) } };
    const result = buildModelContextProjection([input]);
    expect(result.truncated).toBe(true);
    expect(result.records[0]?.provenance?.contentTruncated).toBe(true);
  });
  it('does not seed records omitted by the total projection budget', () => {
    const records = Array.from({ length: 70 }, (_, index) => ({
      ...record('a'.repeat(2_000)),
      recordId: `meeting-${index}`,
    }));
    const result = buildModelContextProjection(records);
    expect(result.truncated).toBe(true);
    expect(result.records.length).toBeLessThan(records.length);
    expect(result.text).not.toContain('meeting-69');
    expect(JSON.stringify(result.records)).not.toContain('meeting-69');
  });
  it('keeps complete small records and empty results truthful', () => {
    expect(buildModelContextProjection([record('Complete body')])).toMatchObject({
      truncated: false,
      records: [{ payload: { body: 'Complete body' }, projection: { truncated: false } }],
    });
    expect(buildModelContextProjection([])).toEqual({
      text: '(no retrieval records returned)',
      records: [],
      truncated: false,
    });
  });
});
