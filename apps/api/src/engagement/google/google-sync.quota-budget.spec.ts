// 2026-09-08 incident regression: the Gmail capture-replay shipped in #1522
// forced every pre-existing connection into a full 365-day backfill. One
// backfill page is 1 messages.list + up to 100 messages.get ≈ 505 quota units
// against Gmail's default 240 units/min/user, so every mailbox hit a 403
// quota wall ~48 messages in — every ~15 minutes, forever. Two stacked
// defects made it an outage rather than a slow replay:
//   1. googleGet's error builder sliced the body at 500 chars — cutting
//      mid-word inside "rateLimitExceeded" — so isPermanentMailFailure
//      classified the transient quota 403 as PERMANENT and every connection
//      flipped to error state with a reconnect banner.
//   2. The backfill had no quota budget and no mid-page checkpoint: on throw
//      the whole run's progress was discarded (state.mail is only assigned
//      on success), so each retry restarted page one — a livelock that also
//      starved the user's per-minute quota for interactive traffic.
// These specs pin the three fixes: reason extraction before truncation,
// transient classification, and budgeted checkpoint/resume progress.

import { describe, expect, jest, test } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  extractGoogleErrorReason,
  isTransientQuotaError,
  GoogleSyncService,
} from './google-sync.service.js';

const connection = { id: 'conn-1', accountEmail: 'user@example.com' };

/** The exact error message googleGet now builds for a Gmail quota 403 —
 *  reason hoisted BEFORE the truncated body slice. */
function quotaError(): ServiceUnavailableException {
  return new ServiceUnavailableException(
    'Google API GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full failed (403): [reason: rateLimitExceeded] {"error":{"code":403,"message":"Quota exceeded for quota metric \'Total Query Cost\' and limit \'Units per minute per user\' of service \'gmail.googleapis.com\' for consumer \'project_number:1045442200721\'.","errors":[{"message":"Quota exceeded for quota metric \'Total Query Cost\' and limit \'Units per minute per user\' of service \'gmail.googleapis.com\' for consumer \'project_number:1045442200721\'.","domain":"usageLimits","reason":"rateLimitExceede',
  );
}

function quotaBody(): string {
  return JSON.stringify({
    error: {
      code: 403,
      message: 'Quota exceeded for quota metric \'Total Query Cost\'',
      errors: [
        {
          message: 'Quota exceeded',
          domain: 'usageLimits',
          reason: 'rateLimitExceeded',
        },
      ],
    },
  });
}

describe('extractGoogleErrorReason', () => {
  test('extracts errors[].reason from a Gmail quota body', () => {
    expect(extractGoogleErrorReason(quotaBody())).toBe('ratelimitexceeded');
  });

  test('falls back to error.reason when errors[] is absent', () => {
    expect(
      extractGoogleErrorReason(JSON.stringify({ error: { reason: 'userRateLimitExceeded' } })),
    ).toBe('userratelimitexceeded');
  });

  test('returns null for non-JSON and empty reasons', () => {
    expect(extractGoogleErrorReason('<html>bad gateway</html>')).toBeNull();
    expect(extractGoogleErrorReason(JSON.stringify({ error: { reason: '' } }))).toBeNull();
    expect(extractGoogleErrorReason(JSON.stringify({}))).toBeNull();
  });
});

describe('isTransientQuotaError', () => {
  test('a quota 403 whose body slice was truncated mid-reason still classifies transient', () => {
    // The exact 2026-09-08 shape: the reason inside the sliced body is cut
    // mid-word ("rateLimitExceede") — only the hoisted [reason: …] survives.
    expect(isTransientQuotaError(quotaError())).toBe(true);
  });

  test('a parsed full-body quota 403 classifies transient', () => {
    expect(
      isTransientQuotaError(
        new ServiceUnavailableException(`Google API GET https://x failed (403): ${quotaBody()}`),
      ),
    ).toBe(true);
  });

  test('a permanent permission 403 is NOT a quota error', () => {
    expect(
      isTransientQuotaError(
        new ServiceUnavailableException(
          'Google API GET https://x failed (403): [reason: insufficientPermissions] …',
        ),
      ),
    ).toBe(false);
  });

  test('non-403/429 statuses never classify as quota errors', () => {
    expect(
      isTransientQuotaError(
        new ServiceUnavailableException(
          'Google API GET https://x failed (500): [reason: rateLimitExceeded] …',
        ),
      ),
    ).toBe(false);
    expect(isTransientQuotaError(new Error('db pool timeout'))).toBe(false);
  });
});

// ---- Backfill quota budget + checkpoint/resume ------------------------------

interface BackfillHarness {
  service: GoogleSyncService;
  patch: Record<string, unknown>;
}

function makeBackfillService(opts: {
  pages: Array<{ messages: string[]; nextPageToken?: string }>;
  failWith?: (id: string, call: number) => Error | undefined;
}): BackfillHarness {
  const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: jest.fn(), error: jest.fn() };
  let listIndex = 0;
  patch.gmailList = jest.fn(async () => {
    const page = opts.pages[listIndex] ?? { messages: [] };
    listIndex += 1;
    return {
      messages: page.messages.map((id) => ({ id })),
      nextPageToken: page.nextPageToken,
    };
  });
  let getCall = 0;
  patch.gmailGet = jest.fn(async (_token: string, id: string) => {
    getCall += 1;
    const failure = opts.failWith?.(id, getCall);
    if (failure) throw failure;
    return { id, labelIds: ['INBOX'] };
  });
  patch.persistGmailMessage = jest.fn(async () => 'matched' as const);
  patch.gmailProfile = jest.fn(async () => ({ historyId: 'profile-history' }));
  return { service, patch };
}

/** Mirrors a real pre-replay connection row (e.g. mia@prosperingsolutions
 *  2026-09-08): an OLD completed backfill at captureVersion 0. #1522's forced
 *  replay must restart the backfill from page one, budgeted. */
function preReplayState(): Record<string, unknown> {
  return {
    mail: {
      historyId: '203248',
      captureVersion: 0,
      captureReplayReady: true,
      labels: {
        ALL: {
          backfillPageToken: null,
          backfillDone: true,
          backfillQuery: 'after:1755547026 -in:spam -in:trash -in:draft',
        },
      },
    },
  };
}

interface MailStats {
  scanned: number;
  matched: number;
  pages: number;
  hasMore: boolean;
}

interface SyncMailDeps {
  syncMail: (
    tenantId: string,
    conn: unknown,
    state: Record<string, unknown>,
    accessToken: string,
    input: { reset?: boolean },
  ) => Promise<Record<string, MailStats>>;
}

async function runSyncMail(
  service: GoogleSyncService,
  state: Record<string, unknown>,
): Promise<MailStats> {
  const result = await (service as unknown as SyncMailDeps).syncMail(
    't1',
    connection,
    state,
    'token',
    {},
  );
  return result.ALL ?? { scanned: 0, matched: 0, pages: 0, hasMore: false };
}

interface AllLabelState {
  backfillPageToken?: string | null;
  backfillDone?: boolean;
  backfillQuery?: string | null;
  backfillPendingRefs?: string[];
  backfillPendingPageToken?: string | null;
  backfillChainEnded?: boolean;
}

function allLabel(state: Record<string, unknown>): AllLabelState {
  const mail = (state as { mail?: { labels?: Record<string, AllLabelState> } }).mail;
  return mail?.labels?.ALL ?? {};
}

describe('syncMail — quota-budgeted capture replay', () => {
  test('a quota 403 mid-page checkpoints progress and resolves instead of throwing (no error banner)', async () => {
    // 30-message page; the 5th get hits the per-minute wall.
    const { service, patch } = makeBackfillService({
      pages: [{ messages: Array.from({ length: 30 }, (_, i) => `m${i + 1}`), nextPageToken: 'page-2' }],
      failWith: (_id, call) => (call === 5 ? quotaError() : undefined),
    });
    const state = preReplayState();

    // The 2026-09-08 behavior: this threw, discarding all progress and
    // flipping the connection to error. Now it must resolve with a checkpoint.
    const result = await runSyncMail(service, state);

    expect(result.hasMore).toBe(true);
    expect((patch.persistGmailMessage as jest.Mock).mock.calls.length).toBe(4);
    const label = allLabel(state);
    // 26 unfetched refs remain (m5 was put back after the failed fetch).
    expect(label.backfillPendingRefs).toHaveLength(26);
    expect(label.backfillPendingRefs?.[0]).toBe('m5');
    expect(label.backfillPendingPageToken).toBe('page-2');
    expect(label.backfillDone).toBe(false);
    expect(label.backfillPageToken).toBeNull();
    // The replay baseline is retained, not clobbered by the yield.
    expect((state as { mail?: { captureReplayHistoryId?: string } }).mail?.captureReplayHistoryId).toBe(
      '203248',
    );
  });

  test('resume drains the pending refs before any new messages.list, within the run budget', async () => {
    const { service, patch } = makeBackfillService({
      pages: [{ messages: Array.from({ length: 30 }, (_, i) => `m${i + 1}`), nextPageToken: 'page-2' }],
    });
    const state = preReplayState();
    const first = await runSyncMail(service, state);
    expect(first.scanned).toBe(23); // list (5 units) + 23 gets (115) = the 120-unit budget
    expect(allLabel(state).backfillPendingRefs).toHaveLength(7);

    (patch.gmailList as jest.Mock).mockClear();
    (patch.gmailGet as jest.Mock).mockClear();
    (patch.persistGmailMessage as jest.Mock).mockClear();
    const second = await runSyncMail(service, state);

    // Pure-resume ordering invariant: the 7 leftover refs (m24..m30) are all
    // fetched BEFORE the next messages.list fires (the run only advances the
    // page chain after the checkpointed work is drained).
    const getCalls = (patch.gmailGet as jest.Mock).mock.calls.map(
      (call: unknown[]) => call[1] as string,
    );
    const firstListIndex = getCalls.length; // gets before list are the prefix
    const listCalls = (patch.gmailList as jest.Mock).mock.calls;
    expect(listCalls.length).toBe(1); // page-2 continuation, after the drain
    for (const id of ['m24', 'm25', 'm26', 'm27', 'm28', 'm29', 'm30']) {
      expect(getCalls.indexOf(id)).toBeGreaterThanOrEqual(0);
      expect(getCalls.indexOf(id)).toBeLessThan(firstListIndex);
    }
    expect(getCalls.slice(0, 7)).toEqual(['m24', 'm25', 'm26', 'm27', 'm28', 'm29', 'm30']);
    // All 7 leftover refs persisted in run 2 (page 2 itself is empty here).
    expect(second.matched).toBe(7);
    expect((patch.persistGmailMessage as jest.Mock).mock.calls.length).toBe(7);
    expect(allLabel(state).backfillPendingRefs).toHaveLength(0);
  });

  test('a dense page is bounded by the quota budget, not just the page cap', async () => {
    const { service, patch } = makeBackfillService({
      pages: [{ messages: Array.from({ length: 100 }, (_, i) => `m${i + 1}`), nextPageToken: 'page-2' }],
    });
    const state = preReplayState();
    const result = await runSyncMail(service, state);

    // 1 list + 23 gets = 24 requests = 120 units. The old code would have
    // attempted all 100 gets (~505 units) and slammed the per-minute wall.
    expect(result.pages).toBe(1);
    expect(result.matched).toBe(23);
    expect(allLabel(state).backfillPendingRefs).toHaveLength(77);
    expect((patch.gmailList as jest.Mock).mock.calls.length).toBe(1);
  });

  test('progress is monotonic across runs: persisted totals accumulate, never restart (no livelock)', async () => {
    // Page of 30 with the wall on every 5th fetch — worst-case cadence.
    const { service, patch } = makeBackfillService({
      pages: [{ messages: Array.from({ length: 30 }, (_, i) => `m${i + 1}`), nextPageToken: 'page-2' }],
      failWith: (_id, call) => (call % 5 === 0 ? quotaError() : undefined),
    });
    const state = preReplayState();

    await runSyncMail(service, state);
    const persisted1 = (patch.persistGmailMessage as jest.Mock).mock.calls.length;
    const pending1 = allLabel(state).backfillPendingRefs?.length ?? 0;

    (patch.persistGmailMessage as jest.Mock).mockClear();
    const run2 = await runSyncMail(service, state);
    const persisted2 = (patch.persistGmailMessage as jest.Mock).mock.calls.length;
    const pending2 = allLabel(state).backfillPendingRefs?.length ?? 0;

    // Every run persists strictly more messages and shrinks the pending
    // queue — page one is never restarted. This is the anti-livelock
    // invariant the incident violated.
    expect(persisted1).toBeGreaterThan(0);
    expect(persisted2).toBeGreaterThan(0);
    expect(pending2).toBeLessThan(pending1);
    expect(run2.scanned).toBeGreaterThan(0);
  });

  test('the final page completes the replay: chain-ended refs drain without re-listing, then the baseline restores', async () => {
    // Page 2 is the LAST page (no nextPageToken) with 25 messages; the list
    // call eats 5 of the fresh 120-unit budget, so only 23 of its refs fit —
    // the run yields with the chain already ended and 2 refs queued.
    const { service, patch } = makeBackfillService({
      pages: [
        { messages: Array.from({ length: 23 }, (_, i) => `p1-${i + 1}`), nextPageToken: 'page-2' },
        { messages: Array.from({ length: 25 }, (_, i) => `p2-${i + 1}`) },
      ],
    });
    const state = preReplayState();
    await runSyncMail(service, state); // page 1: list + 23 gets = budget spent

    const page2 = await runSyncMail(service, state); // page 2: list + 23 of 25 gets
    expect((patch.gmailList as jest.Mock).mock.calls.length).toBe(2);
    expect(allLabel(state).backfillPendingRefs).toEqual(['p2-24', 'p2-25']);
    expect(allLabel(state).backfillChainEnded).toBe(true);
    expect(allLabel(state).backfillDone).toBe(false);
    expect(page2.hasMore).toBe(true);

    (patch.gmailList as jest.Mock).mockClear();
    const done = await runSyncMail(service, state);
    // The last refs drain WITHOUT a new list call (the chain already ended).
    expect(patch.gmailList).not.toHaveBeenCalled();
    expect(done.hasMore).toBe(false);
    expect(allLabel(state).backfillDone).toBe(true);
    expect(allLabel(state).backfillPendingRefs).toHaveLength(0);
    // The pre-replay baseline is restored as the incremental historyId.
    expect((state as { mail?: { historyId?: string } }).mail?.historyId).toBe('203248');
  });
});
