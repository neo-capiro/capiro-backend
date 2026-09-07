import { describe, expect, it } from '@jest/globals';
import { MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT } from '@capiro/meriv2-core';
import {
  assembleReportArtifact,
  buildPlanSystemPrompt,
  buildPlanUserPrompt,
  buildResearchSystemPrompt,
  buildResearchUserPrompt,
  clampTitle,
  dedupeSources,
  escapeHtml,
  extractFirstJsonObject,
  formatClarifyingQa,
  markdownToHtml,
  parsePlanProposal,
  renderReportToBrowserHtml,
  renderReportToWordHtml,
  sanitizeStringList,
  MAX_CLARIFYING_QUESTIONS,
  MAX_PLAN_ITEMS,
  MAX_TITLE_CHARS,
} from './meri-research.helpers.js';

describe('clio-research helpers', () => {
  describe('clampTitle', () => {
    it('collapses whitespace and keeps short titles', () => {
      expect(clampTitle('  Hello   world ')).toBe('Hello world');
    });
    it('truncates with an ellipsis past the cap', () => {
      const long = 'x'.repeat(MAX_TITLE_CHARS + 50);
      const out = clampTitle(long);
      expect(out.length).toBe(MAX_TITLE_CHARS);
      expect(out.endsWith('…')).toBe(true);
    });
    it('falls back when empty', () => {
      expect(clampTitle('   ')).toBe('Research report');
    });
  });

  describe('sanitizeStringList', () => {
    it('returns [] for non-arrays', () => {
      expect(sanitizeStringList('nope', 5)).toEqual([]);
      expect(sanitizeStringList(null, 5)).toEqual([]);
    });
    it('drops non-strings and blanks, trims, and caps', () => {
      const input = ['  a ', 2, '', 'b', null, 'c', 'd', 'e', 'f'];
      expect(sanitizeStringList(input, 3)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('extractFirstJsonObject', () => {
    it('extracts a fenced JSON object', () => {
      const raw = 'Here:\n```json\n{"a":1,"b":"x"}\n```\nthanks';
      expect(extractFirstJsonObject(raw)).toBe('{"a":1,"b":"x"}');
    });
    it('handles nested braces and strings with braces', () => {
      const raw = 'prefix {"a":{"b":"}{"},"c":2} suffix';
      expect(extractFirstJsonObject(raw)).toBe('{"a":{"b":"}{"},"c":2}');
    });
    it('returns null when no object present', () => {
      expect(extractFirstJsonObject('no json here')).toBeNull();
      expect(extractFirstJsonObject('')).toBeNull();
    });
  });

  describe('parsePlanProposal', () => {
    it('parses a well-formed proposal and clamps lists', () => {
      const plan = Array.from({ length: MAX_PLAN_ITEMS + 3 }, (_, i) => `step ${i}`);
      const qs = Array.from({ length: MAX_CLARIFYING_QUESTIONS + 2 }, (_, i) => `q ${i}`);
      const raw = JSON.stringify({ title: 'NDAA EW funding', plan, clarifyingQuestions: qs });
      const out = parsePlanProposal(raw, 'topic');
      expect(out.title).toBe('NDAA EW funding');
      expect(out.plan).toHaveLength(MAX_PLAN_ITEMS);
      expect(out.clarifyingQuestions).toHaveLength(MAX_CLARIFYING_QUESTIONS);
    });
    it('falls back to a safe plan on garbage input', () => {
      const out = parsePlanProposal('not json at all', 'My Topic');
      expect(out.title).toBe('My Topic');
      expect(out.plan.length).toBeGreaterThan(0);
      expect(out.clarifyingQuestions).toEqual([]);
    });
    it('falls back fields individually when partially present', () => {
      const raw = JSON.stringify({ title: '', plan: [], clarifyingQuestions: ['only q'] });
      const out = parsePlanProposal(raw, 'Topic X');
      expect(out.title).toBe('Topic X'); // empty title -> fallback
      expect(out.plan.length).toBeGreaterThan(0); // empty plan -> fallback
      expect(out.clarifyingQuestions).toEqual(['only q']);
    });
    it('preserves an explicit empty clarification list for a context-complete request', () => {
      const out = parsePlanProposal(JSON.stringify({
        title: 'Client board briefing',
        plan: ['Use the selected strategy and earlier attachment to recommend the next step'],
        clarifyingQuestions: [],
      }), 'Prepare the agreed briefing');
      expect(out.clarifyingQuestions).toEqual([]);
      expect(out.plan).toEqual(['Use the selected strategy and earlier attachment to recommend the next step']);
    });
    it('does not manufacture missing client or scope questions from an invalid list', () => {
      const out = parsePlanProposal(JSON.stringify({
        title: 'Briefing', plan: ['Verify the current source'], clarifyingQuestions: [null, 12, '  '],
      }), 'Prepare the agreed briefing');
      expect(out.clarifyingQuestions).toEqual([]);
    });
    it('tolerates JSON wrapped in prose + fences', () => {
      const raw = 'Sure!\n```json\n{"title":"T","plan":["a","b","c","d"],"clarifyingQuestions":["x","y","z"]}\n```';
      const out = parsePlanProposal(raw, 'fallback');
      expect(out.title).toBe('T');
      expect(out.plan).toEqual(['a', 'b', 'c', 'd']);
    });
  });

  describe('formatClarifyingQa', () => {
    it('pairs answered questions and skips blanks/missing', () => {
      const out = formatClarifyingQa(
        ['Scope?', 'Client?', 'Deadline?'],
        { '0': 'Federal', '1': '   ', '2': 'Friday' },
      );
      expect(out).toContain('Q: Scope?\nA: Federal');
      expect(out).toContain('Q: Deadline?\nA: Friday');
      expect(out).not.toContain('Client?');
    });
    it('returns empty string when nothing answered', () => {
      expect(formatClarifyingQa(['a', 'b'], {})).toBe('');
    });
  });

  describe('dedupeSources', () => {
    it('dedupes by label+summary, drops nameless, formats', () => {
      const out = dedupeSources([
        { tool: 'search_lda_filings', label: 'LDA Filings', summary: '12 results' },
        { label: 'LDA Filings', summary: '12 results' }, // dup
        { summary: 'no name' }, // dropped
        { tool: 'search_congress_bills', label: 'Congress Bills' },
      ]);
      expect(out).toEqual([
        'LDA Filings — 12 results',
        'Congress Bills',
      ]);
    });
  });

  describe('assembleReportArtifact', () => {
    it('exports canonical citation numbers and excerpts instead of generic tool receipts', () => {
      const md = assembleReportArtifact({
        title: 'Brief', topic: 'Client objective', plan: [], reportBody: 'Client fact [7].',
        sources: [{ label: 'Read attachment', summary: 'Source retrieved; see cited evidence.' }],
        citations: [{ n: 7, id: 'attachment-1', title: 'Earlier brief.txt',
          snippet: 'The client requires an industry lead.', url: null,
          type: 'source', tool: 'get_research_evidence' }],
        generatedAt: new Date('2026-09-07T00:00:00Z'),
      });
      expect(md).toContain('- [7] Earlier brief.txt — The client requires an industry lead.');
      expect(md).not.toContain('Source retrieved; see cited evidence.');
    });

    it('builds header, body, and a sources footer', () => {
      const md = assembleReportArtifact({
        title: 'EW Budget Outlook',
        topic: 'Electronic warfare RDT&E funding',
        plan: ['a', 'b'],
        reportBody: '## Executive Summary\n- point',
        sources: [{ label: 'GAO', summary: '2 reports' }, { label: 'GAO', summary: '2 reports' }],
        generatedAt: new Date('2026-05-30T12:00:00Z'),
      });
      expect(md).toContain('# EW Budget Outlook');
      expect(md).toContain('generated 2026-05-30');
      expect(md).toContain('**Topic:** Electronic warfare RDT&E funding');
      expect(md).toContain('## Executive Summary');
      expect(md).toContain('## Sources consulted');
      expect(md).toContain('- GAO — 2 reports');
      // de-duped: only one GAO line
      expect(md.match(/GAO — 2 reports/g)).toHaveLength(1);
    });
    it('handles an empty report body gracefully', () => {
      const md = assembleReportArtifact({
        title: 'T', topic: 'x', plan: [], reportBody: '   ', sources: [],
        generatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(md).toContain('_No report content was generated._');
      expect(md).not.toContain('## Sources consulted');
    });
  });

  describe('prompt builders', () => {
    it('plan system prompt names the product and demands JSON', () => {
      const p = buildPlanSystemPrompt('Meri');
      expect(p).toContain('Meri');
      expect(p).toContain('clarifyingQuestions');
      expect(p).toContain('JSON');
      expect(p).toContain('0-6 material questions');
      expect(p).toContain('Put retrievable');
      expect(p).not.toContain('3-6 questions');
    });
    it('plan user prompt includes topic and optional client context', () => {
      expect(buildPlanUserPrompt('topic A', null)).toContain('topic A');
      const withCtx = buildPlanUserPrompt('topic A', 'Client: Acme');
      expect(withCtx).toContain('Client: Acme');
    });
    it('research system prompt requires citations and internal-first', () => {
      const p = buildResearchSystemPrompt('Meri');
      expect(p.toLowerCase()).toContain('cite');
      expect(p.toLowerCase()).toContain('internal data tools first');
      expect(p).toContain('Recommended Actions');
      expect(p).toContain(MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT);
      expect(p).toContain('admitted in its governed context');
      const chatAddendum = buildResearchSystemPrompt('Meri', { inheritChatOutputContract: true });
      expect(chatAddendum).not.toContain(MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT);
      expect(chatAddendum).toContain('REPORT REQUIREMENTS:');
      expect(chatAddendum).toContain('Recommended Actions');
      expect(chatAddendum).toContain('admitted in its governed context');
    });
    it('research user prompt threads plan + clarifications', () => {
      const u = buildResearchUserPrompt({
        topic: 'EW funding',
        plan: ['status', 'players'],
        clarifyingQuestions: ['Scope?'],
        clarifyingAnswers: { '0': 'Federal' },
        clientContext: 'Client: Acme Defense',
      });
      expect(u).toContain('EW funding');
      expect(u).toContain('1. status');
      expect(u).toContain('Client: Acme Defense');
      expect(u).toContain('Q: Scope?\nA: Federal');
    });
  });

  describe('escapeHtml + markdownToHtml', () => {
    it('escapes html-significant characters', () => {
      expect(escapeHtml('<b>&"\'/')).toBe('&lt;b&gt;&amp;&quot;&#x27;&#x2F;');
    });
    it('renders headings, bold, lists, rules, and links', () => {
      const md = [
        '# Title',
        '',
        'Intro **bold** and `code`.',
        '',
        '## Section',
        '- one',
        '- two',
        '',
        '1. first',
        '2. second',
        '',
        '---',
        '',
        'See [Congress](https://congress.gov/bill) for detail.',
      ].join('\n');
      const html = markdownToHtml(md);
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<code>code</code>');
      expect(html).toContain('<h2>Section</h2>');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>one</li>');
      expect(html).toContain('<ol>');
      expect(html).toContain('<li>first</li>');
      expect(html).toContain('<hr />');
      expect(html).toContain('<a href="https://congress.gov/bill"');
    });
    it('never emits raw injected markup', () => {
      const html = markdownToHtml('Hello <script>alert(1)</script> world');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
    it('rejects non-http link protocols (no javascript: hrefs)', () => {
      const html = markdownToHtml('[x](javascript:alert(1))');
      expect(html).not.toContain('href="javascript');
    });
    it('renders a GFM pipe table as a real <table>', () => {
      const md = [
        '| Program | FY2027 |',
        '| --- | ---: |',
        '| Aircraft | 291.4 |',
        '| Missiles | 88.0 |',
      ].join('\n');
      const html = markdownToHtml(md);
      expect(html).toContain('<table>');
      expect(html).toContain('<thead>');
      expect(html).toContain('<th>Program</th>');
      expect(html).toContain('<th>FY2027</th>');
      expect(html).toContain('<td>Aircraft</td>');
      expect(html).toContain('<td>291.4</td>');
      expect(html).toContain('<td>Missiles</td>');
      // raw pipes must not leak into the output
      expect(html).not.toContain('| Aircraft |');
    });
    it('keeps surrounding prose when a table is embedded', () => {
      const md = ['Intro line.', '', '| A | B |', '| - | - |', '| 1 | 2 |', '', 'Outro line.'].join(
        '\n',
      );
      const html = markdownToHtml(md);
      expect(html).toContain('<p>Intro line.</p>');
      expect(html).toContain('<table>');
      expect(html).toContain('<td>1</td>');
      expect(html).toContain('<p>Outro line.</p>');
    });
    it('escapes html inside table cells (no injection via tables)', () => {
      const md = ['| Col |', '| --- |', '| <script>x</script> |'].join('\n');
      const html = markdownToHtml(md);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });

  describe('renderReportToWordHtml', () => {
    it('produces a Word-namespaced doc with the title and rendered body', () => {
      const out = renderReportToWordHtml({ title: 'EW Outlook', markdown: '# EW Outlook\n\n- point' });
      expect(out).toContain('urn:schemas-microsoft-com:office:word');
      expect(out).toContain('<title>EW Outlook</title>');
      expect(out).toContain('<h1>EW Outlook</h1>');
      expect(out).toContain('<li>point</li>');
    });
  });

  describe('renderReportToBrowserHtml', () => {
    it('produces a branded standalone page (Meri header, no Capiro)', () => {
      const out = renderReportToBrowserHtml({ title: 'EW Outlook', markdown: '## Summary\n\ntext' });
      expect(out).toContain('<!DOCTYPE html>');
      expect(out).toContain('>Meri<');
      expect(out).toContain('Deep Research');
      expect(out).toContain('<h2>Summary</h2>');
      expect(out.toLowerCase()).not.toContain('capiro');
    });
  });
});
