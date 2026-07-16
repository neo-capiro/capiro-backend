import { Paragraph, Table } from 'docx';
import {
  parseInlineRuns,
  htmlToDocxNodes,
  splitOutTables,
  parsePlainTableRows,
  decodeEntities,
  ExportService,
} from './export.service.js';
import { NotFoundException } from '@nestjs/common';

describe('decodeEntities (&amp; decoded last — no double-decode)', () => {
  it('decodes each entity exactly once', () => {
    expect(decodeEntities('Rock &amp; Roll')).toBe('Rock & Roll');
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>');
  });
  it('does NOT double-decode an escaped entity (&amp;lt; → &lt;, not <)', () => {
    // The sanitized store holds "&amp;lt;" when the user typed the literal
    // text "&lt;". It must render as "&lt;", never collapse to "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('a &amp;amp; b')).toBe('a &amp; b');
  });
});

describe('parseInlineRuns (DOCX inline formatting — fixes B3.7/B9.4 raw-tag leak)', () => {
  it('splits plain + bold + italic + superscript into separately-styled runs', () => {
    const runs = parseInlineRuns(
      'Request is <strong>$72.1M</strong> as of FY26 <sup>[1]</sup>, <em>confirmed</em>.',
    );
    expect(runs).toEqual([
      { text: 'Request is ' },
      { text: '$72.1M', bold: true },
      { text: ' as of FY26 ' },
      { text: '[1]', superScript: true },
      { text: ', ' },
      { text: 'confirmed', italics: true },
      { text: '.' },
    ]);
  });

  it('never leaks a raw tag into run text', () => {
    const runs = parseInlineRuns('<strong>bold</strong><sup>1</sup>');
    for (const r of runs) expect(r.text).not.toMatch(/[<>]/);
  });

  it('decodes HTML entities inside inline text', () => {
    const runs = parseInlineRuns('Rock &amp; Roll &mdash; &lt;ok&gt;');
    expect(runs.map((r) => r.text).join('')).toBe('Rock & Roll — <ok>');
  });

  it('supports <b>/<i> aliases identically to <strong>/<em>', () => {
    expect(parseInlineRuns('<b>x</b>')).toEqual([{ text: 'x', bold: true }]);
    expect(parseInlineRuns('<i>x</i>')).toEqual([{ text: 'x', italics: true }]);
  });
});

describe('htmlToDocxNodes (fixes B3.7/B9.4: DOCX must not render raw HTML tags as text)', () => {
  it('a <p> becomes exactly one Paragraph node', () => {
    const nodes = htmlToDocxNodes('<p>Hello world</p>');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toBeInstanceOf(Paragraph);
  });

  it('a <ul><li> list becomes one bulleted Paragraph per item', () => {
    const nodes = htmlToDocxNodes('<ul><li>one</li><li>two</li></ul>');
    expect(nodes).toHaveLength(2);
    for (const n of nodes) expect(n).toBeInstanceOf(Paragraph);
  });

  it('a <table> becomes a real Table node, not flattened text', () => {
    const nodes = htmlToDocxNodes(
      '<table><tr><th>Year</th><th>Amount</th></tr><tr><td>FY26</td><td>$10M</td></tr></table>',
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toBeInstanceOf(Table);
  });

  it('mixed content produces one node per block, in document order', () => {
    const nodes = htmlToDocxNodes(
      '<p>Intro.</p><ul><li>a</li></ul><table><tr><td>x</td></tr></table><p>Outro.</p>',
    );
    expect(nodes.map((n) => (n instanceof Table ? 'table' : 'p'))).toEqual([
      'p',
      'p', // list item
      'table',
      'p',
    ]);
  });

  it('citation footnote markers survive as superscript runs, not literal tags', () => {
    // This is exactly what Phase 3.1's citation renderer emits.
    const nodes = htmlToDocxNodes('<p>Funding is $72.1M<sup>[1]</sup>.</p>');
    expect(nodes).toHaveLength(1);
    // We can't peek inside a built Paragraph's XML without Packer-ing it, but
    // we CAN assert the underlying run parser (exercised by htmlToDocxNodes)
    // never leaves the token in text form:
    const runs = parseInlineRuns('Funding is $72.1M<sup>[1]</sup>.');
    expect(runs.some((r) => r.superScript && r.text === '[1]')).toBe(true);
    expect(runs.every((r) => !r.text.includes('<sup'))).toBe(true);
  });
});

describe('splitOutTables + parsePlainTableRows (fixes B9.3: PDF must render an inline <table> as a real table)', () => {
  it('extracts an embedded <table> as its own segment with parsed rows', () => {
    const segments = splitOutTables(
      '<p>Before.</p><table><tr><th>Year</th><th>Amount</th></tr><tr><td>FY26</td><td>$10M</td></tr></table><p>After.</p>',
    );
    expect(segments.map((s) => s.kind)).toEqual(['html', 'table', 'html']);
    const tableSeg = segments[1]!;
    expect(tableSeg.rows).toEqual([
      ['Year', 'Amount'],
      ['FY26', '$10M'],
    ]);
  });

  it('content with no table at all is a single html segment', () => {
    const segments = splitOutTables('<p>Just prose.</p>');
    expect(segments).toEqual([{ kind: 'html', html: '<p>Just prose.</p>' }]);
  });

  it('parsePlainTableRows strips inline tags from cell text', () => {
    const rows = parsePlainTableRows('<tr><td><strong>Bold</strong> cell</td></tr>');
    expect(rows).toEqual([['Bold cell']]);
  });
});

describe('ExportService.packetDocs / resolvePart (fixes B9.1/B9.2: cover letter must not be dropped)', () => {
  const svc = new ExportService({} as never, {} as never);
  const primary = { id: 'primary-id', name: 'White paper', body: { blocks: [] } };
  const cover = { id: 'cover-id', name: 'Cover letter', body: { blocks: [{ type: 'section' }] } };

  it('excludes the vestigial primary (lowest-ordinal) document', () => {
    const docs = (svc as unknown as { packetDocs: (d: unknown) => unknown[] }).packetDocs({
      documents: [primary, cover],
    });
    expect(docs).toEqual([cover]);
  });

  it("resolves part='all'/undefined to combined mode", () => {
    const resolve = (svc as unknown as { resolvePart: (d: unknown, p?: string) => unknown })
      .resolvePart;
    expect(resolve.call(svc, { documents: [primary, cover] }, undefined)).toEqual({ mode: 'all' });
    expect(resolve.call(svc, { documents: [primary, cover] }, 'all')).toEqual({ mode: 'all' });
  });

  it("resolves part='main' to main-only mode", () => {
    const resolve = (svc as unknown as { resolvePart: (d: unknown, p?: string) => unknown })
      .resolvePart;
    expect(resolve.call(svc, { documents: [primary, cover] }, 'main')).toEqual({ mode: 'main' });
  });

  it('resolves a genuine packet document id to standalone doc mode', () => {
    const resolve = (svc as unknown as { resolvePart: (d: unknown, p?: string) => unknown })
      .resolvePart;
    expect(resolve.call(svc, { documents: [primary, cover] }, 'cover-id')).toEqual({
      mode: 'doc',
      doc: cover,
    });
  });

  it('404s for the primary document id (never exposed as a packet doc) and for an unknown id', () => {
    const resolve = (svc as unknown as { resolvePart: (d: unknown, p?: string) => unknown })
      .resolvePart;
    expect(() => resolve.call(svc, { documents: [primary, cover] }, 'primary-id')).toThrow(
      NotFoundException,
    );
    expect(() => resolve.call(svc, { documents: [primary, cover] }, 'nope')).toThrow(
      NotFoundException,
    );
  });
});
