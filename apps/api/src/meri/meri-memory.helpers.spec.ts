import {
  buildSavedMemoryRecord,
  extractMemoryKeywords,
  memoryKeySlug,
  memorySectionValue,
  rankMemoriesByKeyword,
  userScopedMemoryKey,
} from './meri-memory.helpers.js';

describe('memorySectionValue (Phase 1 SSOT projection recall)', () => {
  const section = (body: string) => [{ key: 'memory', heading: 'Memory', owner: 'human', body }];
  it('returns the memory section body verbatim when there is no graph suffix', () => {
    expect(memorySectionValue(section('Invoices monthly on the first'))).toBe(
      'Invoices monthly on the first',
    );
  });
  it('strips a trailing "Related:" wikilink line the projection appended', () => {
    expect(
      memorySectionValue(section('Client prefers email over calls\n\nRelated: [[person:jane]] [[client:acme]]')),
    ).toBe('Client prefers email over calls');
  });
  it('returns "" for a missing/odd sections shape rather than throwing', () => {
    expect(memorySectionValue(null)).toBe('');
    expect(memorySectionValue([{ key: 'other', body: 'x' }])).toBe('');
    expect(memorySectionValue('nope' as unknown)).toBe('');
  });
});

describe('rankMemoriesByKeyword (W2 memory fallback)', () => {
  const mems = [
    { key: 'nickname', value: 'The user prefers to be called Ninja' },
    { key: 'billing-cadence', value: 'Invoices monthly on the first' },
    { key: 'reporting-style', value: 'Wants brutally honest analysis' },
  ];

  it('ranks memories by keyword overlap with the query', () => {
    const out = rankMemoriesByKeyword(mems, 'what is the billing invoice cadence', 8);
    expect(out[0]!.key).toBe('billing-cadence');
  });

  it('never returns empty when memories exist but nothing matches (recency fallback)', () => {
    const out = rankMemoriesByKeyword(mems, 'zzzzz qqqqq', 8);
    expect(out.length).toBeGreaterThan(0);
    // Falls back to the input order (callers pass newest-first).
    expect(out[0]!.key).toBe('nickname');
  });

  it('returns most-recent when the query has no usable keywords', () => {
    const out = rankMemoriesByKeyword(mems, 'a an of', 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.key).toBe('nickname');
  });

  it('respects the limit', () => {
    const out = rankMemoriesByKeyword(mems, 'user analysis invoices', 1);
    expect(out).toHaveLength(1);
  });

  it('extractMemoryKeywords keeps tokens >=5 chars and dedupes', () => {
    expect(extractMemoryKeywords('Budget budget tiny FY2027 the')).toEqual(['budget', 'fy2027']);
  });
});

describe('memoryKeySlug', () => {
  it('slugifies and bounds a topic', () => {
    expect(memoryKeySlug('Preferred Nickname!')).toBe('preferred-nickname');
    expect(memoryKeySlug('  spaced  out  ')).toBe('spaced-out');
  });
  it('falls back to "note" for empty/punctuation-only input', () => {
    expect(memoryKeySlug('')).toBe('note');
    expect(memoryKeySlug('!!!')).toBe('note');
  });
});

describe('userScopedMemoryKey', () => {
  it('namespaces a key by user id (matches MeriService format)', () => {
    expect(userScopedMemoryKey('u-123', 'nickname')).toBe('user:u-123:nickname');
  });
});

describe('buildSavedMemoryRecord', () => {
  it('defaults to user_private scope and namespaces the key by user', () => {
    const rec = buildSavedMemoryRecord({
      content: 'The user prefers to be called Ninja',
      key: 'nickname',
      userId: 'u-1',
    });
    expect(rec).toEqual({
      scope: 'user_private',
      ownerUserId: 'u-1',
      clientId: null, // G2
      key: 'user:u-1:nickname',
      value: 'The user prefers to be called Ninja',
      source: 'user_requested',
      expiresAt: null, // G2: durable by default
    });
  });

  it('stores firm-wide (no owner, un-namespaced key) when scope is "firm"', () => {
    const rec = buildSavedMemoryRecord({
      content: 'The firm bills clients monthly',
      key: 'billing-cadence',
      scope: 'firm',
      userId: 'u-1',
    });
    expect(rec).toMatchObject({ scope: 'firm', ownerUserId: null, key: 'billing-cadence' });
  });

  it('derives a key from content when none is provided', () => {
    const rec = buildSavedMemoryRecord({
      content: 'Always cc the chief of staff on every outreach email',
      userId: 'u-9',
    });
    // key derives from the first 8 words of content, slugified + user-namespaced.
    expect(rec!.key).toBe('user:u-9:always-cc-the-chief-of-staff-on-every');
  });

  it('returns null for empty/whitespace content', () => {
    expect(buildSavedMemoryRecord({ content: '   ', userId: 'u-1' })).toBeNull();
    expect(buildSavedMemoryRecord({ content: '', userId: 'u-1' })).toBeNull();
  });

  it('caps very long values', () => {
    const rec = buildSavedMemoryRecord({ content: 'x'.repeat(9000), userId: 'u-1' });
    expect(rec!.value.length).toBe(4000);
  });

  it('treats unknown scope strings as personal', () => {
    const rec = buildSavedMemoryRecord({ content: 'note', scope: 'galaxy', userId: 'u-2' });
    expect(rec!.scope).toBe('user_private');
  });
});

// ── G2: client scope + ephemeral TTL ─────────────────────────────────────────
import { clientScopedMemoryKey } from './meri-memory.helpers.js';

describe('buildSavedMemoryRecord — client scope + ttlDays (G2)', () => {
  it('client scope binds to the supplied clientId with a client-namespaced key', () => {
    const r = buildSavedMemoryRecord({
      content: 'Acme red line: never support Section 852 offsets.',
      key: 'red-line',
      scope: 'client',
      userId: 'u1',
      clientId: 'c-123',
    });
    expect(r).toMatchObject({
      scope: 'client',
      clientId: 'c-123',
      ownerUserId: null,
      key: clientScopedMemoryKey('c-123', 'red-line'),
    });
    expect(r?.expiresAt ?? null).toBeNull();
  });

  it('client scope WITHOUT a client in context falls back to user-private (never silently firm-wide)', () => {
    const r = buildSavedMemoryRecord({
      content: 'A fact.',
      scope: 'client',
      userId: 'u1',
      clientId: null,
    });
    expect(r?.scope).toBe('user_private');
    expect(r?.ownerUserId).toBe('u1');
    expect(r?.clientId ?? null).toBeNull();
  });

  it('ttlDays makes the record ephemeral (bounded to 365 days)', () => {
    const before = Date.now();
    const r = buildSavedMemoryRecord({
      content: 'This week: prioritize the SAC-D markup.',
      scope: 'personal',
      userId: 'u1',
      ttlDays: 7,
    });
    const expires = r?.expiresAt?.getTime() ?? 0;
    expect(expires).toBeGreaterThan(before + 6.9 * 86_400_000);
    expect(expires).toBeLessThan(before + 7.1 * 86_400_000);

    const capped = buildSavedMemoryRecord({
      content: 'x',
      userId: 'u1',
      ttlDays: 10_000,
    });
    expect(capped?.expiresAt?.getTime() ?? 0).toBeLessThanOrEqual(before + 366 * 86_400_000);
  });

  it('non-positive/absent ttlDays stays durable', () => {
    expect(
      buildSavedMemoryRecord({ content: 'x', userId: 'u1', ttlDays: 0 })?.expiresAt ?? null,
    ).toBeNull();
    expect(buildSavedMemoryRecord({ content: 'x', userId: 'u1' })?.expiresAt ?? null).toBeNull();
  });
});
