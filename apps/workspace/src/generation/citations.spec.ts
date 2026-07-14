import {
  applyCitations,
  buildCitationCorpus,
  ctxCitationToken,
  peCitationToken,
} from './citations';

const corpus = buildCitationCorpus(
  [{ peCode: '0603851F', title: 'Space Tech Dev', groundingText: 'PE 0603851F request $72.1M' }],
  [{ id: 'ctx-abc-123', label: 'FY26 approps memo', body: 'The HAC-D mark added $10M.' }],
);
const labels = {
  pe: new Map([['0603851F', '0603851F — Space Tech Dev']]),
  ctx: new Map([['ctx-abc-123', 'FY26 approps memo']]),
};

describe('workspace claim-level citations (Tier-1, §6.2)', () => {
  it('valid tokens become numbered <sup> markers with a citation map', () => {
    const html = `<p>The FY26 request is $72.1M ${peCitationToken('0603851F')}. The mark added $10M ${ctxCitationToken('ctx-abc-123')}.</p>`;
    const r = applyCitations(html, corpus, labels);
    expect(r.html).toContain('<sup>[1]</sup>');
    expect(r.html).toContain('<sup>[2]</sup>');
    expect(r.html).not.toContain('[S:');
    expect(r.citations).toEqual([
      {
        n: 1,
        token: '[S:pe:0603851F]',
        kind: 'pe',
        refId: '0603851F',
        label: '0603851F — Space Tech Dev',
      },
      {
        n: 2,
        token: '[S:ctx:ctx-abc-123]',
        kind: 'ctx',
        refId: 'ctx-abc-123',
        label: 'FY26 approps memo',
      },
    ]);
    expect(r.invalidTokens).toEqual([]);
  });

  it('an invented token is STRIPPED and reported, never rendered', () => {
    const html = `<p>Enacted at $99M [S:pe:9999999Z].</p>`;
    const r = applyCitations(html, corpus, labels);
    expect(r.html).not.toContain('[S:');
    expect(r.html).not.toContain('<sup>');
    expect(r.invalidTokens).toEqual(['[S:pe:9999999Z]']);
  });

  it('repeated citations of the same source share one footnote number', () => {
    const t = peCitationToken('0603851F');
    const html = `<p>Request $72.1M ${t}. Still $72.1M ${t}.</p>`;
    const r = applyCitations(html, corpus, labels);
    expect(r.citations).toHaveLength(1);
    expect(r.html.match(/<sup>\[1\]<\/sup>/g)).toHaveLength(2);
  });

  it('content with no tokens passes through untouched', () => {
    const html = '<p>General narrative with no factual citations.</p>';
    const r = applyCitations(html, corpus, labels);
    expect(r).toEqual({ html, citations: [], invalidTokens: [] });
  });
});
