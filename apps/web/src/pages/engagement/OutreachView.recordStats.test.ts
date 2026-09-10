// EM-07 — the campaign list card's readiness line must agree with the
// campaign editor. recordStats() used to infer "Meri draft ready/pending"
// from OutreachRecord.subject truthiness, which batch generation never
// populates (it writes straight to the OutreachDraftArtifact/Version tables;
// only an explicit "Save as draft" touches OutreachRecord.subject/body). This
// pins the fix: recordStats() must prefer the server's real draftReadiness
// rollup, and only fall back to the legacy subject guess when the server
// has nothing to report (older/unversioned records).
import { describe, expect, test } from 'vitest';
import { recordStats, type OutreachRecord } from './OutreachView.js';

function makeRecord(overrides: Partial<OutreachRecord> = {}): OutreachRecord {
  return {
    id: 'rec-1',
    clientId: null,
    meetingId: null,
    type: 'campaign',
    status: 'draft',
    title: 'Request for Meeting',
    subject: null,
    body: null,
    recipients: [],
    recipientCount: 3,
    stats: null,
    metadata: null,
    lastStep: 5,
    sentAt: null,
    openedInEmailAt: null,
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: '2026-09-08T00:00:00Z',
    client: null,
    meeting: null,
    ...overrides,
  };
}

describe('recordStats — campaign readiness copy (EM-07)', () => {
  test('a fully-generated campaign with real drafts reports N / N ready, not "Meri draft pending"', () => {
    // This is the exact repro: three recipients, real personalized drafts
    // exist server-side (Review Emails reaches 3/3), but the record's own
    // subject/body were never re-saved after generation.
    const record = makeRecord({ subject: null, draftReadiness: { total: 3, ready: 3 } });
    expect(recordStats(record)).toBe('3 recipients · 3 / 3 drafts ready');
  });

  test('a partially-generated campaign reports the real partial count', () => {
    const record = makeRecord({ subject: null, draftReadiness: { total: 3, ready: 1 } });
    expect(recordStats(record)).toBe('3 recipients · 1 / 3 drafts ready');
  });

  test('a record with no draftReadiness (older/unversioned) falls back to the legacy subject guess', () => {
    const withSubject = makeRecord({ subject: 'Hello', draftReadiness: undefined });
    expect(recordStats(withSubject)).toBe('3 recipients · Meri draft ready');

    const withoutSubject = makeRecord({ subject: null, draftReadiness: undefined });
    expect(recordStats(withoutSubject)).toBe('3 recipients · Meri draft pending');
  });

  test('draftReadiness with zero total (no artifacts exist yet) also falls back to the legacy guess', () => {
    const record = makeRecord({ subject: null, draftReadiness: { total: 0, ready: 0 } });
    expect(recordStats(record)).toBe('3 recipients · Meri draft pending');
  });

  test('a sent campaign always reports delivery stats, ignoring draftReadiness entirely', () => {
    const record = makeRecord({
      status: 'sent',
      draftReadiness: { total: 3, ready: 3 },
      stats: { recipientsSent: 3, replyCount: 1 },
    });
    expect(recordStats(record)).toBe('3 recipients sent · 1 replies');
  });

  test('outbound_campaign type gets the same treatment as campaign', () => {
    const record = makeRecord({ type: 'outbound_campaign', draftReadiness: { total: 2, ready: 2 } });
    expect(recordStats(record)).toBe('3 recipients · 2 / 2 drafts ready');
  });

  test('non-campaign types (follow_up/prep) are unaffected by draftReadiness', () => {
    const record = makeRecord({
      type: 'follow_up',
      status: 'draft',
      draftReadiness: { total: 3, ready: 3 },
    });
    expect(recordStats(record)).toBe('3 recipients');
  });
});
