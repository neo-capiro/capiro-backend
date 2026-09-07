import { BadRequestException } from '@nestjs/common';
import { parseClientProfileQuery, readClientProfileSection } from './meri-client-context.helpers';

const clientId = 'client-a';
const records = Array.from({ length: 63 }, (_, i) => ({
  id: `record-${String(i + 1).padStart(3, '0')}`,
  description: `Full evidence ${i + 1}: ${'x'.repeat(500)}`,
  updatedAt: '2026-09-06T00:00:00.000Z',
}));
const load = jest.fn(async () => records);
const summarize = (row: typeof records[number]) => ({ id: row.id, description: row.description.slice(0, 20) });
const read = (input: Record<string, unknown>) => readClientProfileSection({
  clientId, section: 'submissionHistory', query: parseClientProfileQuery(input, clientId), load, summarize,
});

describe('canonical Meri client profile coverage', () => {
  beforeEach(() => load.mockClear());

  it('reports the entire source count and can read beyond both previous 25 and 50 record caps', async () => {
    const overview = await read({});
    expect(overview.items).toHaveLength(25);
    expect(overview.coverage).toMatchObject({ total: 63, status: 'partial', truncated: true, representation: 'summary' });
    const seen = [...overview.items];
    let cursor = overview.coverage.nextCursor;
    while (cursor) {
      const page = await read({ section: 'submissionHistory', cursor });
      seen.push(...page.items);
      expect(page.coverage.total).toBe(63);
      expect(page.coverage.representation).toBe('full');
      expect(page.items[0]?.description).toContain('x'.repeat(500));
      cursor = page.coverage.nextCursor;
      if (!cursor) expect(page.coverage).toMatchObject({ returned: 13, status: 'complete', truncated: false });
    }
    expect(seen.map((row) => row.id)).toEqual(records.map((row) => row.id));
  });

  it('can reread the first section page with complete fields and source references', async () => {
    const result = await read({ section: 'submissionHistory', limit: 1 });
    expect(result.items).toEqual([records[0]]);
    expect(result.coverage.source).toEqual({ tool: 'get_client_context', clientId, section: 'submissionHistory' });
    expect(result.coverage.sourceReferences).toEqual([{ recordId: records[0]!.id, updatedAt: records[0]!.updatedAt }]);
  });

  it('reports a failed section as unavailable with an unknown count, distinct from a known empty section', async () => {
    const failed = await readClientProfileSection({ clientId, section: 'people', query: { limit: 25 }, load: async () => { throw new Error('DB unavailable'); }, summarize });
    const empty = await readClientProfileSection({ clientId, section: 'people', query: { limit: 25 }, load: async () => [], summarize });
    expect(failed.coverage).toMatchObject({ status: 'unavailable', total: null, truncated: null, error: 'section_unavailable' });
    expect(empty.coverage).toMatchObject({ status: 'complete', total: 0, returned: 0, truncated: false });
  });

  it('does not load unrequested sections and labels their count unknown', async () => {
    const result = await read({ section: 'people' });
    expect(load).not.toHaveBeenCalled();
    expect(result.coverage).toMatchObject({ status: 'not_requested', total: null });
  });

  it('rejects cursors reused for another client or section, and malformed options', async () => {
    const first = await read({});
    expect(() => parseClientProfileQuery({ section: 'submissionHistory', cursor: first.coverage.nextCursor }, 'client-b')).toThrow(BadRequestException);
    expect(() => parseClientProfileQuery({ section: 'people', cursor: first.coverage.nextCursor }, clientId)).toThrow(BadRequestException);
    for (const input of [{ cursor: first.coverage.nextCursor }, { limit: 51 }, { representation: 'invalid' }, { section: 'secrets' }, { section: 'people', cursor: 'garbage' }]) {
      expect(() => parseClientProfileQuery(input, clientId)).toThrow(BadRequestException);
    }
  });

  it('allows concise selected-section inventory pages without changing full-record defaults', async () => {
    const result = await read({ section: 'submissionHistory', representation: 'summary', limit: 50 });
    expect(result.items).toHaveLength(50);
    expect(result.items[0]!.description).toBe(records[0]!.description.slice(0, 20));
    expect(result.coverage).toMatchObject({ total: 63, representation: 'summary', truncated: true });
  });

  it('retains domain counts, cursor and provenance without loading unbounded record bodies', async () => {
    const loadPage = jest.fn(async () => ({ items: [records[0]!], total: 800, hasMore: true }));
    const first = await readClientProfileSection({
      clientId, section: 'advocacyRecords', query: { section: 'advocacyRecords', limit: 1 }, loadPage, summarize,
    });
    expect(first.coverage).toMatchObject({ total: 800, returned: 1, status: 'partial' });
    const nextQuery = parseClientProfileQuery({ section: 'advocacyRecords', cursor: first.coverage.nextCursor }, clientId);
    expect(nextQuery.afterId).toBe(records[0]!.id);
    expect(() => parseClientProfileQuery({ section: 'advocacyMatters', cursor: first.coverage.nextCursor }, clientId)).toThrow(BadRequestException);
    expect(() => parseClientProfileQuery({ section: 'advocacyRecords', cursor: first.coverage.nextCursor }, 'client-b')).toThrow(BadRequestException);
    await readClientProfileSection({ clientId, section: 'advocacyRecords', query: { section: 'people', limit: 25 }, loadPage, summarize });
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it('continues after a cursor record is deleted without repeating earlier rows', async () => {
    const first = await read({ limit: 2 });
    const result = await readClientProfileSection({
      clientId, section: 'submissionHistory',
      query: parseClientProfileQuery({ section: 'submissionHistory', cursor: first.coverage.nextCursor, limit: 2 }, clientId),
      load: async () => records.filter((row) => row.id !== records[1]!.id).reverse(), summarize,
    });
    expect(result.items.map((row) => row.id)).toEqual([records[2]!.id, records[3]!.id]);
  });
});
