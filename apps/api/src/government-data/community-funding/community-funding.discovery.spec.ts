import { discoverDocumentLinks, SOURCE_PAGES } from './community-funding.discovery.js';
describe('community funding discovery', () => {
  it('discovers relative PDF/XLSX links without hard-coded subcommittees', () => {
    const out=discoverDocumentLinks('<a href="/a.pdf">Agriculture</a><a href="x.xlsx">Consolidated</a>','https://example.gov/fy','house');
    expect(out.map(x=>x.format)).toEqual(['pdf','xlsx']); expect(out[0]!.url).toBe('https://example.gov/a.pdf');
  });
  it('documents verified FY2022-FY2027 page coverage', () => expect(Object.keys(SOURCE_PAGES.house)).toHaveLength(6));
});
