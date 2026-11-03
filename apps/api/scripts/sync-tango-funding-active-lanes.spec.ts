import { describe, expect, test } from '@jest/globals';
import { ACTIVE_SOURCE_LANES, reconcileUnconfirmedActive } from '../src/external/tango/funding-active-sources.js';
import type { RecordData } from '../src/external/tango/funding-catalog.mapper.js';
import { CatalogQuotaPause } from '../src/external/tango/funding-catalog.client.js';
import { walkActiveEndpoint } from './sync-tango-funding.js';

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
function harness(rows: RecordData[], overrides: { failWriteOn?: number; quota?: boolean; mapNullOn?: string } = {}) {
  const writes: Array<{ resourceType: string; cursor: string | null; completeness: string }> = [];
  const persisted: unknown[] = [];
  const store = {
    observations: {
      readCheckpoint: async () => null,
      writeCheckpoint: async (input: RecordData) => { writes.push(input as never); },
    },
    // The real store methods return early when commit is false; the fake must
    // model that or a dry-run test would prove nothing about the product.
    dibbsSolicitation: async (row: unknown, commit: boolean) => {
      if (!commit) return;
      if (overrides.failWriteOn != null && persisted.length === overrides.failWriteOn) throw new Error('write failed');
      persisted.push(row);
    },
    sbirTopic: async (row: unknown, commit: boolean) => { if (commit) persisted.push(row); },
    sbirSolicitation: async (row: unknown, commit: boolean) => { if (commit) persisted.push(row); },
  };
  const client = {
    get: async () => {
      if (overrides.quota) throw new CatalogQuotaPause('Request budget reached; checkpoint retained');
      return { count: rows.length, next: null, results: rows };
    },
  };
  const endpoint = ACTIVE_SOURCE_LANES.dibbs.endpoints[0];
  const map = (raw: RecordData) => {
    if (overrides.mapNullOn != null && JSON.stringify(raw).includes(`"${overrides.mapNullOn}"`)) return null;
    return endpoint.map(raw);
  };
  return { writes, persisted, store, client, endpoint: { ...endpoint, map } };
}

describe('active endpoint walk', () => {
  test('a complete page persists every row then commits the checkpoint', async () => {
    const h = harness([rfq('a'), rfq('b')]);
    const summary = await walkActiveEndpoint(h.endpoint as never, 'sync-tango-dibbs', {
      client: h.client as never, store: h.store as never, commit: true, maxPages: 5,
    });
    expect(summary).toMatchObject({ processed: 2, written: 2, complete: true });
    expect(h.persisted).toHaveLength(2);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ resourceType: 'dibbs_solicitation', cursor: null, completeness: 'complete' });
  });

  test('dry run writes nothing at all', async () => {
    const h = harness([rfq('a')]);
    const summary = await walkActiveEndpoint(h.endpoint as never, 'sync-tango-dibbs', {
      client: h.client as never, store: h.store as never, commit: false, maxPages: 5,
    });
    expect(summary.complete).toBe(true);
    expect(h.persisted).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
  });

  test('a failed write keeps the cursor on the page — no checkpoint advance', async () => {
    const h = harness([rfq('a'), rfq('b')], { failWriteOn: 1 });
    await expect(walkActiveEndpoint(h.endpoint as never, 'sync-tango-dibbs', {
      client: h.client as never, store: h.store as never, commit: true, maxPages: 5,
    })).rejects.toThrow('write failed');
    expect(h.writes).toHaveLength(0);
  });

  test('an unmappable record throws instead of silently finishing the page', async () => {
    const h = harness([rfq('a')], { mapNullOn: 'a' });
    await expect(walkActiveEndpoint(h.endpoint as never, 'sync-tango-dibbs', {
      client: h.client as never, store: h.store as never, commit: true, maxPages: 5,
    })).rejects.toThrow(/no provider identity/);
    expect(h.writes).toHaveLength(0);
  });

  test('a quota stop reports incomplete and commits no checkpoint', async () => {
    const h = harness([rfq('a')], { quota: true });
    const summary = await walkActiveEndpoint(h.endpoint as never, 'sync-tango-dibbs', {
      client: h.client as never, store: h.store as never, commit: true, maxPages: 5,
    });
    expect(summary.complete).toBe(false);
    expect(h.writes).toHaveLength(0);
  });

  test('a topic page maps through the SBIR rail into its own store method', async () => {
    const h = harness([topic('sbir-topic-1')]);
    const endpoint = ACTIVE_SOURCE_LANES.sbir.endpoints[0];
    const summary = await walkActiveEndpoint(endpoint, 'sync-tango-sbir', {
      client: h.client as never, store: h.store as never, commit: true, maxPages: 5,
    });
    expect(summary.written).toBe(1);
    expect(h.writes[0]).toMatchObject({ resourceType: 'sbir_topic' });
    expect((h.persisted[0] as { description?: string }).description).toContain('UAS');
  });
});

describe('closure re-check (exact ids, never absence)', () => {
  const endpoint = ACTIVE_SOURCE_LANES.dibbs.endpoints[0];
  const epoch = '2026-11-01T00:00:00.000Z';

  function adapters(rows: Array<{ localId: string; providerId: string }>, detail: (id: string) => Promise<RecordData | null>) {
    const confirmed: RecordData[] = [];
    const unconfirmed: string[] = [];
    return {
      confirmed, unconfirmed,
      deps: {
        unseen: async (_epochIso: string, limit: number) => rows.slice(0, limit),
        detail,
        markUnconfirmed: async (localId: string) => { unconfirmed.push(localId); },
      },
      persist: async (row: RecordData) => { confirmed.push(row); },
    };
  }

  test('a confirmed closed detail records the real lifecycle', async () => {
    const h = adapters([{ localId: 'L1', providerId: 'a' }], async (id) => ({ ...rfq(id), is_open: false }));
    const result = await reconcileUnconfirmedActive(endpoint, epoch, h.deps as never, { persist: h.persist });
    expect(result).toEqual({ checked: 1, confirmed: 1, unconfirmed: 0, complete: true });
    expect(h.confirmed).toHaveLength(1);
    expect(h.unconfirmed).toHaveLength(0);
  });

  test('a 404 marks only the derived flag, preserving the row', async () => {
    const h = adapters([{ localId: 'L1', providerId: 'a' }], async () => null);
    const result = await reconcileUnconfirmedActive(endpoint, epoch, h.deps as never, { persist: h.persist });
    expect(result).toEqual({ checked: 1, confirmed: 0, unconfirmed: 1, complete: true });
    expect(h.unconfirmed).toEqual(['L1']);
    expect(h.confirmed).toHaveLength(0);
  });

  test('an identity mismatch writes nothing at all', async () => {
    const h = adapters([{ localId: 'L1', providerId: 'a' }], async () => rfq('different-id'));
    const result = await reconcileUnconfirmedActive(endpoint, epoch, h.deps as never, { persist: h.persist });
    expect(result.confirmed).toBe(0);
    expect(result.unconfirmed).toBe(0);
    expect(h.confirmed).toHaveLength(0);
    expect(h.unconfirmed).toHaveLength(0);
  });

  test('an unmappable detail is not treated as a closure', async () => {
    const h = adapters([{ localId: 'L1', providerId: 'a' }], async () => ({ nomenclature: 'no uuid' }));
    const result = await reconcileUnconfirmedActive(endpoint, epoch, h.deps as never, { persist: h.persist });
    expect(result.confirmed).toBe(0);
    expect(result.unconfirmed).toBe(0);
  });

  test('a quota pause stops the pass incomplete and leaves the rest unchecked', async () => {
    const quota = new CatalogQuotaPause('Request budget reached; checkpoint retained');
    const h = adapters(
      [{ localId: 'L1', providerId: 'a' }, { localId: 'L2', providerId: 'b' }],
      async (id) => { if (id === 'a') throw quota; return rfq(id); },
    );
    const result = await reconcileUnconfirmedActive(endpoint, epoch, h.deps as never, { persist: h.persist });
    expect(result.complete).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(h.confirmed).toHaveLength(0);
  });

  test('it asks only for rows older than the epoch it was given', async () => {
    const seen: string[] = [];
    const h = adapters([], async () => null);
    await reconcileUnconfirmedActive(endpoint, epoch, {
      ...h.deps,
      unseen: async (epochIso: string, limit: number) => { seen.push(epochIso); return []; },
    } as never, { persist: h.persist });
    // A resumed sweep must pass its persisted epoch, not today's clock.
    expect(seen).toEqual([epoch]);
  });
});
