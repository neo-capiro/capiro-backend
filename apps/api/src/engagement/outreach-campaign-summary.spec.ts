import { describe, expect, test } from '@jest/globals';
import {
  campaignCategory,
  decodeCampaignCursor,
  encodeCampaignCursor,
} from './outreach-campaign-summary.js';
import { campaignListSchema, parseCampaign } from './outreach-campaign.contract.js';

describe('canonical Outreach list contracts', () => {
  test('a cursor round-trips its native ID anchor and rejects malformed selectors', () => {
    const cursor = {
      id: '00000000-0000-4000-8000-000000000001',
    };
    expect(decodeCampaignCursor(encodeCampaignCursor(cursor)!)).toEqual(cursor);
    for (const value of [
      'not-json',
      '***',
      Buffer.from(JSON.stringify({ ...cursor, id: 'invalid' })).toString('base64url'),
    ]) {
      expect(() => decodeCampaignCursor(value)).toThrow('Invalid outreach cursor');
    }
  });
  test('query bounds and date windows are validated before the native reader', () => {
    expect(
      parseCampaign(campaignListSchema, { limit: '20', q: 'hearing', view: 'sent' }),
    ).toMatchObject({ limit: 20, q: 'hearing', view: 'sent' });
    for (const query of [
      { limit: '101' },
      { clientId: 'invalid' },
      { view: 'invented' },
      { unknown: 'x' },
      { from: '2026-10-31T00:00:00Z', to: '2026-10-30T00:00:00Z' },
    ]) {
      expect(() => parseCampaign(campaignListSchema, query)).toThrow('Invalid outreach request');
    }
  });
  test.each<
    [string, Parameters<typeof campaignCategory>[2], Parameters<typeof campaignCategory>[3], string]
  >([
    ['sent', null, null, 'sent'],
    ['delivery_unknown', null, null, 'attention'],
    ['draft', { status: 'complete', totals: { sent: 2 } }, null, 'sent'],
    ['sent', { status: 'partial', totals: { sent: 1, failed: 1 } }, null, 'attention'],
    ['draft', { status: 'running', totals: { unknown: 1 } }, null, 'attention'],
    ['draft', { status: 'failed', totals: { held: 1 } }, null, 'attention'],
    [
      'draft',
      null,
      { status: 'partial', params: { revision: 2 }, items: [{ status: 'held' }] },
      'attention',
    ],
    [
      'draft',
      null,
      { status: 'failed', params: { revision: 1 }, items: [{ status: 'failed' }] },
      'drafts',
    ],
    [
      'draft',
      null,
      { status: 'running', params: { revision: 2 }, items: [{ status: 'sdk_running' }] },
      'drafts',
    ],
  ])(
    'classifies actual %s evidence without turning older failures into current attention',
    (status, send, generation, expected) => {
      expect(
        campaignCategory(
          status,
          2,
          send,
          generation ? { ...generation, items: [...generation.items] } : null,
        ),
      ).toBe(expected);
    },
  );
});
