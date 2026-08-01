// Institutional Memory — store -> markdown projection (the "render" half of the
// dual representation). Pure functions, no I/O, fully unit-testable.
//
// Projects a canonical MemoryItem into an Obsidian-format markdown document:
// YAML frontmatter + typed sections. Engine-owned sections are wrapped in
// BEGIN/END GENERATED fences (visual markers only — the store, not the text, is
// the merge authority). Human-owned sections are emitted plainly so analysts
// can edit them; the parser reads them back.
//
// Invariants the tests pin:
//   - Every document carries tenant_id + visibility frontmatter (criterion #3).
//   - Round-trips with the parser without loss (criterion #9).
//   - Re-rendering the same item is byte-identical / idempotent (criterion #6).

import type { MemoryItem, MemorySection, WikiLink } from './memory.types.js';

const GEN_BEGIN = (key: string): string => `<!-- BEGIN GENERATED: ${key} -->`;
const GEN_END = (key: string): string => `<!-- END GENERATED: ${key} -->`;

/** Order frontmatter keys deterministically so re-renders are byte-stable. */
function renderFrontmatter(item: MemoryItem): string {
  const lines: string[] = ['---'];
  lines.push(`type: ${item.type}`);
  lines.push(`schema_version: ${item.schemaVersion}`);
  lines.push(`tenant_id: ${item.tenantId}`);
  lines.push(`entity_id: ${item.entityId ?? 'null'}`);
  lines.push(`visibility: ${item.visibility}`);
  lines.push(`owner: ${item.ownerUserId ?? 'null'}`);
  lines.push(`client_id: ${item.clientId ?? 'null'}`);
  lines.push(`slug: ${item.slug}`);
  lines.push(`title: ${yamlScalar(item.title)}`);
  lines.push(`aliases: ${yamlList(item.aliases)}`);
  lines.push(`tags: ${yamlList(item.tags)}`);
  lines.push(`source: ${item.source}`);
  lines.push(`source_ref: ${item.sourceRef ?? 'null'}`);
  lines.push(`created: ${item.createdAt}`);
  lines.push(`updated: ${item.updatedAt}`);
  lines.push(`generated_by: ${item.provenance}`);
  lines.push('---');
  return lines.join('\n');
}

/** Quote a YAML scalar only when needed (keeps simple titles clean + stable). */
function yamlScalar(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9 ._-]+$/.test(s) && !/^\s|\s$/.test(s)) return s;
  return JSON.stringify(s);
}

function yamlList(items: string[]): string {
  if (items.length === 0) return '[]';
  return `[${items.map((i) => yamlScalar(i)).join(', ')}]`;
}

/** Render one section. Engine sections get GENERATED fences; human ones don't. */
function renderSection(section: MemorySection): string {
  const heading = `## ${section.heading}`;
  const body = section.body.trimEnd();
  if (section.owner === 'engine') {
    return [heading, '', GEN_BEGIN(section.key), body, GEN_END(section.key)].join('\n');
  }
  return [heading, '', body].join('\n');
}

/**
 * Project a MemoryItem to a full markdown document. Deterministic: identical
 * input always yields byte-identical output (idempotency, criterion #6).
 */
export function renderMemoryItem(item: MemoryItem): string {
  const parts: string[] = [renderFrontmatter(item)];
  for (const section of item.sections) {
    parts.push('');
    parts.push(renderSection(section));
  }
  // Single trailing newline — POSIX text file convention, stable on re-render.
  return parts.join('\n') + '\n';
}

/**
 * Compute the canonical vault path (S3 key suffix) for an item. One canonical
 * location per item (criterion #7): client-scoped content nests under the
 * client folder; user-private content under the user folder.
 */
export function vaultPathForItem(item: MemoryItem): string {
  const clientDir = item.clientId !== null ? `clients/${slugForClient(item)}` : '';
  switch (item.type) {
    case 'firm-soul':
      return 'soul.md';
    case 'firm-compass':
      return 'compass.md';
    case 'playbook':
      return 'playbook.md';
    case 'client-hub':
      return `${clientDir}/index.md`;
    case 'client-soul':
      return `${clientDir}/soul.md`;
    case 'client-compass':
      return `${clientDir}/compass.md`;
    case 'client-people':
      return `${clientDir}/people.md`;
    case 'client-profile':
      return `${clientDir}/profile.md`;
    case 'meeting':
    case 'debrief':
      return `${clientDir}/meetings/${item.slug}.md`;
    case 'thread':
      return item.visibility === 'user'
        ? `users/${item.ownerUserId}/threads/${item.slug}.md`
        : `${clientDir}/threads/${item.slug}.md`;
    case 'meri-session':
      return `users/${item.ownerUserId}/meri/${item.slug}.md`;
    case 'person':
      return `people/${item.slug}.md`;
    case 'bill':
      return `bills/${item.slug}.md`;
    case 'issue':
      return `issues/${item.slug}.md`;
    default:
      return item.visibility === 'user'
        ? `users/${item.ownerUserId}/notes/${item.slug}.md`
        : `notes/${item.slug}.md`;
  }
}

/** The client folder slug is the client's own slug; here derived from clientId. */
function slugForClient(item: MemoryItem): string {
  // For client-scoped items the client slug is carried on the item slug for
  // the hub/soul/etc. types; for content types we fall back to clientId.
  if (item.type.startsWith('client-')) return item.slug;
  return item.clientId ?? 'unknown';
}

/** Render a typed wikilink in the canonical `[[type:slug]]` form. */
export function renderWikiLink(link: WikiLink): string {
  return `[[${link.type}:${link.slug}]]`;
}
