import { extractCitationsFromToolResult } from '@capiro/shared';

describe('Congress bill citation URL binding', () => {
  const citation = (url: string) => extractCitationsFromToolResult('search_congress_bills', {
    data: [{
      id: '119-hr-8800',
      title: 'Synthetic 119th Congress bill',
      url,
    }],
  }, 1)[0];

  it('retains a matching official bill deep link', () => {
    expect(citation('https://www.congress.gov/bill/119th-congress/house-bill/8800/text'))
      .toMatchObject({ id: '119-hr-8800', url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800/text' });
  });

  it.each([
    'https://www.congress.gov/bill/118th-congress/house-bill/8800',
    'https://www.congress.gov/bill/119th-congress/house-bill/8801',
    'https://www.congress.gov/bill/119th-congress/senate-bill/8800',
    'https://congress.gov.attacker.test/bill/119th-congress/house-bill/8800',
    'https://www.congress.gov:444/bill/119th-congress/house-bill/8800',
    'https://user:pass@www.congress.gov/bill/119th-congress/house-bill/8800',
  ])('does not link a mismatched or unsafe source URL: %s', (url) => {
    expect(citation(url)).toMatchObject({ id: '119-hr-8800', url: null });
  });
});
