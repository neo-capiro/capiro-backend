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
});
