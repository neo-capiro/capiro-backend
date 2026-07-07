import {
  digestForUser,
  isUsableWatchTerm,
  matchWatchlistClients,
  parseWatchlistTags,
  renderPeDigestEmail,
  type PeAlertItem,
} from './pe-alert-email.js';

const alert = (
  id: string,
  peCodes: string[],
  severity = 'notable',
  detectedAt = new Date('2026-07-07T06:00:00Z'),
): PeAlertItem => ({
  id,
  changeType: 'pe_mark_changed',
  severity,
  title: `Alert ${id}`,
  description: 'line one\nline two',
  relatedPeCodes: peCodes,
  detectedAt,
});

describe('digestForUser', () => {
  const watched = new Set(['0601102A', '0603270A']);

  it('keeps only alerts touching watched PEs, split by severity', () => {
    const d = digestForUser(
      [
        alert('a', ['0601102A']),
        alert('b', ['9999999F']),
        alert('c', ['0603270A'], 'critical'),
        alert('d', ['0207138F', '0601102A'], 'info'),
      ],
      watched,
    );
    expect(d.critical.map((x) => x.id)).toEqual(['c']);
    expect(d.regular.map((x) => x.id).sort()).toEqual(['a', 'd']);
  });

  it('returns empty sections for a user watching nothing relevant', () => {
    const d = digestForUser([alert('a', ['9999999F'])], watched);
    expect(d.critical).toHaveLength(0);
    expect(d.regular).toHaveLength(0);
  });

  it('dedupes repeated alert ids and sorts newest first', () => {
    const older = alert('a', ['0601102A'], 'notable', new Date('2026-07-06T06:00:00Z'));
    const newer = alert('b', ['0601102A'], 'notable', new Date('2026-07-07T06:00:00Z'));
    const d = digestForUser([older, newer, older], watched);
    expect(d.regular.map((x) => x.id)).toEqual(['b', 'a']);
  });
});

describe('renderPeDigestEmail', () => {
  it('renders subject with counts and per-PE deep links', () => {
    const { subject, html, text } = renderPeDigestEmail(
      {
        critical: [alert('c', ['0603270A'], 'critical')],
        regular: [alert('a', ['0601102A'])],
      },
      { appBaseUrl: 'https://app.capiro.ai' },
    );
    expect(subject).toBe('PE Watch daily digest — 2 updates (1 critical)');
    expect(html).toContain('https://app.capiro.ai/program-elements/0603270A');
    expect(html).toContain('CRITICAL');
    expect(text).toContain('https://app.capiro.ai/program-elements/0601102A');
  });

  it('escapes HTML in alert titles', () => {
    const nasty = { ...alert('x', ['0601102A']), title: 'Cut <script>alert(1)</script>' };
    const { html } = renderPeDigestEmail(
      { critical: [], regular: [nasty] },
      { appBaseUrl: 'https://app.capiro.ai' },
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('watchlist term matching', () => {
  it('isUsableWatchTerm rejects short/generic single words, keeps designators + phrases', () => {
    expect(isUsableWatchTerm('autonomy')).toBe(false);
    expect(isUsableWatchTerm('UAS')).toBe(false);
    expect(isUsableWatchTerm('F-35')).toBe(true);
    expect(isUsableWatchTerm('MQ-9')).toBe(true);
    expect(isUsableWatchTerm('Collaborative Combat Aircraft')).toBe(true);
    expect(isUsableWatchTerm('advanced munitions')).toBe(true);
  });

  it('matches whole words only, case-insensitive, across title + capability terms', () => {
    const pe = {
      peCode: '0207138F',
      title: 'Next Generation Air Dominance',
      capabilityTerms: ['collaborative combat aircraft', 'autonomy'],
    };
    const clients = matchWatchlistClients(pe, [
      { clientId: 'c1', tags: [{ tag: 'Collaborative Combat Aircraft' }] },
      { clientId: 'c2', tags: [{ tag: 'ground vehicles', synonyms: ['tracked combat vehicle'] }] },
      { clientId: 'c3', tags: [{ tag: 'irrelevant', relatedEntities: ['air dominance'] }] },
    ]);
    expect(clients.sort()).toEqual(['c1', 'c3']);
  });

  it('does not match terms that start mid-word (boundary check)', () => {
    const pe = { peCode: 'X', title: 'Counterattack Systems Program', capabilityTerms: [] };
    // 'attack systems' occurs inside 'Counterattack Systems' but starts mid-word.
    expect(
      matchWatchlistClients(pe, [{ clientId: 'c1', tags: [{ tag: 'attack systems' }] }]),
    ).toEqual([]);
    // Same term with a real boundary does match.
    const pe2 = { peCode: 'Y', title: 'Electronic Attack Systems Program', capabilityTerms: [] };
    expect(
      matchWatchlistClients(pe2, [{ clientId: 'c1', tags: [{ tag: 'attack systems' }] }]),
    ).toEqual(['c1']);
  });

  it('parseWatchlistTags tolerates malformed json shapes', () => {
    expect(parseWatchlistTags(null)).toEqual([]);
    expect(parseWatchlistTags('nope')).toEqual([]);
    expect(parseWatchlistTags([{ tag: 'x' }, 42, null])).toEqual([{ tag: 'x' }]);
  });
});
