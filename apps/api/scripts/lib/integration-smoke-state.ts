/**
 * Pure parsing and validation for the read-only Google/Microsoft integration
 * smoke script. Kept outside the executable script so cursor invariants are
 * unit-tested without booting Nest or touching a database.
 */

export interface IntegrationConnectionHealthInput {
  status: string;
  scopeMatch: boolean | 'n/a';
  hasRefreshToken: boolean;
  lastSyncAtPresent: boolean;
  lastError: string | null;
}

/** Fail-closed inventory rule for a rollout smoke: zero rows proves nothing. */
export function integrationInventoryProblems(connectionCount: number): string[] {
  return connectionCount > 0
    ? []
    : ['no Google Workspace or Microsoft 365 connections found for this tenant'];
}

/** Provider-neutral connection health checks, kept pure for CI coverage. */
export function integrationConnectionProblems(
  input: IntegrationConnectionHealthInput,
): string[] {
  const problems: string[] = [];
  if (input.status !== 'connected') {
    problems.push(`connection status is ${input.status}, expected connected`);
  }
  if (input.scopeMatch === false) {
    problems.push('stored OAuth scopes do not match canonical scopes');
  }
  if (!input.hasRefreshToken) problems.push('refresh token envelope is missing or incomplete');
  if (!input.lastSyncAtPresent) {
    problems.push('connection has never completed a sync (lastSyncAt is missing)');
  }
  if (input.lastError) problems.push(`lastError is set: ${input.lastError}`);
  return problems;
}

export interface GoogleSyncStateFields {
  mailHistoryId: string | null;
  mailIncrementalPageToken: string | null;
  mailIncrementalLatestHistoryId: string | null;
  mailBackfillPageToken: string | null;
  mailBackfillQuery: string | null;
  mailBackfillDone: boolean | null;
  calendarSyncTokenPresent: boolean;
  calendarPageToken: string | null;
  calendarWindow: { from: string; to: string } | null;
  calendarContinuationMode:
    | 'none'
    | 'full_window'
    | 'incremental'
    | 'ambiguous_legacy'
    | 'invalid';
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Opaque provider cursors only; no OAuth token or encrypted credential data. */
export function googleSyncStateFields(syncState: unknown): GoogleSyncStateFields {
  const state = asRecord(syncState);
  const mail = asRecord(state.mail);
  const allLabel = asRecord(asRecord(mail.labels).ALL);
  const calendar = asRecord(state.calendar);
  const window = asRecord(calendar.window);
  const calendarSyncTokenPresent = Boolean(asString(calendar.syncToken));
  const calendarPageToken = asString(calendar.pageToken);
  const calendarWindow =
    typeof window.from === 'string' && typeof window.to === 'string'
      ? { from: window.from, to: window.to }
      : null;
  const calendarContinuationMode = !calendarPageToken
    ? 'none'
    : calendarSyncTokenPresent && calendarWindow
      ? 'ambiguous_legacy'
      : calendarSyncTokenPresent
        ? 'incremental'
        : calendarWindow
          ? 'full_window'
          : 'invalid';
  return {
    mailHistoryId: asString(mail.historyId),
    mailIncrementalPageToken: asString(mail.incrementalPageToken),
    mailIncrementalLatestHistoryId: asString(mail.incrementalLatestHistoryId),
    mailBackfillPageToken: asString(allLabel.backfillPageToken),
    mailBackfillQuery: asString(allLabel.backfillQuery),
    mailBackfillDone: asBoolean(allLabel.backfillDone),
    calendarSyncTokenPresent,
    calendarPageToken,
    calendarWindow,
    calendarContinuationMode,
  };
}

/**
 * Invariants for durable multi-run provider pagination. A result here is a
 * deployment smoke failure, not an informational warning: continuing with the
 * wrong cursor can skip unconsumed provider pages.
 */
export function googleSyncStateProblems(fields: GoogleSyncStateFields): string[] {
  const problems: string[] = [];

  if (fields.mailBackfillPageToken) {
    if (fields.mailBackfillDone === true) {
      problems.push('Gmail backfill page token is incorrectly marked complete');
    }
    if (!fields.mailBackfillQuery) {
      problems.push('Gmail backfill page token has no frozen query');
    }
    if (fields.mailHistoryId) {
      problems.push('Gmail full-backfill continuation still carries a stale historyId');
    }
    if (fields.mailIncrementalPageToken || fields.mailIncrementalLatestHistoryId) {
      problems.push('Gmail full-backfill continuation also carries incremental continuation state');
    }
  } else if (fields.mailBackfillDone === false) {
    problems.push('Gmail backfill is marked incomplete but has no page token');
  }

  if (fields.mailIncrementalPageToken) {
    if (!fields.mailHistoryId) {
      problems.push('Gmail incremental page token has no baseline historyId');
    }
    if (!fields.mailIncrementalLatestHistoryId) {
      problems.push('Gmail incremental page token has no latest-history checkpoint');
    }
  } else if (fields.mailIncrementalLatestHistoryId) {
    problems.push('Gmail latest-history checkpoint exists without an incremental page token');
  }

  if (fields.calendarContinuationMode === 'ambiguous_legacy') {
    problems.push(
      'Google Calendar continuation is ambiguous (page token + sync token + full-sync window)',
    );
  } else if (fields.calendarContinuationMode === 'invalid') {
    problems.push('Google Calendar page token has neither a sync token nor a frozen window');
  }

  return problems;
}
