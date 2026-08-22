import {
  buildCompanySearchQueries,
  capabilitySearchTerms,
  discoverSameOriginPageCandidates,
  extractJsonObject,
  extractSyncedMailParticipants,
  fillFindingHash,
  isPrivateOrLocalIp,
  normalizeWebsite,
  provisionalPeScore,
  resolveEvidenceUrl,
} from './client-profile-fill.helpers.js';

describe('client-profile-fill helpers', () => {
  it('builds layered company searches from thin internal profiles', () => {
    const queries = buildCompanySearchQueries({
      name: 'Kiley Associates',
      website: 'kileyassociates.org',
      description: 'Government affairs and lobbying firm',
    });
    expect(queries).toEqual(expect.arrayContaining([
      '"Kiley Associates" company',
      '"Kiley Associates" official website',
      '"Kiley Associates" leadership team',
      '"Kiley Associates" contact',
      'site:kileyassociates.org contact',
    ]));
    expect(queries.length).toBeLessThanOrEqual(14);
  });

  it('hashes semantically identical objects deterministically', () => {
    const a = fillFindingHash({ kind: 'person', targetKey: 'person:a', source: 'public_web', proposedValue: { b: 2, a: 1 } });
    const b = fillFindingHash({ kind: 'person', targetKey: 'person:a', source: 'public_web', proposedValue: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it('normalizes public websites and rejects non-http schemes', () => {
    expect(normalizeWebsite('example.com')).toBe('https://example.com/');
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
  });

  it('accepts only evidence URLs that were actually gathered', () => {
    expect(resolveEvidenceUrl('https://example.com/about/', ['https://example.com/about'])).toBe('https://example.com/about');
    expect(resolveEvidenceUrl('https://example.com/invented', ['https://example.com'])).toBeNull();
  });

  it('extracts a fenced JSON object', () => {
    expect(extractJsonObject('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('extracts named participants from persisted synced-mail fields', () => {
    expect(
      extractSyncedMailParticipants([
        {
          fromEmail: 'owner@client.example',
          fromName: 'Owner Person',
          toRecipients: [{ email: 'contact@client.example', name: 'Contact Person' }],
          ccRecipients: [{ email: 'CONTACT@client.example', name: null }],
          bccRecipients: [],
          threadParticipants: [{ email: 'other@client.example', name: 'Other Person' }],
        },
      ]),
    ).toEqual([
      { email: 'contact@client.example', name: 'Contact Person' },
      { email: 'other@client.example', name: 'Other Person' },
      { email: 'owner@client.example', name: 'Owner Person' },
    ]);
  });

  it('blocks private and loopback addresses', () => {
    expect(isPrivateOrLocalIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrLocalIp('10.1.2.3')).toBe(true);
    expect(isPrivateOrLocalIp('8.8.8.8')).toBe(false);
  });

  it('builds bounded capability terms and scores only real text overlap', () => {
    const terms = capabilitySearchTerms({ name: 'Autonomous Ground Robotics', keywords: ['GPS-denied autonomy'] });
    expect(terms).toContain('autonomous');
    expect(terms).toContain('robotics');
    expect(provisionalPeScore({ title: 'Ground Robotics and Autonomous Systems' }, terms).score).toBeGreaterThan(0);
    expect(provisionalPeScore({ title: 'Military Medical Research' }, terms).score).toBe(0);
  });

  it('extracts PE search terms from thin client descriptions', () => {
    const terms = capabilitySearchTerms({
      name: 'Kiley Associates',
      description: 'Government affairs and lobbying firm',
    });
    expect(terms).toEqual(expect.arrayContaining(['kiley', 'associates', 'affairs', 'lobbying']));
  });

  it('adds capability and about site paths when a website domain is known', () => {
    const queries = buildCompanySearchQueries({
      name: 'GM DEFENSE, LLC',
      website: 'https://www.gmdefensellc.com/site/us/en/gm-defense/home.html',
    });
    expect(queries).toEqual(expect.arrayContaining([
      'site:gmdefensellc.com products',
      'site:gmdefensellc.com capabilities',
      'site:gmdefensellc.com about',
    ]));
  });

  it('discovers same-origin about/product/contact links from homepage html', () => {
    const html = `
      <a href="/about">About</a>
      <a href="https://www.gmdefensellc.com/products/isv">ISV</a>
      <a href="https://evil.example/contact">nope</a>
      <a href="/careers">Careers</a>
    `;
    const urls = discoverSameOriginPageCandidates(
      'https://www.gmdefensellc.com/home.html',
      html,
      6,
    );
    expect(urls).toEqual(expect.arrayContaining([
      'https://www.gmdefensellc.com/about',
      'https://www.gmdefensellc.com/products/isv',
    ]));
    expect(urls.every((url) => url.includes('gmdefensellc.com'))).toBe(true);
    expect(urls.some((url) => url.includes('evil.example'))).toBe(false);
  });
});
