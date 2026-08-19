/**
 * Regression coverage for the double-encoded article title/summary bug:
 * /explorer?source=articles (canonical) and os.capiro.ai/explorer (News Feed)
 * both rendered raw HTML entities — e.g. a title containing literal
 * "&#8216;" and a summary containing literal "&lt;p&gt;President &lt;a
 * href=...". Root cause: extractText() stripped HTML tags via regex but
 * never decoded entities, so escaped markup in <description> never matched
 * the strip regex, and numeric/named entities in <title> passed through
 * untouched. Fixtures below are shaped like real feed items (2026-08-18).
 */
import { decodeEntities, extractText, extractCategories } from './sync-rss-intel';

describe('decodeEntities', () => {
  it('decodes named XML/HTML entities', () => {
    expect(decodeEntities('Fish &amp; Wildlife')).toBe('Fish & Wildlife');
    expect(decodeEntities('&lt;p&gt;')).toBe('<p>');
    expect(decodeEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeEntities('it&apos;s')).toBe("it's");
  });

  it('decodes numeric decimal character references (smart quotes)', () => {
    expect(decodeEntities('&#8216;big beautiful bill&#8217;')).toBe('‘big beautiful bill’');
  });

  it('decodes numeric hex character references', () => {
    expect(decodeEntities('&#x2019;')).toBe('’');
  });

  it('leaves malformed/unknown entities untouched instead of corrupting them', () => {
    expect(decodeEntities('Q&A session')).toBe('Q&A session');
    expect(decodeEntities('&foobar;')).toBe('&foobar;');
  });
});

describe('extractText', () => {
  it('decodes numeric entities in a plain (non-CDATA) title', () => {
    const item = `<title>Trump&#8217;s &#8216;big beautiful bill&#8217; heads to Senate</title>`;
    expect(extractText(item, 'title')).toBe('Trump’s ‘big beautiful bill’ heads to Senate');
  });

  it('decodes entity-escaped markup in <description> and strips the resulting tags', () => {
    const item =
      `<description>&lt;p&gt;President &lt;a href="https://example.com/biden"&gt;Biden&lt;/a&gt; announced new sanctions today.&lt;/p&gt;</description>`;
    const result = extractText(item, 'description');
    expect(result).toBe('President Biden announced new sanctions today.');
    expect(result).not.toMatch(/&lt;|&gt;|&amp;/);
    expect(result).not.toMatch(/<[^>]+>/);
  });

  it('strips real HTML tags from a CDATA-wrapped description (not just entity-escaped ones)', () => {
    const item = `<description><![CDATA[<p>Update on <a href="https://example.com">the bill</a>.</p>]]></description>`;
    expect(extractText(item, 'description')).toBe('Update on the bill .');
  });

  it('returns null for a missing tag', () => {
    expect(extractText('<title>Only a title</title>', 'description')).toBeNull();
  });
});

describe('extractCategories', () => {
  it('decodes entities inside category names', () => {
    const item = `<category>Foreign Affairs &amp; Trade</category><category>Defense</category>`;
    expect(extractCategories(item)).toEqual(['Foreign Affairs & Trade', 'Defense']);
  });
});
