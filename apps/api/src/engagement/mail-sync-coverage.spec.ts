import { getMailSyncCoverage } from './mail-sync-coverage.js';

const mailTime = '2026-09-05T12:00:00.000Z';
const calendarTime = '2026-09-07T12:00:00.000Z';

function graphMail() {
  return {
    captureVersion: 1,
    updatedAt: mailTime,
    folderEnumerationComplete: true,
    folders: {
      inbox: { updatedAt: mailTime, deltaLink: 'inbox-delta' },
      sentitems: { updatedAt: mailTime, deltaLink: 'sent-delta' },
    },
    lastStats: { hasMore: false, failed: 0 },
  };
}

function gmailMail() {
  return {
    captureVersion: 1,
    updatedAt: mailTime,
    historyId: 'gmail-history',
    labels: { ALL: { backfillDone: true, backfillPageToken: null } },
    lastStats: { hasMore: false, failed: 0 },
  };
}

const connection = {
  provider: 'microsoft_365',
  status: 'connected',
  lastSyncAt: new Date(calendarTime),
  now: new Date(calendarTime),
};

describe('getMailSyncCoverage', () => {
  it.each([
    ['microsoft_365', graphMail()],
    ['google_workspace', gmailMail()],
  ])('uses the shared 48-hour freshness boundary for %s mail regardless of fresh calendar success', (provider, mail) => {
    expect(getMailSyncCoverage({
      ...connection,
      provider,
      syncState: { mail },
      now: new Date('2026-09-07T12:00:00.000Z'),
    })).toMatchObject({ sourceStatus: 'healthy' });
    expect(getMailSyncCoverage({
      ...connection,
      provider,
      syncState: { mail },
      now: new Date('2026-09-07T12:00:00.001Z'),
    })).toMatchObject({
      sourceStatus: 'degraded',
      reason: 'mail_sync_stale',
      lastMailSyncAt: new Date(mailTime),
      lastConnectionSyncAt: new Date(calendarTime),
    });
  });

  it('rejects a mail timestamp more than five minutes in the future', () => {
    expect(getMailSyncCoverage({
      ...connection,
      syncState: { mail: { ...graphMail(), updatedAt: '2026-09-07T12:05:00.001Z' } },
    })).toMatchObject({ sourceStatus: 'degraded', reason: 'mail_sync_timestamp_in_future' });
  });

  it('keeps unavailable replay folders incomplete until the provider clears the exact missing-folder marker', () => {
    expect(getMailSyncCoverage({
      ...connection,
      syncState: { mail: { ...graphMail(), captureReplayMissingFolders: ['missing-custom-folder'] } },
    })).toMatchObject({
      sourceStatus: 'degraded',
      reason: 'mail_replay_folder_unavailable',
      backfillComplete: false,
      captureRepair: 'in_progress',
    });
    expect(getMailSyncCoverage({
      ...connection,
      syncState: { mail: { ...graphMail(), captureReplayMissingFolders: [] } },
    })).toMatchObject({ sourceStatus: 'healthy', captureRepair: 'complete' });
  });

  it('does not turn calendar-only connection success into mail freshness or complete empty coverage', () => {
    expect(getMailSyncCoverage({ ...connection, syncState: { calendar: { updatedAt: calendarTime } } }))
      .toEqual({
        sourceStatus: 'degraded',
        reason: 'mail_never_synced',
        lastMailSyncAt: null,
        lastConnectionSyncAt: new Date(calendarTime),
        backfillComplete: false,
        hasMore: false,
        captureRepair: 'required',
      });
  });

  it('uses the mail leg timestamp after later calendar success and retains historical repair gaps', () => {
    const { captureVersion: _version, ...legacyMail } = graphMail();
    expect(getMailSyncCoverage({ ...connection, syncState: { mail: legacyMail } })).toMatchObject({
      sourceStatus: 'degraded',
      reason: 'mail_capture_repair_required',
      lastMailSyncAt: new Date(mailTime),
      lastConnectionSyncAt: new Date(calendarTime),
      backfillComplete: false,
      captureRepair: 'required',
    });
  });

  it.each([
    ['microsoft_365', graphMail()],
    ['google_workspace', gmailMail()],
  ])('recognizes completed bounded capture repair for %s', (provider, mail) => {
    expect(getMailSyncCoverage({ ...connection, provider, syncState: { mail } })).toMatchObject({
      sourceStatus: 'healthy',
      reason: null,
      backfillComplete: true,
      hasMore: false,
      captureRepair: 'complete',
    });
  });

  it.each([
    ['microsoft_365', graphMail()],
    ['google_workspace', gmailMail()],
  ])('keeps %s repair incomplete until retained-baseline catch-up finishes', (provider, mail) => {
    const pending = getMailSyncCoverage({
      ...connection,
      provider,
      syncState: { mail: { ...mail, captureReplayCatchupPending: true } },
    });
    expect(pending).toMatchObject({
      sourceStatus: 'degraded',
      reason: 'mail_sync_incomplete',
      backfillComplete: true,
      hasMore: true,
      captureRepair: 'in_progress',
    });

    const completed = getMailSyncCoverage({
      ...connection,
      provider,
      syncState: { mail: { ...mail, captureReplayCatchupPending: false } },
    });
    expect(completed).toMatchObject({
      sourceStatus: 'healthy',
      reason: null,
      backfillComplete: true,
      hasMore: false,
      captureRepair: 'complete',
    });
  });

  it('keeps a capped Graph initial folder scan incomplete until it produces a delta baseline', () => {
    const mail = graphMail();
    const inbox = { updatedAt: mailTime, nextLink: 'page-13', lastStats: { hasMore: true } };
    expect(getMailSyncCoverage({
      ...connection,
      syncState: { mail: { ...mail, folders: { ...mail.folders, inbox } } },
    })).toMatchObject({
      sourceStatus: 'degraded',
      reason: 'mail_sync_incomplete',
      backfillComplete: false,
      hasMore: true,
      captureRepair: 'in_progress',
    });
  });

  it('retains completed repair but degrades Graph incremental pagination', () => {
    const mail = graphMail();
    expect(getMailSyncCoverage({
      ...connection,
      syncState: { mail: { ...mail, folders: {
        ...mail.folders,
        inbox: { ...mail.folders.inbox, nextLink: 'incremental-page-13' },
      } } },
    })).toMatchObject({
      sourceStatus: 'degraded',
      reason: 'mail_sync_incomplete',
      backfillComplete: true,
      hasMore: true,
      captureRepair: 'complete',
    });
  });

  it.each([false, undefined])('does not call fallback/capped/unrecorded Graph folder enumeration complete (%s)', (complete) => {
    expect(getMailSyncCoverage({
      ...connection,
      syncState: { mail: { ...graphMail(), folderEnumerationComplete: complete } },
    })).toMatchObject({
      sourceStatus: 'degraded',
      reason: 'mail_folder_enumeration_incomplete',
      backfillComplete: false,
    });
  });

  it('requires all Graph folder baselines, including a newly discovered custom folder', () => {
    const mail = graphMail();
    expect(getMailSyncCoverage({
      ...connection,
      syncState: { mail: { ...mail, folders: { ...mail.folders, custom: { nextLink: 'custom-page-13' } } } },
    })).toMatchObject({ sourceStatus: 'degraded', backfillComplete: false, hasMore: true });
  });

  it('lets Gmail backfill continuation override a stale completed flag/history baseline', () => {
    const mail = gmailMail();
    expect(getMailSyncCoverage({
      ...connection,
      provider: 'google_workspace',
      syncState: { mail: { ...mail, labels: { ALL: { backfillDone: true, backfillPageToken: 'page-13' } } } },
    })).toMatchObject({
      sourceStatus: 'degraded',
      backfillComplete: false,
      hasMore: true,
      captureRepair: 'in_progress',
    });
  });

  it('does not mark capped Gmail incremental history complete', () => {
    expect(getMailSyncCoverage({
      ...connection,
      provider: 'google_workspace',
      syncState: { mail: { ...gmailMail(), incrementalPageToken: 'history-page-13' } },
    })).toMatchObject({
      sourceStatus: 'degraded',
      backfillComplete: true,
      hasMore: true,
      captureRepair: 'complete',
    });
  });

  it('surfaces per-message provider failures even after a completed page chain', () => {
    expect(getMailSyncCoverage({
      ...connection,
      syncState: { mail: { ...graphMail(), lastStats: { failed: 1, hasMore: false } } },
    })).toMatchObject({ sourceStatus: 'degraded', reason: 'mail_messages_skipped_after_provider_errors' });
  });

  it('does not turn old complete mail state into connected availability', () => {
    expect(getMailSyncCoverage({ ...connection, status: 'error', syncState: { mail: graphMail() } }))
      .toMatchObject({ sourceStatus: 'unavailable', reason: 'mailbox_not_connected' });
  });

  it.each([null, [], 'malformed', { mail: { updatedAt: 'invalid-date' } }])('fails closed on missing or malformed mail state', (syncState) => {
    expect(getMailSyncCoverage({ ...connection, syncState }))
      .toMatchObject({ sourceStatus: 'degraded', lastMailSyncAt: null, backfillComplete: false });
  });

  it('does not infer an unsupported provider sync contract from a connection timestamp', () => {
    expect(getMailSyncCoverage({ ...connection, provider: 'imap_caldav', syncState: { mail: graphMail() } }))
      .toMatchObject({ sourceStatus: 'degraded', reason: 'mail_sync_coverage_unknown', captureRepair: 'not_applicable' });
  });
});
