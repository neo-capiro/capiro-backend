import {
  renderMemoryItem,
  vaultPathForItem,
  renderWikiLink,
} from './memory-render.helpers.js';
import {
  splitDocument,
  parseFrontmatter,
  parseSections,
  extractWikiLinks,
} from './memory-parse.helpers.js';
import type { MemoryItem } from './memory.types.js';
import { MEMORY_SCHEMA_VERSION, defaultMemoryGovernanceFields } from './memory.types.js';

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'item-1',
    tenantId: '11111111-1111-1111-1111-111111111111',
    clientId: 'acme-corp',
    ownerUserId: null,
    type: 'client-soul',
    visibility: 'tenant',
    entityId: '22222222-2222-2222-2222-222222222222',
    slug: 'acme-corp',
    title: 'Acme Corp',
    aliases: ['Acme', 'ACME Inc'],
    tags: ['defense', 'priority'],
    source: 'manual',
    sourceRef: null,
    provenance: 'human',
    sections: [
      {
        key: 'summary',
        heading: 'Summary',
        owner: 'engine',
        body: 'Acme is a tracked client. Active on [[bill:hr-1234]].',
      },
      {
        key: 'strategic-read',
        heading: 'Our strategic read',
        owner: 'human',
        body: 'They say margins; they mean the [[person:jane-doe]] relationship.',
      },
    ],
    createdAt: '2026-06-25T00:00:00.000Z',
    updatedAt: '2026-06-25T00:00:00.000Z',
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
    ...overrides,
  };
}

describe('memory render/parse — dual representation', () => {
  // Criterion #3: every document carries tenant_id + visibility frontmatter.
  it('always renders tenant_id and visibility into frontmatter', () => {
    const md = renderMemoryItem(makeItem());
    expect(md).toContain('tenant_id: 11111111-1111-1111-1111-111111111111');
    expect(md).toContain('visibility: tenant');
  });

  // Criterion #6: re-rendering an item is byte-identical (idempotent).
  it('renders deterministically (idempotent re-render)', () => {
    const item = makeItem();
    expect(renderMemoryItem(item)).toBe(renderMemoryItem(item));
  });

  // Criterion #9: render -> parse -> render round-trips without loss.
  it('round-trips render -> parse -> render byte-identically', () => {
    const item = makeItem();
    const md1 = renderMemoryItem(item);
    const { frontmatter, body } = splitDocument(md1);
    const fm = parseFrontmatter(frontmatter);
    const sections = parseSections(body);
    const rebuilt: MemoryItem = {
      ...item,
      tenantId: fm.tenantId,
      visibility: fm.visibility,
      entityId: fm.entityId,
      clientId: fm.clientId,
      ownerUserId: fm.ownerUserId,
      slug: fm.slug,
      title: fm.title,
      aliases: fm.aliases,
      tags: fm.tags,
      source: fm.source,
      sourceRef: fm.sourceRef,
      provenance: fm.provenance,
      type: fm.type,
      schemaVersion: fm.schemaVersion,
      createdAt: fm.createdAt,
      updatedAt: fm.updatedAt,
      sections,
    };
    const md2 = renderMemoryItem(rebuilt);
    expect(md2).toBe(md1);
  });

  // Section ownership survives the round-trip (single-writer-per-section).
  it('preserves engine vs human section ownership through parse', () => {
    const md = renderMemoryItem(makeItem());
    const { body } = splitDocument(md);
    const sections = parseSections(body);
    const summary = sections.find((s) => s.heading === 'Summary');
    const read = sections.find((s) => s.heading === 'Our strategic read');
    expect(summary?.owner).toBe('engine');
    expect(read?.owner).toBe('human');
  });

  // A human edit to a human section parses back; engine block is untouched.
  it('captures human edits in human sections on parse-back', () => {
    const md = renderMemoryItem(makeItem());
    const edited = md.replace(
      'They say margins; they mean the [[person:jane-doe]] relationship.',
      'Updated read: budget markup is the real lever. [[issue:approps]]',
    );
    const { body } = splitDocument(edited);
    const sections = parseSections(body);
    const read = sections.find((s) => s.heading === 'Our strategic read');
    expect(read?.body).toContain('budget markup is the real lever');
    expect(read?.owner).toBe('human');
  });

  // Criterion #3 (fail-closed): a document without tenant_id is rejected.
  it('rejects a document whose tenant_id is null', () => {
    const md = renderMemoryItem(makeItem()).replace(
      'tenant_id: 11111111-1111-1111-1111-111111111111',
      'tenant_id: null',
    );
    const { frontmatter } = splitDocument(md);
    expect(() => parseFrontmatter(frontmatter)).toThrow(/tenant_id/);
  });

  // Criterion #5: wikilinks extract into typed graph-edge targets, de-duped.
  it('extracts de-duplicated typed wikilinks for the graph', () => {
    const md = renderMemoryItem(makeItem());
    const links = extractWikiLinks(md);
    const keys = links.map((l) => `${l.type}:${l.slug}`);
    expect(keys).toContain('bill:hr-1234');
    expect(keys).toContain('person:jane-doe');
    // de-dup: render the wikilink twice, expect one entry
    const dup = extractWikiLinks('[[bill:hr-1] x [[bill:hr-1]]]');
    expect(dup.filter((l) => l.slug === 'hr-1').length).toBe(1);
  });

  it('renders a typed wikilink in canonical form', () => {
    expect(renderWikiLink({ type: 'bill', slug: 'hr-1234' })).toBe('[[bill:hr-1234]]');
  });

  // Criterion #7: one canonical vault path per item; client-scoped nests right.
  it('computes canonical client-scoped vault paths', () => {
    expect(vaultPathForItem(makeItem({ type: 'client-soul', slug: 'acme-corp' }))).toBe(
      'clients/acme-corp/soul.md',
    );
    expect(vaultPathForItem(makeItem({ type: 'client-hub', slug: 'acme-corp' }))).toBe(
      'clients/acme-corp/index.md',
    );
    expect(vaultPathForItem(makeItem({ type: 'firm-soul' }))).toBe('soul.md');
  });

  // A user-private meri-session lands under the user's private folder.
  it('routes user-private items under the user vault', () => {
    const item = makeItem({
      type: 'meri-session',
      visibility: 'user',
      ownerUserId: 'user-9',
      clientId: null,
      slug: 'sess-42',
    });
    expect(vaultPathForItem(item)).toBe('users/user-9/meri/sess-42.md');
  });
});
