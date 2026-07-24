import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { locate, locateAll } from './markdown-locate.js';

/*
 * LLM-free provenance mechanics against a REAL template body
 * (00_context_manifest.md — the most table-dense file in the pack), plus the
 * duplicate-heading suffix contract and the row round-trip.
 */

const TEMPLATES_DIR = join(__dirname, 'templates');

function manifestBody(): string {
  const raw = readFileSync(join(TEMPLATES_DIR, '00_context_manifest.md'), 'utf8');
  const { body, frontmatter } = parseFrontmatter(raw);
  expect(frontmatter).not.toBeNull();
  return body;
}

describe('locateAll on a real template body', () => {
  it('extracts every section with correct refs, levels and line spans', () => {
    const body = manifestBody();
    const { sections } = locateAll(body);

    expect(sections.map((s) => s.ref)).toEqual([
      'heading:Context manifest',
      'heading:Context health',
      'heading:Active files',
      'heading:Context gaps',
      'heading:Open conflicts',
      'heading:Resolutions',
    ]);
    expect(sections[0]!.level).toBe(1);
    expect(sections.slice(1).every((s) => s.level === 2)).toBe(true);

    // Line spans are 1-based and exact: the ref's startLine IS the heading line.
    const lines = body.split('\n');
    for (const s of sections) {
      expect(lines[s.startLine - 1]).toMatch(new RegExp(`^#{1,6}\\s+${s.heading}$`));
      expect(s.endLine).toBeGreaterThanOrEqual(s.startLine);
    }
    // Flat sectioning: a section ends the line before the next heading.
    expect(sections[1]!.endLine).toBe(sections[2]!.startLine - 1);
  });

  it('extracts every table with its section ref, header cells and data-row count', () => {
    const { tables } = locateAll(manifestBody());

    expect(tables.map((t) => t.sectionRef)).toEqual([
      'heading:Active files',
      'heading:Context gaps',
      'heading:Open conflicts',
      'heading:Resolutions',
    ]);
    const gaps = tables[1]!;
    expect(gaps.ref).toBe('table:Context gaps');
    expect(gaps.headerCells).toEqual([
      'gap_id',
      'Missing context',
      'Why it matters',
      'Owner',
      'Needed by',
      'Blocking',
    ]);
    expect(gaps.rowCount).toBe(1); // one blank seed row in the template
  });
});

describe('duplicate headings', () => {
  const doc = [
    '# Report',
    '',
    '## Notes',
    'first notes',
    '',
    '## Notes',
    'second notes',
    '',
    '## Notes',
    'third notes',
  ].join('\n');

  it("suffixes '#2', '#3' deterministically in document order (first is unsuffixed)", () => {
    const { sections } = locateAll(doc);
    expect(sections.map((s) => s.ref)).toEqual([
      'heading:Report',
      'heading:Notes',
      'heading:Notes#2',
      'heading:Notes#3',
    ]);
  });

  it('locate resolves each duplicate to ITS OWN content', () => {
    expect(locate(doc, 'heading:Notes')!.content).toContain('first notes');
    expect(locate(doc, 'heading:Notes#2')!.content).toContain('second notes');
    expect(locate(doc, 'heading:Notes#3')!.content).toContain('third notes');
    expect(locate(doc, 'heading:Notes#4')).toBeNull();
  });
});

describe('locate', () => {
  it('heading ref returns the exact section content and 1-based line span', () => {
    const body = manifestBody();
    const hit = locate(body, 'heading:Context health')!;

    expect(hit).not.toBeNull();
    expect(hit.kind).toBe('heading');
    expect(hit.content.startsWith('## Context health')).toBe(true);
    expect(hit.content).toContain('- Confirmed facts: 0');
    const lines = body.split('\n');
    expect(lines[hit.startLine - 1]).toBe('## Context health');
    expect(lines.slice(hit.startLine - 1, hit.endLine).join('\n')).toBe(hit.content);
  });

  it('row ref round-trips: the ref locateAll implies resolves to the raw row + header context', () => {
    const body = manifestBody();
    const { tables } = locateAll(body);
    const gaps = tables.find((t) => t.sectionRef === 'heading:Context gaps')!;
    // Build the row ref exactly as Stage E will: from the table's section ref.
    const ref = `row:${gaps.sectionRef.slice('heading:'.length)}:1`;

    const hit = locate(body, ref)!;
    expect(hit).not.toBeNull();
    expect(hit.kind).toBe('row');
    const lines = body.split('\n');
    const [rowLine, headerLine] = hit.content.split('\n');
    expect(rowLine).toContain('GAP-001'); // the raw data row...
    expect(headerLine).toContain('gap_id'); // ...plus the header for column context
    expect(lines[hit.startLine - 1]).toBe(rowLine); // line numbers point at the DATA row
    expect(hit.endLine).toBe(hit.startLine);
  });

  it('row refs under a duplicate heading carry the suffix', () => {
    const doc = [
      '## Items',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '## Items',
      '| a | b |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n');

    expect(locate(doc, 'row:Items:1')!.content).toContain('| 1 | 2 |');
    expect(locate(doc, 'row:Items#2:1')!.content).toContain('| 3 | 4 |');
  });

  it('unknown refs return null (unknown heading, out-of-range row, bogus scheme)', () => {
    const body = manifestBody();
    expect(locate(body, 'heading:No such heading')).toBeNull();
    expect(locate(body, 'row:Context gaps:99')).toBeNull();
    expect(locate(body, 'row:Context gaps:0')).toBeNull();
    expect(locate(body, 'row:No table here:1')).toBeNull();
    expect(locate(body, 'paragraph:whatever')).toBeNull();
  });
});
