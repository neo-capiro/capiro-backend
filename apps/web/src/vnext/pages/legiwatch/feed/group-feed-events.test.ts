import { describe, expect, it } from 'vitest';
import { groupFeedEvents } from './group-feed-events.js';
import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';

const item = (id: string, clientId: string, hash = 'revision-a'): FeedItem => ({
  id, clientId, sourceType: 'bill', kind: 'bill_text_changed', createdAt: '2026-10-04T12:00:00Z',
  severity: 'notable', materiality: 'medium', score: 0.5, clientImpact: null, urgency: null,
  title: 'Text updated', whyItMatters: null, recommendedAction: null, status: 'new',
  evidence: { bill: { billId: 'hr8800-119', displayNum: 'H.R. 8800', title: null, url: null, stage: 'passed_chamber', actionDate: '2026-10-04', actionText: 'Text updated' }, extra: { contentHash: hash } },
});

describe('bill update grouping', () => {
  it('keeps every client alert while presenting one observation', () => {
    const alerts = [item('one', 'client-a'), item('two', 'client-b'), item('three', 'client-c')];
    expect(groupFeedEvents(alerts)).toEqual([alerts]);
  });
  it('keeps distinct revisions and event kinds separate', () => {
    const a = item('one', 'client-a'), b = item('two', 'client-a', 'revision-b');
    const c = { ...a, id: 'three', kind: 'bill_status_changed' };
    expect(groupFeedEvents([a, b, c])).toEqual([[a], [b], [c]]);
  });
  it('does not collapse hearing alerts or alerts lacking bill identity', () => {
    const a = { ...item('one', 'client-a'), sourceType: 'hearing' } as FeedItem;
    const b = { ...a, id: 'two' };
    expect(groupFeedEvents([a, b])).toEqual([[a], [b]]);
  });
});
