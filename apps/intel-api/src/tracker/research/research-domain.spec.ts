import {
  parseFloridaCitation,
  parseFloridaConstitutionCitation,
  legalTargetMatches,
  legalReferenceKey,
  floridaCitationOccurrences,
  compareResearchVersions,
  validDateOnly,
  type ResearchVersion,
} from '@capiro/shared';
const version = (
  id: string,
  text: string,
  extra: Partial<ResearchVersion> = {},
): ResearchVersion => ({
  id,
  billId: 'FL-2026-SB432',
  jurisdiction: 'FL',
  sessionKey: '2026',
  revision: id,
  contentHash: id,
  extractorVersion: 'text-v1',
  sourceUrl: 'https://www.flsenate.gov/Session/Bill/2026/432',
  kind: 'text',
  publishedDate: '2026-01-01',
  observedAt: '2026-09-13T00:00:00.000Z',
  complete: true,
  sections: [{ locator: 'page:1', text, hash: 'test' }],
  ...extra,
});
describe('exact legal identities and evidence', () => {
  test('constitutional section numbers remain scoped to their article', () => {
    expect(
      legalTargetMatches(
        parseFloridaConstitutionCitation('Article I, Section 4')!,
        parseFloridaConstitutionCitation('Article II, Section 4')!,
        true,
      ),
    ).toBe(false);
    expect(
      legalTargetMatches(
        parseFloridaConstitutionCitation('Article I')!,
        parseFloridaConstitutionCitation('Article I, Section 4')!,
        true,
      ),
    ).toBe(true);
  });
  test('enumerated citations and explicit Florida constitution references have exact offsets', () => {
    const text = 'See ss. 395.003, 408.1 and 1002.30; Article I, Section 4, Florida Constitution.';
    const result = floridaCitationOccurrences(text, 'analysis');
    expect(result.occurrences).toHaveLength(4);
    expect(result.unresolved).toHaveLength(0);
    for (const item of result.occurrences) {
      expect(text.slice(item.start, item.end)).toBe(item.quote);
      expect(item.relation).toBe('cites');
    }
  });
  test('long unchanged tables avoid the changed-document comparison budget', () => {
    const text = Array.from({ length: 9000 }, (_, i) => 'Unchanged row ' + i).join('\n');
    expect(compareResearchVersions(version('a', text), version('b', text)).changes).toHaveLength(
      9000,
    );
  });
  test('retains trailing zeros and distinguishes chapter/section/subsection', () => {
    const a = parseFloridaCitation('Sec. 1002.30')!,
      b = parseFloridaCitation('1002.3')!,
      chapter = parseFloridaCitation('Chapter 1002')!;
    expect(a.section).toBe('1002.30');
    expect(legalReferenceKey(a)).not.toBe(legalReferenceKey(b));
    expect(legalTargetMatches(b, a, true)).toBe(false);
    expect(legalTargetMatches(chapter, a, false)).toBe(false);
    expect(legalTargetMatches(chapter, a, true)).toBe(true);
    expect(
      legalTargetMatches(
        parseFloridaCitation('395.003(1)')!,
        parseFloridaCitation('395.003(10)')!,
        true,
      ),
    ).toBe(false);
  });
  test('does not resolve statute zero or invent subsection monitoring from a folder title', () => {
    expect(parseFloridaCitation('Sec. 0')).toBeNull();
    expect(parseFloridaCitation('HCA F.S. 395.003(e)')).toBeNull();
    expect(parseFloridaCitation('934.5')!.section).toBe('934.5');
  });
  test.each(['title', 'analysis'] as const)(
    'citation in %s never becomes operative effect',
    (kind) => {
      const parsed = floridaCitationOccurrences(
        'Section 1. Section 395.003, Florida Statutes, is repealed.',
        kind,
      );
      expect(parsed.occurrences).toHaveLength(1);
      expect(parsed.occurrences[0]!.relation).toBe('cites');
    },
  );
  test('proposed repeal remains proposed and nested cross references remain citations', () => {
    const result = floridaCitationOccurrences(
      'Section 1. Section 395.003, Florida Statutes, is repealed.\nUnder s. 408.1, the existing rule applies.',
      'bill_text',
    );
    expect(result.occurrences.map((o) => o.relation)).toEqual(['proposes_repeal', 'cites']);
    for (const o of result.occurrences) expect(o.quote).toBe(o.reference.section);
  });
  test('ambiguous range notation is reviewable', () => {
    expect(
      floridaCitationOccurrences('ss. 1002.30 through 1002.35', 'bill_text').unresolved,
    ).toHaveLength(1);
  });
  test('exact comparison preserves pair ordering and source locators', () => {
    const result = compareResearchVersions(
      version('a', 'First\nOld\nLast'),
      version('b', 'First\nNew\nLast'),
    );
    expect(result.changes.map((c) => c.kind)).toEqual([
      'unchanged',
      'removed',
      'added',
      'unchanged',
    ]);
    expect(result.changes[1]!.left).toMatchObject({ locator: 'page:1', start: 6, end: 9 });
    expect(result.left.id).toBe('a');
    expect(result.right.id).toBe('b');
  });
  test('cross session requires explicit selection', () => {
    expect(() =>
      compareResearchVersions(version('a', 'a'), version('b', 'b', { sessionKey: '2025' })),
    ).toThrow('EXPLICIT_CROSS_BILL_SELECTION_REQUIRED');
    expect(
      compareResearchVersions(version('a', 'a'), version('b', 'b', { sessionKey: '2025' }), true)
        .right.sessionKey,
    ).toBe('2025');
  });
  test('incomplete extractions cannot pass comparison', () => {
    expect(() =>
      compareResearchVersions(version('a', 'a', { complete: false }), version('b', 'b')),
    ).toThrow('COMPLETE_EXTRACTIONS');
  });
  test('identical bytes and re-extraction changes are separate', () => {
    expect(
      compareResearchVersions(version('a', 'a'), version('b', 'a', { contentHash: 'a' }))
        .classification,
    ).toBe('identical_bytes');
    expect(
      compareResearchVersions(
        version('a', 'a'),
        version('b', 'a', { contentHash: 'a', extractorVersion: 'text-v2' }),
      ).classification,
    ).toBe('reextraction_only');
  });
  test.each(['2026-02-30', '2026-13-01', '2026-00-01', '2026-2-01'])(
    'rejects impossible date %s',
    (date) => expect(validDateOnly(date)).toBe(false),
  );
  test('leap day is exact and dates remain strings', () => {
    expect(validDateOnly('2024-02-29')).toBe(true);
    expect(validDateOnly('2026-02-29')).toBe(false);
  });
});
