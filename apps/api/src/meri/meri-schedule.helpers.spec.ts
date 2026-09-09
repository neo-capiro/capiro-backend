import {
  computeNextRunAt,
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
