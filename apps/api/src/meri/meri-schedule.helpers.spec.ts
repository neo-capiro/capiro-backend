import {
  computeNextRunAt,
  computeNextRunAtAnchored,
  computeNextScheduledRun,
  describeScheduleCadence,
  parseScheduleLocalAnchor,
  readScheduleLocalAnchor,
  DEFAULT_SCHEDULED_TOOL_ALLOWLIST,
  isAllowListSafe,
  isDue,
  MAX_TASKS_PER_TENANT,
  MIN_INTERVAL_MINUTES,
  normalizeInterval,
  validateAllowList,
  validateScheduleRequest,
} from './meri-schedule.helpers.js';

describe('clio-schedule helpers (W3)', () => {
  describe('normalizeInterval', () => {
    it('rejects intervals below the minimum', () => {
      expect(normalizeInterval(30)).toBeNull();
      expect(normalizeInterval(MIN_INTERVAL_MINUTES - 1)).toBeNull();
      expect(normalizeInterval('abc')).toBeNull();
    });
    it('accepts and floors valid intervals', () => {
      expect(normalizeInterval(60)).toBe(60);
      expect(normalizeInterval(90.7)).toBe(90);
    });
    it('caps very large intervals', () => {
      expect(normalizeInterval(99_999_999)).toBe(60 * 24 * 30);
    });
  });

  describe('validateAllowList', () => {
    it('defaults to the read-only research allow-list when empty', () => {
      const r = validateAllowList([]);
      expect(r.ok).toBe(true);
      expect(r.allowList).toEqual([...DEFAULT_SCHEDULED_TOOL_ALLOWLIST]);
    });
    it('REJECTS any side-effecting tool (no unattended email/writes)', () => {
      expect(validateAllowList(['search_congress_bills', 'send_email']).ok).toBe(false);
      expect(validateAllowList(['save_memory']).ok).toBe(false);
      expect(validateAllowList(['create_word']).ok).toBe(false);
      expect(validateAllowList(['save_chat_attachments']).ok).toBe(false);
    });
    it('keeps only known read-only tools', () => {
      const r = validateAllowList(['search_congress_bills', 'not_a_real_tool']);
      expect(r.ok).toBe(true);
      expect(r.allowList).toEqual(['search_congress_bills']);
    });
  });

  describe('isAllowListSafe', () => {
    it('is true for read-only tools and false if any side-effect leaks in', () => {
      expect(isAllowListSafe(['search_congress_bills', 'query_intelligence'])).toBe(true);
      expect(isAllowListSafe(['search_congress_bills', 'send_email'])).toBe(false);
      expect(isAllowListSafe(['save_chat_attachments'])).toBe(false);
    });
  });

  describe('computeNextRunAt + isDue', () => {
    it('advances by the interval', () => {
      const base = new Date('2026-06-09T00:00:00Z');
      expect(computeNextRunAt(base, 60).toISOString()).toBe('2026-06-09T01:00:00.000Z');
    });
    it('is due only when enabled and nextRunAt has passed', () => {
      const now = new Date('2026-06-09T12:00:00Z');
      expect(isDue({ enabled: true, nextRunAt: new Date('2026-06-09T11:59:00Z') }, now)).toBe(true);
      expect(isDue({ enabled: true, nextRunAt: new Date('2026-06-09T12:01:00Z') }, now)).toBe(false);
      expect(isDue({ enabled: false, nextRunAt: new Date('2026-06-09T11:00:00Z') }, now)).toBe(false);
    });
  });

  describe('validateScheduleRequest', () => {
    const base = { name: 'Weekly brief', prompt: 'Summarize new bills', intervalMinutes: 1440, existingTaskCount: 0 };
    it('accepts a valid read-only schedule', () => {
      const r = validateScheduleRequest(base);
      expect(r.ok).toBe(true);
      expect(r.intervalMinutes).toBe(1440);
      expect(r.allowList).toEqual([...DEFAULT_SCHEDULED_TOOL_ALLOWLIST]);
    });
    it('rejects when the tenant task cap is reached', () => {
      expect(validateScheduleRequest({ ...base, existingTaskCount: MAX_TASKS_PER_TENANT }).ok).toBe(false);
    });
    it('rejects missing name/prompt and bad interval', () => {
      expect(validateScheduleRequest({ ...base, name: '' }).ok).toBe(false);
      expect(validateScheduleRequest({ ...base, prompt: '' }).ok).toBe(false);
      expect(validateScheduleRequest({ ...base, intervalMinutes: 5 }).ok).toBe(false);
    });
    it('rejects a side-effecting tool in the requested allow-list', () => {
      expect(validateScheduleRequest({ ...base, toolAllowList: ['send_email'] }).ok).toBe(false);
    });
  });
});

describe('local wall-clock schedules (Release E, T10)', () => {
  const monday8 = { localTime: '08:00', timeZone: 'America/New_York', weekday: 1 };

  it('runs "every Monday at 8" at 8:00 Eastern on Mondays, not on the creation weekday', () => {
    // Created on a Wednesday afternoon (EDT, UTC-4).
    const from = new Date('2026-10-07T18:00:00.000Z');
    expect(computeNextScheduledRun(from, 10080, null, monday8).toISOString()).toBe(
      '2026-10-12T12:00:00.000Z',
    );
  });

  it('keeps 8:00 local across the end of daylight saving time', () => {
    // US DST ends Sunday 2026-11-01; Monday 8:00 EST is 13:00Z.
    const from = new Date('2026-10-30T15:00:00.000Z');
    expect(computeNextScheduledRun(from, 10080, null, monday8).toISOString()).toBe(
      '2026-11-02T13:00:00.000Z',
    );
  });

  it('moves to the next Monday once this Monday’s time has passed', () => {
    const from = new Date('2026-10-12T12:30:00.000Z'); // Monday 08:30 EDT
    expect(computeNextScheduledRun(from, 10080, null, monday8).toISOString()).toBe(
      '2026-10-19T12:00:00.000Z',
    );
  });

  it('runs daily at the local time, today if it is still ahead', () => {
    const daily = { localTime: '08:00', timeZone: 'America/New_York', weekday: null };
    expect(
      computeNextScheduledRun(new Date('2026-10-07T11:00:00.000Z'), 1440, null, daily).toISOString(),
    ).toBe('2026-10-07T12:00:00.000Z');
    expect(
      computeNextScheduledRun(new Date('2026-10-07T13:00:00.000Z'), 1440, null, daily).toISOString(),
    ).toBe('2026-10-08T12:00:00.000Z');
  });

  it('without a local anchor behaves exactly as before', () => {
    const from = new Date('2026-10-07T14:05:00.000Z');
    expect(computeNextScheduledRun(from, 1440, 480, null)).toEqual(
      computeNextRunAtAnchored(from, 1440, 480),
    );
  });

  it('validates the anchor against the cadence', () => {
    expect(parseScheduleLocalAnchor({ localTime: '8:00', weekday: 'Monday' }, 10080)).toEqual({
      localTime: '08:00',
      timeZone: 'America/New_York',
      weekday: 1,
    });
    expect(parseScheduleLocalAnchor({}, 10080)).toBeNull();
    expect(parseScheduleLocalAnchor({ localTime: '08:00' }, 10080)).toEqual({
      error: 'A weekly schedule with a local time needs a weekday.',
    });
    expect(parseScheduleLocalAnchor({ localTime: '08:00', weekday: 'mon' }, 1440)).toEqual({
      error: 'A daily schedule cannot name a weekday.',
    });
    expect(parseScheduleLocalAnchor({ localTime: '08:00' }, 60)).toEqual({
      error: 'A local time needs a daily (1440) or weekly (10080) interval.',
    });
    expect(parseScheduleLocalAnchor({ localTime: '08:00', timeZone: 'Mars/Base' }, 1440)).toEqual({
      error: 'timeZone must be an IANA time zone, e.g. "America/New_York".',
    });
    expect(parseScheduleLocalAnchor({ localTime: '25:00' }, 1440)).toEqual({
      error: 'localTime must be "HH:MM" in 24h form.',
    });
  });

  it('reads a stored anchor and describes the cadence for the proposal card', () => {
    expect(readScheduleLocalAnchor({ localTime: '08:00', timeZone: 'America/New_York', weekday: 1 })).toEqual(
      monday8,
    );
    expect(readScheduleLocalAnchor({ runAtMinutesUtc: 480 })).toBeNull();
    expect(describeScheduleCadence(10080, monday8)).toBe('Mondays at 08:00 (America/New_York)');
    expect(describeScheduleCadence(1440, null)).toBe('Every day');
  });
});

