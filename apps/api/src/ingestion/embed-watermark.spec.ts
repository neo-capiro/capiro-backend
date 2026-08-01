import {
  embedSyncSource,
  resolveSinceWindow,
  statusFromCounts,
  type RunCounts,
} from './embed-watermark.js';

describe('embed-backfill watermark helpers (Phase 1)', () => {
  describe('embedSyncSource', () => {
    test('namespaces the SyncRun source per embedding kind', () => {
      expect(embedSyncSource('lda')).toBe('embed:lda');
      expect(embedSyncSource('bills')).toBe('embed:bills');
      expect(embedSyncSource('capabilities')).toBe('embed:capabilities');
    });
  });

  describe('resolveSinceWindow', () => {
    test('explicit --since always wins over the watermark', () => {
      const wm = new Date('2025-01-01T00:00:00.000Z');
      expect(resolveSinceWindow('2026-03-15', wm)).toBe('2026-03-15');
    });

    test('falls back to the last successful run start (autonomous incremental)', () => {
      const wm = new Date('2026-05-30T14:23:00.000Z');
      expect(resolveSinceWindow(undefined, wm)).toBe('2026-05-30');
    });

    test('returns undefined (full backfill) when there is no prior run', () => {
      expect(resolveSinceWindow(undefined, null)).toBeUndefined();
    });

    test('explicit since wins even when no prior run exists', () => {
      expect(resolveSinceWindow('2024-01-01', null)).toBe('2024-01-01');
    });
  });

  describe('statusFromCounts', () => {
    const base: RunCounts = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

    test('clean run is success', () => {
      expect(statusFromCounts({ ...base, inserted: 10 })).toBe('success');
    });

    test('any errors downgrade to success_with_errors', () => {
      expect(statusFromCounts({ ...base, inserted: 10, errors: 1 })).toBe('success_with_errors');
    });

    test('incomplete wins over the error count and records partial', () => {
      expect(statusFromCounts({ ...base, complete: false, errors: 0 })).toBe('partial');
      expect(statusFromCounts({ ...base, complete: false, errors: 3 })).toBe('partial');
    });
  });
});
