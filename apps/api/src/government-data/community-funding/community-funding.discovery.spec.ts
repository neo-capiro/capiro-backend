import {
  discoverDocumentLinks,
  resolveSenateDownloadUrl,
  SOURCE_PAGES,
} from './community-funding.discovery.js';

describe('community funding discovery', () => {
  it('discovers relative PDF/XLSX links without hard-coded subcommittees', () => {
    const out = discoverDocumentLinks(
      '<a href="/a.pdf">Agriculture</a><a href="x.xlsx">Consolidated</a>',
      'https://example.gov/fy',
      'house',
    );
    expect(out.map(x => x.format)).toEqual(['pdf', 'xlsx']);
    expect(out[0]!.url).toBe('https://example.gov/a.pdf');
    expect(out[0]!.kind).toBe('table_pdf');
    expect(out[1]!.kind).toBe('consolidated_xlsx');
  });

  it('rejects House jurisdiction/rules PDFs while accepting posted tables', () => {
    const html = [
      '<a href="/jurisdictions.pdf">Jurisdictions</a>',
      '<a href="/rules.pdf">Rules</a>',
      '<a href="/posted.pdf">Posted Table</a>',
      '<a href="/final.pdf">Final Table</a>',
      '<a href="/xlsx.xlsx">Consolidated Table</a>',
    ].join('');
    const out = discoverDocumentLinks(html, 'https://appropriations.house.gov/fy', 'house');
    const byTitle = Object.fromEntries(out.map(c => [c.title, c]));
    expect(byTitle.Jurisdictions?.resolution).toBe('rejected');
    expect(byTitle.Rules?.resolution).toBe('rejected');
    expect(byTitle['Posted Table']?.resolution).toBe('accepted');
    expect(byTitle['Final Table']?.resolution).toBe('accepted');
    expect(byTitle['Consolidated Table']?.resolution).toBe('accepted');
  });

  it('accepts Senate /download/ slugs and resolves download=1 interstitials', () => {
    const html = [
      '<a href="../../../download/fy-22-ag-cds">Agriculture</a>',
      '<a href="/download/cjs-cds-fy-23">CJS CDS</a>',
      '<a href="/imo/media/doc/fy26_ag.pdf">Agriculture, Rural Development</a>',
    ].join('');
    const out = discoverDocumentLinks(
      html,
      'https://www.appropriations.senate.gov/fy-2022-congressionally-directed-spending',
      'senate',
    );
    const downloads = out.filter(c => c.format === 'download');
    expect(downloads.length).toBeGreaterThanOrEqual(2);
    expect(downloads.every(c => c.resolution === 'accepted')).toBe(true);
    expect(out.find(c => c.format === 'pdf')?.resolution).toBe('accepted');

    const resolved = resolveSenateDownloadUrl(
      'https://www.appropriations.senate.gov/download/fy-22-ag-cds',
      '<a href="https://www.appropriations.senate.gov/download/fy-22-ag-cds&download=1">Download</a>',
    );
    expect(resolved).toContain('download=1');
  });

  it('rejects Senate xlsx and House-only download paths', () => {
    const senate = discoverDocumentLinks(
      '<a href="/x.xlsx">Sheet</a>',
      'https://www.appropriations.senate.gov/fy',
      'senate',
    );
    expect(senate[0]?.resolution).toBe('rejected');
  });

  it('documents verified FY2022-FY2027 page coverage', () => {
    expect(Object.keys(SOURCE_PAGES.house)).toHaveLength(6);
    expect(Object.keys(SOURCE_PAGES.senate)).toHaveLength(6);
  });
});
