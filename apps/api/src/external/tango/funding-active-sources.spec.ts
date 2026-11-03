import { describe, expect, test } from '@jest/globals';
import { ACTIVE_SOURCE_LANES, ACTIVE_SOURCE_PAGE_SIZE, SBIR_TOPIC_SHAPE } from './funding-active-sources.js';
import type { RecordData } from './funding-catalog.mapper.js';

const rfq = (uuid: string): RecordData => ({
  uuid, solicitation: `SPE7M1-${uuid}`, nomenclature: 'WASHER, FLAT', nsn: '5310-00-123-4567',
  part_number: 'PN-1', quantity: '500', unit_of_issue: 'EA', issue_date: '2026-10-29',
  return_by_date: '2026-11-04', is_open: true, document_url: 'https://dibbs2.bsm.dla.mil/x.PDF',
});

const topic = (id: string): RecordData => ({
  topic_id: id, title: 'Counter-UAS', topic_number: 'OSW27BZ01-NV001', agency: 'DOD',
  solicitation_number: '27.BZ', cycle_name: 'DOD_SBIR_2027_P1_CBZ', activity: 'open',
  description: 'Inexpensive maneuverable UAS threat replication.', open_date: '2026-10-28',
  close_date: '2026-11-25', listed_open: true,
});

/** Fakes: no provider, no database, no clock. */
function harness(rows: RecordData[], overrides: { failWriteOn?: number; quota?: boolean; mapNullOn?: number } = {}) {
  const writes: Array<{ resourceType: string; cursor: string | null; completeness: string }> = [];
  const persisted: unknown[] = [];
  const store = {
    observations: {
      readCheckpoint: async () => null,
      writeCheckpoint: async (input: RecordData) => { writes.push(input as never); },
    },
    dibbsSolicitation: async (row: unknown) => {
      if (overrides.failWriteOn != null && persisted.length === overrides.failWriteOn) throw new Error('write failed');
      persisted.push(row);
    },
    sbirTopic: async (row: unknown) => { persisted.push(row); },
    sbirSolicitation: async (row: unknown) => { persisted.push(row); },
  };
  let calls = 0;
  const client = {
    get: async () => {
      if (overrides.quota) throw new CatalogQuotaPause('Request budget reached; checkpoint retained');
      calls += 1;
      return { count: rows.length, next: null, results: rows };
    },
  };
  const endpoint = ACTIVE_SOURCE_LANES.dibbs.endpoints[0];
  const map = (raw: RecordData) => {
    if (overrides.mapNullOn != null && JSON.stringify(raw).includes(`"${overrides.mapNullOn}"`)) return null;
    return endpoint.map(raw);
  };
  return { writes, persisted, store, client, calls: () => calls, endpoint: { ...endpoint, map } };
}

describe('active source descriptors', () => {
  test('exactly four provider endpoints, both lanes active-only', () => {
    expect(ACTIVE_SOURCE_LANES.dibbs.endpoints.map((e) => e.resource)).toEqual(['dibbs/rfqs', 'dibbs/rfps']);
    expect(ACTIVE_SOURCE_LANES.sbir.endpoints.map((e) => e.resource)).toEqual(['sbir/topics', 'sbir/solicitations']);
    for (const endpoint of [...ACTIVE_SOURCE_LANES.dibbs.endpoints, ...ACTIVE_SOURCE_LANES.sbir.endpoints]) {
      const active = endpoint.filter.open === true || endpoint.filter.activity === 'open';
      expect(active).toBe(true);
    }
    // Awards are historical award facts, never an active lane.
    const every = JSON.stringify(ACTIVE_SOURCE_LANES);
    expect(every).not.toContain('dibbs/awards');
    expect(ACTIVE_SOURCE_PAGE_SIZE).toBe(100);
  });

  test('DIBBS shapes are split per endpoint — the provider rejects an unknown field', () => {
    const [rfqEndpoint, rfpEndpoint] = ACTIVE_SOURCE_LANES.dibbs.endpoints;
    const rfqShape = String(rfqEndpoint.filter.shape);
    const rfpShape = String(rfpEndpoint.filter.shape);
    expect(rfqShape).toContain('quantity');
    expect(rfqShape).not.toContain('buyer_code');
    expect(rfpShape).toContain('buyer_code');
    expect(rfpShape).toContain('closes_date');
    expect(rfpShape).not.toContain('quantity');
  });

  test('topic shape requests description and the metadata the mapper writes', () => {
    for (const field of ['description', 'year', 'release_date', 'solicitation_status', 'activity']) {
      expect(SBIR_TOPIC_SHAPE.split(',')).toContain(field);
    }
    expect(ACTIVE_SOURCE_LANES.sbir.endpoints[0].filter.shape).toBe(SBIR_TOPIC_SHAPE);
  });

  test('both DIBBS endpoints share one table checkpoint; SBIR rails stay separate', () => {
    expect(ACTIVE_SOURCE_LANES.dibbs.endpoints.map((e) => e.checkpointResource))
      .toEqual(['dibbs_solicitation', 'dibbs_solicitation']);
    expect(ACTIVE_SOURCE_LANES.sbir.endpoints.map((e) => e.checkpointResource))
      .toEqual(['sbir_topic', 'sbir_solicitation']);
  });
});
