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
