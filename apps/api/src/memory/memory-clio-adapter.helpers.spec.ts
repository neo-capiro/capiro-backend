import {
  clioMemoryToItem,
  clioMemorySlug,
  extractCandidateNames,
  type ClioMemoryRow,
  type NameResolver,
} from './memory-clio-adapter.helpers.js';
import { renderMemoryItem } from './memory-render.helpers.js';
import {
  splitDocument,
  parseFrontmatter,
  parseSections,
  extractWikiLinks,
} from './memory-parse.helpers.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

function row(over: Partial<ClioMemoryRow> = {}): ClioMemoryRow {
  return {
    id: 'mem-1',
    tenantId: TENANT,
    scope: 'firm',
    ownerUserId: null,
    key: 'Acme priorities',
    value: 'Acme Corp cares about shipyard jobs.',
    source: 'conversation',
    metadata: {},
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...over,
  };
}

describe('ClioMemory -> MemoryItem adapter (Phase B unification)', () => {
  it('maps firm scope to tenant visibility', () => {
    const item = clioMemoryToItem(row({ scope: 'firm' }));
    expect(item.visibility).toBe('tenant');
    expect(item.ownerUserId).toBeNull();
  });

  it('maps user_private scope to user visibility with owner', () => {
    const item = clioMemoryToItem(row({ scope: 'user_private', ownerUserId: 'user-9' }));
    expect(item.visibility).toBe('user');
    expect(item.ownerUserId).toBe('user-9');
  });

  it('uses a stable idempotent slug (clio:<id>)', () => {
    expect(clioMemoryToItem(row()).slug).toBe('clio:mem-1');
    expect(clioMemorySlug('abc')).toBe('clio:abc');
  });

  it('preserves the memory key as title and value as body', () => {
    const item = clioMemoryToItem(row());
    expect(item.title).toBe('Acme priorities');
    expect(item.sections[0]?.body).toContain('shipyard jobs');
    expect(item.sections[0]?.owner).toBe('human');
  });

  it('links recognized client names into wikilinks for graph edges', () => {
    const resolver: NameResolver = (n) =>
      n.toLowerCase() === 'acme corp' ? { type: 'client', slug: 'acme-id' } : null;
    const item = clioMemoryToItem(row(), resolver);
    const links = extractWikiLinks(item.sections.map((s) => s.body).join('\n'));
    expect(links.some((l) => l.type === 'client' && l.slug === 'acme-id')).toBe(true);
  });

  it('adds no links when resolver matches nothing', () => {
    const item = clioMemoryToItem(row(), () => null);
    expect(item.sections[0]?.body).not.toContain('[[');
  });

  it('round-trips render -> parse -> render byte-identically', () => {
    const item = clioMemoryToItem(row());
    const md1 = renderMemoryItem(item);
    const { frontmatter, body } = splitDocument(md1);
    const fm = parseFrontmatter(frontmatter);
    const rebuilt = { ...item, ...fm, ownerUserId: fm.ownerUserId, sections: parseSections(body) };
    expect(renderMemoryItem(rebuilt)).toBe(md1);
  });

  it('extracts capitalized candidate spans, de-duplicated', () => {
    // NOTE: the extractor is intentionally greedy — a sentence-leading capital
    // (e.g. "Met") is included in the span. This is harmless because linking
    // only happens when a span EXACTLY matches a known entity name via the
    // resolver, so an over-captured span like "Met Senator Jane Doe" simply
    // fails to resolve and creates no false edge. The resolver is the gate.
    const names = extractCandidateNames(
      'Met Senator Jane Doe about Acme Corp and Acme Corp again.',
    );
    expect(names).toContain('Acme Corp');
    expect(names.filter((n) => n === 'Acme Corp').length).toBe(1);
    // a real client name embedded mid-sentence is still captured exactly
    const names2 = extractCandidateNames('We should call Acme Corp tomorrow.');
    expect(names2).toContain('Acme Corp');
  });

  it('resolver only links exact entity-name matches (no false edges from greedy spans)', () => {
    const resolver: NameResolver = (n) =>
      n.toLowerCase() === 'acme corp' ? { type: 'client', slug: 'acme-id' } : null;
    const item = clioMemoryToItem(
      row({ value: 'Met Senator Jane Doe about Acme Corp.' }),
      resolver,
    );
    const body = item.sections.map((s) => s.body).join('\n');
    expect(body).toContain('[[client:acme-id]]');
    // only the resolved client link is added; the greedy "Met Senator..." span
    // did not resolve, so there is no [[...]] link for it.
    const links = body.match(/\[\[[^\]]+\]\]/g) ?? [];
    expect(links).toEqual(['[[client:acme-id]]']);
  });

  // ── Phase 4: confidence carry ──────────────────────────────────────────────
  it('carries a numeric metadata.confidence onto item.confidence', () => {
    const item = clioMemoryToItem(row({ metadata: { confidence: 0.82 } }));
    expect(item.confidence).toBeCloseTo(0.82, 10);
  });

  it('clamps an out-of-range metadata.confidence to [0,1]', () => {
    expect(clioMemoryToItem(row({ metadata: { confidence: 1.5 } })).confidence).toBe(1);
    expect(clioMemoryToItem(row({ metadata: { confidence: -0.2 } })).confidence).toBe(0);
  });

  it('leaves confidence null when metadata has no numeric confidence', () => {
    expect(clioMemoryToItem(row({ metadata: {} })).confidence).toBeNull();
    expect(clioMemoryToItem(row({ metadata: { confidence: 'high' } })).confidence).toBeNull();
    expect(clioMemoryToItem(row({ metadata: null })).confidence).toBeNull();
  });
});

// ── G2: client scope + expiry projection ─────────────────────────────────────
describe('clioMemoryToItem — client scope + expiry (G2)', () => {
  const base = {
    id: 'cm-1',
    tenantId: 't1',
    ownerUserId: null,
    key: 'acme-red-line',
    value: 'Never support Section 852 offsets.',
    source: 'user_requested',
    metadata: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  };

  it("scope='client' projects tenant-visible + client-keyed", () => {
    const item = clioMemoryToItem({ ...base, scope: 'client', clientId: 'c-9' });
    expect(item.visibility).toBe('tenant');
    expect(item.clientId).toBe('c-9');
    expect(item.ownerUserId).toBeNull();
  });

  it('expiresAt carries onto the projection unchanged', () => {
    const item = clioMemoryToItem({
      ...base,
      scope: 'user_private',
      ownerUserId: 'u1',
      expiresAt: '2026-07-20T00:00:00.000Z',
    });
    expect(item.expiresAt).toEqual(new Date('2026-07-20T00:00:00.000Z'));
    // durable rows stay durable
    const durable = clioMemoryToItem({ ...base, scope: 'firm' });
    expect(durable.expiresAt ?? null).toBeNull();
  });
});
