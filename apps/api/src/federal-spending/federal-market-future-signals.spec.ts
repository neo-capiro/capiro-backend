import {
  isActiveForecastFlag,
  isUpcomingForecastDate,
  rankFutureSignalsByDate,
  readableMarketTitle,
} from './federal-market-future-signals.js';

describe('federal market upcoming signal helpers', () => {
  it('strips provider HTML so forecast titles render as plain text', () => {
    expect(readableMarketTitle('Army autonomy<br />acquisition & sustainment')).toBe(
      'Army autonomy acquisition & sustainment',
    );
  });

  it('excludes past anticipated award dates and keeps unknown dates eligible', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    expect(isUpcomingForecastDate('2022-04-30', now)).toBe(false);
    expect(isUpcomingForecastDate('2026-09-10', now)).toBe(true);
    expect(isUpcomingForecastDate('2027-01-01', now)).toBe(true);
    expect(isUpcomingForecastDate(null, now)).toBe(true);
  });

  it('excludes only explicitly inactive forecasts', () => {
    expect(isActiveForecastFlag(false)).toBe(false);
    expect(isActiveForecastFlag(true)).toBe(true);
    expect(isActiveForecastFlag(null)).toBe(true);
  });

  it('ranks SAM and forecast rows together by date before any preview truncate', () => {
    const ranked = rankFutureSignalsByDate([
      { id: 'forecast:old-shape', date: null },
      { id: 'sam:later', date: '2027-06-01' },
      { id: 'forecast:soon', date: '2026-10-01' },
      { id: 'sam:sooner', date: '2026-09-15' },
    ]);
    expect(ranked.map((row) => row.id)).toEqual([
      'sam:sooner',
      'forecast:soon',
      'sam:later',
      'forecast:old-shape',
    ]);
  });

  it('decodes valid numeric and hex entities', () => {
    expect(readableMarketTitle('&#72;ello &#x57;orld')).toBe('Hello World');
    expect(readableMarketTitle('R&D &#40;research&#41; budget')).toBe('R&D (research) budget');
    expect(readableMarketTitle('A &amp; B &lt;tag&gt;')).toBe('A & B <tag>');
    expect(readableMarketTitle('5 &gt; 3 &amp; 2 &lt; 4')).toBe('5 > 3 & 2 < 4');
  });

  it('passes out-of-range code points through instead of throwing', () => {
    // 0x110000 is one past the Unicode maximum; decoding must never throw.
    expect(() => readableMarketTitle('Opportunity &#x110000;')).not.toThrow();
    expect(readableMarketTitle('Opportunity &#x110000;')).toBe('Opportunity &#x110000;');
    expect(readableMarketTitle('Over &#1114113; limit')).toBe('Over &#1114113; limit');
    expect(readableMarketTitle('Negative &#x-1; stays')).toBe('Negative &#x-1; stays');
  });

  it('never resolves inherited properties as named entities', () => {
    // 'constructor' lives on Object.prototype — an own-property lookup must
    // reject it rather than interpolating the Object constructor function.
    expect(readableMarketTitle('Provider &constructor; notice')).toBe(
      'Provider &constructor; notice',
    );
    expect(readableMarketTitle('&hasOwnProperty; &toString; &valueOf;')).toBe(
      '&hasOwnProperty; &toString; &valueOf;',
    );
  });

  it('leaves malformed entity sequences untouched rather than mangling them', () => {
    expect(readableMarketTitle('AT&T&amp;T &unknown; &; &#; &#xZZ;')).toBe(
      'AT&T&T &unknown; &; &#; &#xZZ;',
    );
    expect(readableMarketTitle('no trailing amp &')).toBe('no trailing amp &');
  });

  it('strips line-break markup to a single space and collapses whitespace', () => {
    expect(readableMarketTitle('One<br>Two<BR/>Three<br />Four')).toBe('One Two Three Four');
    expect(readableMarketTitle('  padded&nbsp;&nbsp;text  ')).toBe('padded text');
  });
});
