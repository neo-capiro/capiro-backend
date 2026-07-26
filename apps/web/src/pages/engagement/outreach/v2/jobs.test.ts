// Pure helpers behind the async-job wizard wiring (W4.4). The polling hook is
// React/network; these mappers are pure and carry the correctness-critical logic
// (progress from item rows not job.totals; terminal→draft fan-out; transient chips).

import { describe, expect, it } from 'vitest';
import {
  buildResultIdToGenKeys,
  jobItemsProgress,
  mapJobItemsToDraftPatch,
  transientStatusByGenKey,
  isJobActive,
  type JobItem,
} from './jobs.js';
import type { GenSlot } from './generation.js';

const slot = (genKey: string, resultId: string): GenSlot => ({
  genKey,
  appliesTo: 'individual',
  genRecipients: [{ email: resultId }],
  resultId,
});

const item = (over: Partial<JobItem> & Pick<JobItem, 'recipientKey' | 'status'>): JobItem => ({
  id: `it-${over.recipientKey}`,
  result: null,
  error: null,
  attempt: 1,
  ...over,
});

describe('buildResultIdToGenKeys', () => {
  it('fans one recipient out to every slot that shares its resultId', () => {
    const m = buildResultIdToGenKeys([
      slot('individual:a', 'a'),
      slot('list:L:a', 'a'),
      slot('individual:b', 'b'),
    ]);
    expect(m.get('a')).toEqual(['individual:a', 'list:L:a']);
    expect(m.get('b')).toEqual(['individual:b']);
  });
});

describe('jobItemsProgress', () => {
  it('counts terminal item states (NOT job.totals) and reports active by job status', () => {
    const items = [
      item({ recipientKey: 'a', status: 'done' }),
      item({ recipientKey: 'b', status: 'failed' }),
      item({ recipientKey: 'c', status: 'skipped' }),
      item({ recipientKey: 'd', status: 'generating' }),
    ];
    const p = jobItemsProgress(items, 'running');
    expect(p).toMatchObject({ total: 4, done: 1, failed: 1, skipped: 1, settled: 3, active: true });
  });
  it('a terminal job status is not active', () => {
    expect(jobItemsProgress([], 'complete').active).toBe(false);
    expect(isJobActive('queued')).toBe(true);
    expect(isJobActive('canceled')).toBe(false);
  });
});

describe('mapJobItemsToDraftPatch', () => {
  const map = buildResultIdToGenKeys([
    slot('individual:a', 'a'),
    slot('list:L:a', 'a'),
    slot('individual:b', 'b'),
  ]);
  const ph = (genKey: string) => ({ subject: `PH ${genKey}`, body: 'failed placeholder' });

  it("'done' fans a ready draft (markdown→sanitized html) to every shared genKey", () => {
    const patch = mapJobItemsToDraftPatch(
      [item({ recipientKey: 'a', status: 'done', result: { subject: 'S', body: '**hi**' } })],
      map,
      ph,
    );
    expect(patch.map((p) => p.genKey).sort()).toEqual(['individual:a', 'list:L:a']);
    expect(patch.every((p) => p.status === 'ready')).toBe(true);
    expect(patch[0]!.subject).toBe('S');
    expect(patch[0]!.body).toContain('<strong>hi</strong>'); // markdown converted + sanitized
  });

  it("'failed' produces an error placeholder per genKey", () => {
    const patch = mapJobItemsToDraftPatch([item({ recipientKey: 'b', status: 'failed' })], map, ph);
    expect(patch).toHaveLength(1);
    expect(patch[0]).toMatchObject({
      genKey: 'individual:b',
      status: 'error',
      subject: 'PH individual:b',
    });
  });

  it('skipped / non-terminal items are omitted (left for a later poll)', () => {
    const patch = mapJobItemsToDraftPatch(
      [
        item({ recipientKey: 'a', status: 'skipped' }),
        item({ recipientKey: 'b', status: 'generating' }),
      ],
      map,
      ph,
    );
    expect(patch).toHaveLength(0);
  });

  it('ignores items whose recipientKey maps to no slot', () => {
    const patch = mapJobItemsToDraftPatch(
      [item({ recipientKey: 'unknown', status: 'done', result: { subject: 'x', body: 'y' } })],
      map,
      ph,
    );
    expect(patch).toHaveLength(0);
  });
});

describe('transientStatusByGenKey', () => {
  it('maps pending→queued and claimed/generating→generating, fanned to genKeys', () => {
    const map = buildResultIdToGenKeys([slot('individual:a', 'a'), slot('individual:b', 'b')]);
    const t = transientStatusByGenKey(
      [
        item({ recipientKey: 'a', status: 'pending' }),
        item({ recipientKey: 'b', status: 'claimed' }),
      ],
      map,
    );
    expect(t['individual:a']).toBe('queued');
    expect(t['individual:b']).toBe('generating');
  });
});

// ── Phase 0 (plan §3.g2 / §5.4) ──────────────────────────────────────────────

describe('mapJobItemsToDraftPatch — held content is PRESERVED', () => {
  const ph = (genKey: string) => ({ subject: `PH ${genKey}`, body: 'placeholder body' });

  it('a held item keeps its real subject/body and carries the version metadata', () => {
    const map = buildResultIdToGenKeys([slot('individual:a', 'a')]);
    const patch = mapJobItemsToDraftPatch(
      [
        item({
          recipientKey: 'a',
          status: 'held',
          result: {
            subject: 'Funding update',
            body: 'H.R.1 was signed into law.',
            versionId: 'v-1',
            artifactId: 'art-1',
            version: 1,
            auditStatus: 'held',
            approvalStatus: 'pending',
            reviewRequestId: 'rr-1',
            contextNote: 'Unverified — 1 grounding finding',
          },
        }),
      ],
      map,
      ph,
    );
    expect(patch).toHaveLength(1);
    expect(patch[0]!.status).toBe('held');
    // The real content survives — NOT the failure placeholder.
    expect(patch[0]!.subject).toBe('Funding update');
    expect(patch[0]!.body).toContain('H.R.1');
    expect(patch[0]!.body).not.toContain('placeholder');
    // …and the version metadata lets the wizard link to the review.
    expect(patch[0]!.versionId).toBe('v-1');
    expect(patch[0]!.auditStatus).toBe('held');
    expect(patch[0]!.reviewRequestId).toBe('rr-1');
    expect(patch[0]!.contextNote).toMatch(/Unverified/);
  });

  it('a FAILED item still gets the placeholder (there is no content to keep)', () => {
    const map = buildResultIdToGenKeys([slot('individual:a', 'a')]);
    const patch = mapJobItemsToDraftPatch(
      [item({ recipientKey: 'a', status: 'failed', result: null })],
      map,
      ph,
    );
    expect(patch[0]!.status).toBe('error');
    expect(patch[0]!.subject).toBe('PH individual:a');
  });

  it('a done item carries its version metadata too', () => {
    const map = buildResultIdToGenKeys([slot('individual:a', 'a')]);
    const patch = mapJobItemsToDraftPatch(
      [
        item({
          recipientKey: 'a',
          status: 'done',
          result: { subject: 'S', body: 'B', versionId: 'v-2', auditStatus: 'passed' },
        }),
      ],
      map,
      ph,
    );
    expect(patch[0]!.status).toBe('ready');
    expect(patch[0]!.versionId).toBe('v-2');
  });
});

describe('jobItemsProgress — held is terminal', () => {
  it('counts held separately and includes it in settled', () => {
    const p = jobItemsProgress(
      [
        item({ recipientKey: 'a', status: 'done' }),
        item({ recipientKey: 'b', status: 'held' }),
        item({ recipientKey: 'c', status: 'failed' }),
      ],
      'partial',
    );
    expect(p.done).toBe(1);
    expect(p.held).toBe(1);
    expect(p.failed).toBe(1);
    // Excluding held would leave the progress bar stuck short of 100% forever on
    // a job whose every draft was held.
    expect(p.settled).toBe(3);
    expect(p.total).toBe(3);
  });

  it('an all-held job is fully settled', () => {
    const p = jobItemsProgress([item({ recipientKey: 'a', status: 'held' })], 'partial');
    expect(p.settled).toBe(p.total);
    expect(p.done).toBe(0);
  });
});
