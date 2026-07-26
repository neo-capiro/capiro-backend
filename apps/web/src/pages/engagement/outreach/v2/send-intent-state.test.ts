// Outreach v2 — Phase 0 send-intent client state (plan §5.4).
//
// What must hold:
//   • the send projection emits VERSION IDS and no text at all;
//   • non-sendable slots are excluded;
//   • a duplicate Send click reuses ONE request key;
//   • `unknown` shows verify-Sent-Items guidance and NO retry control;
//   • oversized attachments are caught before submission.

import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATUS_COPY,
  INLINE_ATTACHMENT_MAX_BYTES,
  attachmentPreflight,
  ensureRequestKey,
  ensureTestRequestKey,
  isDeliveryRetryable,
  isIntentActive,
  projectVersionIdsForSend,
  retryableGenKeys,
  scopeUnitsToGenKeys,
  showRetryControl,
  summarizeIntent,
  type DeliveryStatus,
  type DeliveryView,
  type SendIntentView,
} from './send-intent.js';
import type { GeneratedDraft } from './types.js';
import type { OutreachTarget } from './targets.js';

const rec = (email: string) => ({ email });
const individual = (email: string): OutreachTarget => ({
  key: `t-${email}`,
  type: 'individual',
  recipients: [rec(email)],
  cc: [],
  bcc: [],
});
const group = (key: string, audienceId: string, emails: string[]): OutreachTarget => ({
  key,
  type: 'group',
  audienceId,
  name: 'G',
  recipients: emails.map(rec),
  cc: [],
  bcc: [],
});
const list = (key: string, audienceId: string, emails: string[]): OutreachTarget => ({
  key,
  type: 'list',
  audienceId,
  name: 'L',
  recipients: emails.map(rec),
  cc: [],
  bcc: [],
});

const cleared = (versionId: string, over: Partial<GeneratedDraft> = {}): GeneratedDraft => ({
  subject: 'S',
  body: 'B',
  versionId,
  artifactId: 'art',
  version: 1,
  generationStatus: 'generated',
  auditStatus: 'passed',
  approvalStatus: 'not_required',
  sendable: true,
  dirty: false,
  ...over,
});

describe('projectVersionIdsForSend', () => {
  it('emits version IDS ONLY — never subject or body', () => {
    const units = projectVersionIdsForSend([individual('a@x.com')], {
      'individual:a@x.com': cleared('v-1'),
    });
    expect(units).toEqual([{ genKey: 'individual:a@x.com', draftVersionId: 'v-1' }]);
    // The structural guarantee: no content field exists on a send unit.
    expect(Object.keys(units[0]!)).toEqual(['genKey', 'draftVersionId']);
    expect(JSON.stringify(units)).not.toContain('"S"');
    expect(JSON.stringify(units)).not.toContain('"B"');
  });

  it('one individual, one per list member, ONE per group', () => {
    const targets = [
      individual('a@x.com'),
      list('L1', 'aud1', ['b@x.com', 'c@x.com']),
      group('G1', 'aud2', ['d@x.com', 'e@x.com']),
    ];
    const units = projectVersionIdsForSend(targets, {
      'individual:a@x.com': cleared('v-a'),
      'list:aud1:b@x.com': cleared('v-b'),
      'list:aud1:c@x.com': cleared('v-c'),
      'group:aud2': cleared('v-g'),
    });
    // 1 individual + 2 members + 1 group (NOT fanned to its 2 members) = 4.
    expect(units).toHaveLength(4);
    expect(units.map((u) => u.draftVersionId).sort()).toEqual(['v-a', 'v-b', 'v-c', 'v-g']);
  });

  it('EXCLUDES pending / held / unavailable / rejected / dirty slots', () => {
    const targets = [
      individual('ok@x.com'),
      individual('held@x.com'),
      individual('pending@x.com'),
      individual('unavail@x.com'),
      individual('rejected@x.com'),
      individual('dirty@x.com'),
    ];
    const units = projectVersionIdsForSend(targets, {
      'individual:ok@x.com': cleared('v-ok'),
      'individual:held@x.com': cleared('v-held', { auditStatus: 'held', sendable: false }),
      'individual:pending@x.com': cleared('v-pending', {
        auditStatus: 'pending',
        sendable: false,
      }),
      'individual:unavail@x.com': cleared('v-unavail', {
        auditStatus: 'unavailable',
        sendable: false,
      }),
      'individual:rejected@x.com': cleared('v-rejected', {
        approvalStatus: 'rejected',
        sendable: false,
      }),
      'individual:dirty@x.com': cleared('v-dirty', { dirty: true }),
    });
    expect(units.map((u) => u.draftVersionId)).toEqual(['v-ok']);
  });

  it('a slot with no server version is excluded (nothing to reference)', () => {
    const units = projectVersionIdsForSend([individual('a@x.com')], {
      'individual:a@x.com': { subject: 'S', body: 'B', status: 'ready' },
    });
    expect(units).toEqual([]);
  });

  it('the same version id is never submitted twice', () => {
    const dup = cleared('v-same');
    const units = projectVersionIdsForSend([individual('a@x.com'), individual('b@x.com')], {
      'individual:a@x.com': dup,
      'individual:b@x.com': dup,
    });
    expect(units).toHaveLength(1);
  });
});

describe('request keys — a duplicate Send click reuses ONE key', () => {
  it('returns the existing key unchanged', () => {
    const first = ensureRequestKey(null);
    expect(first).toMatch(/^snd-/);
    // Second click / network retry while the first is in flight.
    expect(ensureRequestKey(first)).toBe(first);
    expect(ensureRequestKey(first)).toBe(first);
  });

  it('mints a fresh key only when there is none', () => {
    expect(ensureRequestKey(null)).not.toBe(ensureRequestKey(null));
  });

  it('rejects a too-short stored key rather than sending an invalid one', () => {
    const minted = ensureRequestKey('short');
    expect(minted).not.toBe('short');
    expect(minted.length).toBeGreaterThanOrEqual(8);
  });

  it('a TEST send uses a separate key space from a real send', () => {
    const real = ensureRequestKey(null);
    const test = ensureTestRequestKey(null);
    expect(real).toMatch(/^snd-/);
    expect(test).toMatch(/^tst-/);
    expect(real).not.toBe(test);
  });
});

describe('unknown deliveries are never retryable', () => {
  it('only an explicit failure may be retried', () => {
    const all: DeliveryStatus[] = [
      'pending',
      'sending',
      'sent',
      'failed',
      'unknown',
      'skipped',
      'held',
    ];
    for (const s of all) {
      expect(isDeliveryRetryable(s)).toBe(s === 'failed');
      expect(showRetryControl(s)).toBe(s === 'failed');
    }
  });

  it('unknown copy tells the user to verify Sent Items, and no Retry renders', () => {
    expect(DELIVERY_STATUS_COPY.unknown).toMatch(/verify Sent Items/i);
    expect(showRetryControl('unknown')).toBe(false);
  });
});

describe('summarizeIntent', () => {
  const delivery = (status: DeliveryStatus, id: string): DeliveryView => ({
    id,
    generationKey: `individual:${id}`,
    recipientKey: id,
    status,
    attempt: 1,
    provider: 'gmail',
    correlationId: `corr-${id}`,
    to: [{ email: `${id}@x.com` }],
    cc: [],
    bcc: [],
    subject: 'S',
    providerMessageId: status === 'sent' ? `gm-${id}` : null,
    providerThreadId: null,
    providerDraftId: null,
    errorCode: status === 'failed' ? 'PROVIDER_REJECTED' : null,
    errorMessage: status === 'failed' ? 'mailbox unavailable' : null,
    acceptedAt: status === 'sent' ? '2026-07-27T00:00:00.000Z' : null,
  });

  const intent = (deliveries: DeliveryView[]): SendIntentView => ({
    id: 'intent-1',
    outreachRecordId: 'rec-1',
    status: 'partial',
    testMode: false,
    requestKey: 'snd-x',
    totals: {},
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    deliveries,
  });

  it('counts every outcome and flags unknowns', () => {
    const s = summarizeIntent(
      intent([
        delivery('sent', 'a'),
        delivery('failed', 'b'),
        delivery('unknown', 'c'),
        delivery('skipped', 'd'),
        delivery('pending', 'e'),
      ]),
    );
    expect(s).toMatchObject({
      sent: 1,
      failed: 1,
      unknown: 1,
      skipped: 1,
      inFlight: 1,
      total: 5,
      hasUnknown: true,
    });
  });

  it('an all-sent intent has no unknowns', () => {
    expect(summarizeIntent(intent([delivery('sent', 'a')])).hasUnknown).toBe(false);
  });

  it('a single unknown prevents a blanket success', () => {
    const s = summarizeIntent(intent([delivery('sent', 'a'), delivery('unknown', 'b')]));
    expect(s.hasUnknown).toBe(true);
    expect(s.sent).toBe(1);
  });

  it('handles no intent at all', () => {
    expect(summarizeIntent(undefined).total).toBe(0);
  });
});

describe('isIntentActive', () => {
  it('polls while queued/running, stops when terminal', () => {
    expect(isIntentActive('queued')).toBe(true);
    expect(isIntentActive('running')).toBe(true);
    for (const s of ['partial', 'complete', 'failed', 'canceled'] as const) {
      expect(isIntentActive(s)).toBe(false);
    }
    expect(isIntentActive(undefined)).toBe(false);
  });
});

describe('attachment preflight — caught BEFORE submission', () => {
  const docs = [
    { id: 'small', fileName: 'brief.pdf', byteSize: 1024 },
    { id: 'big', fileName: 'deck.pdf', byteSize: 5 * 1024 * 1024 },
    { id: 'unknown-size', fileName: 'mystery.pdf', byteSize: null },
  ];

  it('flags an oversized file with its name', () => {
    const issues = attachmentPreflight(['small', 'big'], docs);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: 'big', fileName: 'deck.pdf', reason: 'too_large' });
  });

  it('passes files within the limit', () => {
    expect(attachmentPreflight(['small'], docs)).toEqual([]);
  });

  it('defers to the server when the size is unknown (never a false block)', () => {
    expect(attachmentPreflight(['unknown-size'], docs)).toEqual([]);
  });

  it('uses the same 3 MB ceiling as the server', () => {
    expect(INLINE_ATTACHMENT_MAX_BYTES).toBe(3 * 1024 * 1024);
  });

  it('exactly at the limit is allowed; one byte over is not', () => {
    const edge = [
      { id: 'at', fileName: 'at.pdf', byteSize: INLINE_ATTACHMENT_MAX_BYTES },
      { id: 'over', fileName: 'over.pdf', byteSize: INLINE_ATTACHMENT_MAX_BYTES + 1 },
    ];
    expect(attachmentPreflight(['at'], edge)).toEqual([]);
    expect(attachmentPreflight(['over'], edge)).toHaveLength(1);
  });
});

// A partial-failure retry must resubmit ONLY the failed rows. Resubmitting the
// whole set would collide with the server's (tenant, idempotencyKey) unique index
// on the first already-DELIVERED draft, and that insert failure rolls the entire
// new intent back — so "Create new send for N failed" would 409 instead of
// working. Safe (never a duplicate email), but broken as a recovery flow.
describe('retry scoping (partial-failure recovery)', () => {
  const row = (status: DeliveryStatus, genKey: string): DeliveryView => ({
    id: `d-${genKey}`,
    generationKey: genKey,
    recipientKey: genKey,
    status,
    attempt: 1,
    provider: 'gmail',
    correlationId: `corr-${genKey}`,
    to: [{ email: 'x@y.com' }],
    cc: [],
    bcc: [],
    subject: 'S',
    providerMessageId: null,
    providerThreadId: null,
    providerDraftId: null,
    errorCode: null,
    errorMessage: null,
    acceptedAt: null,
  });

  const mixed: SendIntentView = {
    id: 'intent-1',
    outreachRecordId: 'rec-1',
    status: 'partial',
    testMode: false,
    requestKey: 'snd-x',
    totals: {},
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    deliveries: [
      row('sent', 'individual:a@x.com'),
      row('failed', 'individual:b@x.com'),
      row('unknown', 'individual:c@x.com'),
      row('skipped', 'individual:d@x.com'),
    ],
  };

  it('selects ONLY failed rows — never sent, unknown or skipped', () => {
    expect(retryableGenKeys(mixed)).toEqual(['individual:b@x.com']);
  });

  it('never selects an unknown row (it may already have been delivered)', () => {
    expect(retryableGenKeys(mixed)).not.toContain('individual:c@x.com');
  });

  it('is empty when nothing failed, so no retry intent is created', () => {
    expect(retryableGenKeys({ ...mixed, deliveries: [row('sent', 'individual:a@x.com')] })).toEqual(
      [],
    );
    expect(retryableGenKeys(undefined)).toEqual([]);
  });

  it('scopes the submitted units to the retry set, dropping the already-sent draft', () => {
    const units = [
      { genKey: 'individual:a@x.com', draftVersionId: 'v-a' },
      { genKey: 'individual:b@x.com', draftVersionId: 'v-b' },
      { genKey: 'individual:c@x.com', draftVersionId: 'v-c' },
    ];
    // This is the whole point: v-a was DELIVERED by the first intent and must not
    // be resubmitted, or the unique index kills the retry.
    expect(scopeUnitsToGenKeys(units, retryableGenKeys(mixed))).toEqual([
      { genKey: 'individual:b@x.com', draftVersionId: 'v-b' },
    ]);
  });

  it('an absent/empty scope means a normal first send (everything sendable)', () => {
    const units = [{ genKey: 'individual:a@x.com', draftVersionId: 'v-a' }];
    expect(scopeUnitsToGenKeys(units, undefined)).toEqual(units);
    expect(scopeUnitsToGenKeys(units, [])).toEqual(units);
    expect(scopeUnitsToGenKeys(units, null)).toEqual(units);
  });

  it('a scoped key that is no longer sendable simply drops out (retries only shrink)', () => {
    // The draft was edited after the failure, so projectVersionIdsForSend no
    // longer emits it. The retry must not resurrect a stale version id.
    expect(scopeUnitsToGenKeys([], ['individual:b@x.com'])).toEqual([]);
  });
});
