import { describe, expect, test } from '@jest/globals';
import {
  googleSyncStateFields,
  googleSyncStateProblems,
  integrationConnectionProblems,
  integrationInventoryProblems,
} from './integration-smoke-state.js';

describe('integration smoke inventory and connection health', () => {
  test('requires at least one provider connection for a rollout smoke', () => {
    expect(integrationInventoryProblems(0)).toEqual([
      'no Google Workspace or Microsoft 365 connections found for this tenant',
    ]);
    expect(integrationInventoryProblems(1)).toEqual([]);
  });

  test('accepts a connected, canonically scoped connection with a refresh token', () => {
    expect(
      integrationConnectionProblems({
        status: 'connected',
        scopeMatch: true,
        hasRefreshToken: true,
        lastSyncAtPresent: true,
        lastError: null,
      }),
    ).toEqual([]);
  });

  test('reports every actionable connection-health defect', () => {
    expect(
      integrationConnectionProblems({
        status: 'error',
        scopeMatch: false,
        hasRefreshToken: false,
        lastSyncAtPresent: false,
        lastError: 'provider unavailable',
      }),
    ).toEqual([
      'connection status is error, expected connected',
      'stored OAuth scopes do not match canonical scopes',
      'refresh token envelope is missing or incomplete',
      'connection has never completed a sync (lastSyncAt is missing)',
      'lastError is set: provider unavailable',
    ]);
  });
});

describe('googleSyncStateFields', () => {
  test('extracts only the cursor fields needed by the read-only diagnostic', () => {
    expect(
      googleSyncStateFields({
        mail: {
          historyId: 'h1',
          incrementalPageToken: 'ip2',
          incrementalLatestHistoryId: 'h2',
          labels: { ALL: { backfillPageToken: null, backfillQuery: 'q' } },
        },
        calendar: {
          syncToken: 's1',
          pageToken: 'cp2',
          window: { from: 'from', to: 'to' },
        },
        token: { accessToken: 'must-not-be-read' },
      }),
    ).toEqual({
      mailHistoryId: 'h1',
      mailIncrementalPageToken: 'ip2',
      mailIncrementalLatestHistoryId: 'h2',
      mailBackfillPageToken: null,
      mailBackfillQuery: 'q',
      mailBackfillDone: null,
      calendarSyncTokenPresent: true,
      calendarPageToken: 'cp2',
      calendarWindow: { from: 'from', to: 'to' },
      calendarContinuationMode: 'ambiguous_legacy',
    });
  });
});

describe('googleSyncStateProblems', () => {
  test('accepts healthy steady, full-backfill, incremental, and Calendar continuation states', () => {
    const healthy = [
      googleSyncStateFields({}),
      googleSyncStateFields({
        mail: { labels: { ALL: { backfillPageToken: 'bp2', backfillQuery: 'frozen' } } },
      }),
      googleSyncStateFields({
        mail: {
          historyId: 'h1',
          incrementalPageToken: 'ip2',
          incrementalLatestHistoryId: 'h2',
        },
      }),
      googleSyncStateFields({
        calendar: { pageToken: 'cp2', window: { from: 'from', to: 'to' } },
      }),
      googleSyncStateFields({
        calendar: { syncToken: 'sync-1', pageToken: 'cp2' },
      }),
    ];

    for (const state of healthy) expect(googleSyncStateProblems(state)).toEqual([]);
  });

  test('rejects the Gmail hybrid state that can abandon an unfinished full backfill', () => {
    const fields = googleSyncStateFields({
      mail: {
        historyId: 'stale-history',
        incrementalPageToken: 'old-ip',
        incrementalLatestHistoryId: 'old-latest',
        labels: { ALL: { backfillPageToken: 'bp2' } },
      },
    });

    expect(googleSyncStateProblems(fields)).toEqual([
      'Gmail backfill page token has no frozen query',
      'Gmail full-backfill continuation still carries a stale historyId',
      'Gmail full-backfill continuation also carries incremental continuation state',
    ]);
  });

  test('rejects contradictory or stranded Gmail full-backfill bookkeeping', () => {
    expect(
      googleSyncStateProblems(
        googleSyncStateFields({
          mail: {
            labels: {
              ALL: {
                backfillPageToken: 'bp2',
                backfillQuery: 'frozen',
                backfillDone: true,
              },
            },
          },
        }),
      ),
    ).toEqual(['Gmail backfill page token is incorrectly marked complete']);

    expect(
      googleSyncStateProblems(
        googleSyncStateFields({ mail: { labels: { ALL: { backfillDone: false } } } }),
      ),
    ).toEqual(['Gmail backfill is marked incomplete but has no page token']);
  });

  test('rejects incomplete Gmail incremental continuation bookkeeping', () => {
    expect(
      googleSyncStateProblems(
        googleSyncStateFields({ mail: { incrementalPageToken: 'ip2' } }),
      ),
    ).toEqual([
      'Gmail incremental page token has no baseline historyId',
      'Gmail incremental page token has no latest-history checkpoint',
    ]);

    expect(
      googleSyncStateProblems(
        googleSyncStateFields({ mail: { incrementalLatestHistoryId: 'h2' } }),
      ),
    ).toEqual([
      'Gmail latest-history checkpoint exists without an incremental page token',
    ]);
  });

  test('rejects ambiguous legacy Calendar state but accepts incremental pagination', () => {
    const ambiguous = googleSyncStateFields({
      calendar: {
        syncToken: 'stale-sync',
        pageToken: 'cp2',
        window: { from: 'from', to: 'to' },
      },
    });
    const incremental = googleSyncStateFields({
      calendar: { syncToken: 'sync-1', pageToken: 'cp2' },
    });

    expect(googleSyncStateProblems(ambiguous)).toEqual([
      'Google Calendar continuation is ambiguous (page token + sync token + full-sync window)',
    ]);
    expect(googleSyncStateProblems(incremental)).toEqual([]);
  });

  test('rejects a Calendar page token with neither continuation parameter set', () => {
    expect(
      googleSyncStateProblems(
        googleSyncStateFields({ calendar: { pageToken: 'cp2' } }),
      ),
    ).toEqual([
      'Google Calendar page token has neither a sync token nor a frozen window',
    ]);
  });
});
