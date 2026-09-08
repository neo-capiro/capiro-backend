import { MERI_MAIL_MAX_STALENESS_MS } from '@capiro/shared';

/** Version of the provider capture behavior that retains unassociated mail. */
export const MAIL_CAPTURE_VERSION = 1;

export interface MailSyncCoverageInput {
  provider: string;
  status: string;
  lastSyncAt?: Date | string | null;
  syncState?: unknown;
  now?: Date;
}

export interface MailSyncCoverage {
  sourceStatus: 'healthy' | 'degraded' | 'unavailable';
  reason: string | null;
  lastMailSyncAt: Date | null;
  /** Connection success can reflect calendar-only work; never mail freshness. */
  lastConnectionSyncAt: Date | null;
  /** Completion of the provider's bounded backfill, not all mailbox history. */
  backfillComplete: boolean;
  hasMore: boolean;
  captureRepair: 'required' | 'in_progress' | 'complete' | 'not_applicable';
}

type StateObject = Record<string, unknown>;

function object(value: unknown): StateObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as StateObject)
    : {};
}

function date(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function present(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Read the same persisted provider state that resumes canonical mail sync.
 * A successful calendar sync, an advanced page, and a complete mail backfill
 * are different facts. In particular, an empty result cannot establish that a
 * mailbox is empty while the unassociated-mail repair is still outstanding.
 */
export function getMailSyncCoverage(input: MailSyncCoverageInput): MailSyncCoverage {
  const mail = object(object(input.syncState).mail);
  const stats = object(mail.lastStats);
  const knownProvider = ['microsoft_365', 'google_workspace'].includes(input.provider);
  const repairStarted =
    typeof mail.captureVersion === 'number' && mail.captureVersion >= MAIL_CAPTURE_VERSION;
  // A completed replay page chain can still owe a pass over the retained
  // baseline to capture deletions and moves that happened during the replay.
  const replayCatchupPending = mail.captureReplayCatchupPending === true;
  const replayHasMissingFolders =
    Array.isArray(mail.captureReplayMissingFolders) && mail.captureReplayMissingFolders.some(present);
  let hasMore = stats.hasMore === true || replayCatchupPending;
  let backfillComplete = false;
  let folderEnumerationComplete = true;

  if (input.provider === 'microsoft_365') {
    const folders = object(mail.folders);
    const folderStates = Object.values(folders).map(object);
    hasMore ||= present(mail.cursor) || folderStates.some(
      (folder) => present(folder.nextLink) || object(folder.lastStats).hasMore === true,
    );
    folderEnumerationComplete = mail.folderEnumerationComplete === true;
    // Both legacy folders are always part of canonical Graph sync. A delta
    // link establishes a completed baseline; a next link alone does not.
    backfillComplete =
      folderEnumerationComplete &&
      Object.hasOwn(folders, 'inbox') &&
      Object.hasOwn(folders, 'sentitems') &&
      folderStates.every((folder) => date(folder.updatedAt) !== null && present(folder.deltaLink));
  } else if (input.provider === 'google_workspace') {
    const all = object(object(mail.labels).ALL);
    hasMore ||=
      present(mail.incrementalPageToken) ||
      present(all.backfillPageToken) ||
      all.backfillDone === false;
    backfillComplete =
      all.backfillDone === true &&
      !present(all.backfillPageToken) &&
      present(mail.historyId);
  }

  const coverage: MailSyncCoverage = {
    sourceStatus: 'degraded',
    reason: null,
    lastMailSyncAt: date(mail.updatedAt),
    lastConnectionSyncAt: date(input.lastSyncAt),
    backfillComplete: repairStarted && backfillComplete && !replayHasMissingFolders,
    hasMore,
    captureRepair: !knownProvider
      ? 'not_applicable'
      : !repairStarted
        ? 'required'
        : backfillComplete && !replayCatchupPending && !replayHasMissingFolders
          ? 'complete'
          : 'in_progress',
  };

  if (input.status !== 'connected') {
    coverage.sourceStatus = 'unavailable';
    coverage.reason = 'mailbox_not_connected';
  } else if (!coverage.lastMailSyncAt) {
    coverage.reason = 'mail_never_synced';
  } else if (!knownProvider) {
    coverage.reason = 'mail_sync_coverage_unknown';
  } else if (!repairStarted) {
    coverage.reason = 'mail_capture_repair_required';
  } else if (replayHasMissingFolders) {
    coverage.reason = 'mail_replay_folder_unavailable';
  } else if (typeof stats.failed === 'number' && stats.failed > 0) {
    coverage.reason = 'mail_messages_skipped_after_provider_errors';
  } else if (!folderEnumerationComplete) {
    coverage.reason = 'mail_folder_enumeration_incomplete';
  } else if (!backfillComplete || hasMore) {
    coverage.reason = 'mail_sync_incomplete';
  } else if (coverage.lastMailSyncAt.getTime() > (input.now?.getTime() ?? Date.now()) + 5 * 60 * 1000) {
    coverage.reason = 'mail_sync_timestamp_in_future';
  } else if ((input.now?.getTime() ?? Date.now()) - coverage.lastMailSyncAt.getTime() > MERI_MAIL_MAX_STALENESS_MS) {
    coverage.reason = 'mail_sync_stale';
  } else {
    coverage.sourceStatus = 'healthy';
  }

  return coverage;
}
