import { BadRequestException } from '@nestjs/common';
import { RegulatoryDocketService } from './regulatory-docket.service.js';
import { MeriToolsService } from '../meri/meri-tools.service.js';

// Synthetic PostgreSQL LIKE evaluator: escaped metacharacters are literal,
// unescaped percent/underscore match many/one character respectively.
function ilike(value: string, contains: string): boolean {
  let pattern = '';
  const text = `%${contains}%`;
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (character === '\\') pattern += text[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (character === '%') pattern += '.*';
    else if (character === '_') pattern += '.';
    else pattern += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`, 'i').test(value);
}
function fixture() {
  const rows = ['Airworthiness rule', 'UAS procurement', 'uas operations', 'Rates 10%', 'Rates 100', 'UAS_rule', 'UASXrule', 'Path \\ policy', 'Path policy']
    .map((title, i) => ({ documentId: `synthetic-${i}`, title, agencyId: 'FAA', documentType: 'Rule',
      postedDate: new Date('2026-01-01'), commentEndDate: new Date(Date.now() + 86400000), withdrawn: false }));
  rows.push({ ...rows[1]!, documentId: 'synthetic-other-agency', agencyId: 'EPA' });
  const requests: any[] = [];
  const matching = (where: any) => rows.filter((row) =>
    (!where.agencyId || row.agencyId === where.agencyId) &&
    (!where.documentType || row.documentType === where.documentType) &&
    (!where.title || ilike(row.title, where.title.contains)) &&
    (!where.commentEndDate || row.commentEndDate >= where.commentEndDate.gte && row.commentEndDate <= where.commentEndDate.lte));
  const service = new RegulatoryDocketService({ regulatoryDocket: {
    findMany: async (args: any) => { requests.push(args); return matching(args.where).slice(args.skip ?? 0, (args.skip ?? 0) + args.take); },
    count: async (args: any) => { requests.push(args); return matching(args.where).length; },
  } } as never);
  const tools = Object.create(MeriToolsService.prototype);
  Object.assign(tools, { regulatoryDockets: service });
  return { rows, requests, service, read: (input: Record<string, unknown>) => (tools as any).queryRegulatoryDockets(input) };
}

describe('literal regulatory docket title filter', () => {
  it('filters data and count before pagination while retaining agency/type selection', async () => {
    const f = fixture();
    const page = await f.read({ query: '  uaS  ', agencyId: 'FAA', documentType: 'Rule', limit: 1 });
    expect(page.total).toBe(4);
    expect(page.appliedQuery).toBe('uaS');
    expect(page.results.map((row: any) => row.title)).toEqual(['UAS procurement']);
    expect(f.requests[0].where).toEqual(f.requests[1].where);
    expect(f.requests[0].where).toMatchObject({ agencyId: 'FAA', documentType: 'Rule', title: { contains: 'uaS', mode: 'insensitive' } });
  });
  it.each([['%', 'Rates 10%', '\\%'], ['_', 'UAS_rule', '\\_'], ['\\', 'Path \\ policy', '\\\\']])('treats %s literally', async (query, title, escaped) => {
    const f = fixture();
    const page = await f.read({ query });
    expect(page.results.map((row: any) => row.title)).toEqual([title]);
    expect(page.total).toBe(1);
    expect(f.requests[0].where.title.contains).toBe(escaped);
  });
  it('filters the upcoming window before the existing bounded query', async () => {
    const f = fixture();
    f.rows.unshift(...Array.from({ length: 60 }, (_, i) => ({ ...f.rows[0]!, documentId: `unrelated-${i}` })));
    const page = await f.read({ query: 'procurement', upcomingOnly: true, days: 3, limit: 1 });
    expect(page.results[0].title).toBe('UAS procurement');
    expect(page.total).toBe(2);
    expect(page.appliedQuery).toBe('procurement');
    expect(f.requests[0]).toMatchObject({ take: 50, where: { withdrawn: false, title: { contains: 'procurement', mode: 'insensitive' } } });
  });
  it.each([undefined, null, '', '  '])('retains unfiltered behavior for %s', async (query) => {
    const f = fixture();
    const page = await f.read({ query });
    expect(page.total).toBe(f.rows.length);
    expect(page).not.toHaveProperty('appliedQuery');
    expect(f.requests[0].where).not.toHaveProperty('title');
  });
  it.each(['x'.repeat(201), 123])('refuses invalid query before any source read', async (query) => {
    const f = fixture();
    await expect(f.read({ query })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.requests).toEqual([]);
  });
  it('identifies an applied filter even when its source result is empty', async () => {
    const f = fixture();
    for (const upcomingOnly of [false, true]) {
      const page = await f.read({ query: 'absent topic', upcomingOnly });
      expect(page).toMatchObject({ appliedQuery: 'absent topic', total: 0, results: [] });
    }
  });
});
