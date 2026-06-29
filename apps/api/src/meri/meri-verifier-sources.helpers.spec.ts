import {
  GROUNDING_CHARS,
  buildVerifierSources,
  extractGroundingFromToolResult,
  serializeRecordForGrounding,
} from './meri-verifier-sources.helpers.js';
import type { MeriCitation } from './meri-citations.helpers.js';

describe('serializeRecordForGrounding', () => {
  it('preserves budget numbers and per-FY rows (the data the verifier needs)', () => {
    const pe = {
      peCode: '0604041F',
      title: 'Family of Affordable Mass Missiles',
      appropriationType: 'RDT&E',
      years: [
        { fy: 2027, request: 525_220_000, hascMark: 472_700_000 },
        { fy: 2026, enacted: 0 },
      ],
    };
    const g = serializeRecordForGrounding(pe);
    expect(g).toContain('0604041F');
    expect(g).toContain('Family of Affordable Mass Missiles');
    expect(g).toContain('RDT&E');
    expect(g).toContain('525220000'); // the request figure is now present
    expect(g).toContain('472700000'); // the HASC mark is now present
    expect(g).toContain('fy=2027');
  });

  it('truncates to the grounding budget', () => {
    const big = { title: 'x', blob: 'y'.repeat(5000) };
    expect(serializeRecordForGrounding(big).length).toBeLessThanOrEqual(GROUNDING_CHARS);
  });

  it('handles non-object input', () => {
    expect(serializeRecordForGrounding(null)).toBe('');
    expect(serializeRecordForGrounding('hello')).toBe('hello');
  });
});

describe('extractGroundingFromToolResult — numbering mirrors citations', () => {
  it('numbers titled rows from startN, skipping titleless rows', () => {
    const payload = {
      data: [
        { title: 'PE A', request: 100 },
        { noTitle: true }, // skipped (no title) — mirrors citation extractor
        { name: 'PE B', request: 200 },
      ],
    };
    const g = extractGroundingFromToolResult(payload, 1);
    // Row 1 -> n=1, titleless skipped, row "PE B" -> n=2 (citation extractor
    // skips the same titleless row, so [2] aligns to PE B in both).
    expect(g.has(1)).toBe(true);
    expect(g.get(1)).toContain('PE A');
    expect(g.has(2)).toBe(true);
    expect(g.get(2)).toContain('PE B');
  });

  it('returns empty for errors / empty / non-object', () => {
    expect(extractGroundingFromToolResult({ error: 'boom' }, 1).size).toBe(0);
    expect(extractGroundingFromToolResult({ data: [] }, 1).size).toBe(0);
    expect(extractGroundingFromToolResult(null, 1).size).toBe(0);
  });

  it('respects maxPerTool', () => {
    const payload = { results: Array.from({ length: 10 }, (_, i) => ({ title: `T${i}` })) };
    expect(extractGroundingFromToolResult(payload, 1, 3).size).toBe(3);
  });
});

describe('buildVerifierSources — the actual fix', () => {
  const citations: MeriCitation[] = [
    { n: 1, type: 'source', id: '', title: 'FAMM PE 0604041F', url: null, snippet: 'thin stub', tool: 'get_program_element' },
    { n: 2, type: 'source', id: '', title: 'ACP PE 0207179F', url: null, snippet: 'thin stub 2', tool: 'get_program_element' },
  ];

  it('replaces thin snippets with rich grounding when available', () => {
    const grounding = new Map<number, string>([
      [1, 'peCode: 0604041F | request: 525220000 | hascMark: 472700000'],
    ]);
    const sources = buildVerifierSources(citations, grounding);
    expect(sources[0]?.snippet).toContain('525220000'); // rich grounding used
    expect(sources[1]?.snippet).toBe('thin stub 2'); // falls back when no grounding
    expect(sources[0]?.n).toBe(1);
    expect(sources[0]?.title).toBe('FAMM PE 0604041F');
  });

  it('REGRESSION: with rich grounding, the Perseus FY27 numbers are now in the source list', () => {
    // This is the exact failure mode from chat.txt: the verifier flagged
    // "18 of 18 claims aren't backed" because the dollar figures were absent
    // from the source list. With buildVerifierSources, they are present.
    const grounding = new Map<number, string>([
      [1, serializeRecordForGrounding({
        peCode: '0604041F', title: 'Family of Affordable Mass Missiles',
        years: [{ fy: 2027, request: 525_220_000, hascMark: 472_700_000 }],
      })],
      [2, serializeRecordForGrounding({
        peCode: '0207179F', title: 'Autonomous Collaborative Platforms', appropriationType: 'RDT&E',
        years: [{ fy: 2027, request: 57_220_000, hascMark: 51_500_000 }],
      })],
    ]);
    const sources = buildVerifierSources(citations, grounding);
    const blob = sources.map((s) => s.snippet).join(' ');
    for (const fig of ['525220000', '472700000', '57220000', '51500000']) {
      expect(blob).toContain(fig);
    }
    expect(blob).toContain('RDT&E');
  });
});
