import {
  expandLegacyWatchlist,
  watchlistContentHash,
  MIN_TERM_LEN,
  type LegacyWatchlistRow,
} from '../src/watchlist/watchlist-mapping.js';

// Deterministic stub of @capiro/shared normalizeIssueArea for the unit under test.
const norm = (raw: string | null | undefined): string | null =>
  raw ? raw.trim().replace(/^energy$/i, 'Energy & Utilities') : null;

function row(tags: unknown, issueAreas: string[] = [], updatedBy: string | null = 'u1'): LegacyWatchlistRow {
  return { client_id: 'c1', tenant_id: 't1', issue_areas: issueAreas, tags, updated_by: updatedBy };
}

/** Phase 2 (plan §3.3 / §5.4 / SC-5): legacy tags → topics/terms expansion. */
describe('expandLegacyWatchlist', () => {
  it('maps one tag → one topic with position/priority defaults', () => {
    const e = expandLegacyWatchlist(row([{ tag: 'data center load' }]), norm);
    expect(e.topics).toHaveLength(1);
    expect(e.topics[0]).toMatchObject({ label: 'data center load', position: 'monitor', priority: 'med', issueArea: null });
    expect(e.createdBy).toBe('u1');
  });

  it('splits synonyms/relatedEntities/riskTerms into synonym|entity|risk (never risk_phrase)', () => {
    const e = expandLegacyWatchlist(
      row([{ tag: 'grid', synonyms: ['data centers'], relatedEntities: ['FERC'], riskTerms: ['moratorium'] }]),
      norm,
    );
    const types = e.topics[0].terms.map((t) => t.termType).sort();
    expect(types).toEqual(['entity', 'risk', 'synonym']);
    expect(e.topics[0].terms.find((t) => t.value === 'moratorium')?.termType).toBe('risk');
    expect(JSON.stringify(e)).not.toContain('risk_phrase');
  });

  it(`drops terms shorter than MIN_TERM_LEN (${MIN_TERM_LEN}) and de-dupes case-insensitively`, () => {
    const e = expandLegacyWatchlist(row([{ tag: 'x', synonyms: ['ab', 'Data', 'data', 'grid'] }]), norm);
    const vals = e.topics[0].terms.map((t) => t.value).sort();
    expect(vals).toEqual(['Data', 'grid']); // 'ab' dropped (<3), 'data' deduped
  });

  it('normalizes issueArea via the injected normalizer', () => {
    const e = expandLegacyWatchlist(row([{ tag: 'e', issueArea: 'energy' }]), norm);
    expect(e.topics[0].issueArea).toBe('Energy & Utilities');
  });

  it('collapses duplicate tag labels (topic key = label) and skips blank tags', () => {
    const e = expandLegacyWatchlist(row([{ tag: 'A' }, { tag: 'a' }, { tag: '  ' }]), norm);
    expect(e.topics).toHaveLength(1);
  });

  it('carries issue_areas and tolerates non-array tags', () => {
    const e = expandLegacyWatchlist(row(null, ['Energy & Utilities']), norm);
    expect(e.issueAreas).toEqual(['Energy & Utilities']);
    expect(e.topics).toEqual([]);
  });
});

/** SC-3/SC-6: content hash is order-independent and stable (no-op detection). */
describe('watchlistContentHash', () => {
  it('is identical regardless of tag/term order', () => {
    const a = expandLegacyWatchlist(
      row([
        { tag: 'a', synonyms: ['one', 'two'] },
        { tag: 'b', riskTerms: ['risk1'] },
      ]),
      norm,
    );
    const b = expandLegacyWatchlist(
      row([
        { tag: 'b', riskTerms: ['risk1'] },
        { tag: 'a', synonyms: ['two', 'one'] },
      ]),
      norm,
    );
    expect(watchlistContentHash(a)).toBe(watchlistContentHash(b));
  });

  it('changes when content changes', () => {
    const a = expandLegacyWatchlist(row([{ tag: 'a', synonyms: ['one'] }]), norm);
    const b = expandLegacyWatchlist(row([{ tag: 'a', synonyms: ['one', 'two'] }]), norm);
    expect(watchlistContentHash(a)).not.toBe(watchlistContentHash(b));
  });
});
