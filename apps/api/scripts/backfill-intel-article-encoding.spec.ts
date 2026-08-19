import { computeArticleEncodingFix } from './backfill-intel-article-encoding';

describe('computeArticleEncodingFix', () => {
  it('decodes a title with a literal numeric entity and flags it as changed', () => {
    const fix = computeArticleEncodingFix(
      'Trump&#8217;s &#8216;big beautiful bill&#8217; heads to Senate',
      null,
    );
    expect(fix.cleanTitle).toBe('Trump’s ‘big beautiful bill’ heads to Senate');
    expect(fix.changed).toBe(true);
  });

  it('decodes and de-tags a summary that stored escaped markup', () => {
    const fix = computeArticleEncodingFix(
      'Clean title',
      '&lt;p&gt;President &lt;a href="https://example.com/biden"&gt;Biden&lt;/a&gt; announced new sanctions today.&lt;/p&gt;',
    );
    expect(fix.cleanSummary).toBe('President Biden announced new sanctions today.');
    expect(fix.changed).toBe(true);
  });

  it('is a no-op (changed: false) for an already-clean row, so re-runs are safe', () => {
    const fix = computeArticleEncodingFix('Clean title', 'Clean summary.');
    expect(fix).toEqual({ cleanTitle: 'Clean title', cleanSummary: 'Clean summary.', changed: false });
  });

  it('treats a null summary as unchanged', () => {
    const fix = computeArticleEncodingFix('Clean title', null);
    expect(fix.cleanSummary).toBeNull();
    expect(fix.changed).toBe(false);
  });
});
