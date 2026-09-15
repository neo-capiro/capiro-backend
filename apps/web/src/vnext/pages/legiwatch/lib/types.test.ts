/** LW-07 — watch-management tab aliases must resolve to the settings tab (the
 *  real watchlist / preset management view), never fall through to Hearings. */
import { describe, expect, it } from 'vitest';

import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';
import { LEGIWATCH_TABS, REMOVED_TABS, TAB_ALIASES, packetBand } from './types.js';

describe('LW-07 — watch-management tab aliases', () => {
  it('maps every legacy watch-management tab name to settings', () => {
    for (const name of ['watchlist', 'watchlists', 'watches', 'presets']) {
      expect(TAB_ALIASES[name], name).toBe('settings');
    }
  });

  it('no longer treats watchlist names as removed fall-through tabs', () => {
    expect(REMOVED_TABS.has('watchlist')).toBe(false);
    expect(REMOVED_TABS.has('watchlists')).toBe(false);
  });

  it('alias targets are real, URL-addressable tabs', () => {
    for (const target of Object.values(TAB_ALIASES)) {
      expect(LEGIWATCH_TABS).toContain(target);
    }
  });
});

/** Feed-band truthfulness: the production defect was ordinary federal bill
 *  changes (bill_text_changed / bill_new_match, severities notable/info)
 *  rendered as DEADLINE. The FeedItem DTO carries no deadline semantics, so
 *  the band must name the real kind and never invent a deadline. */
describe('packetBand — truthful kind labels', () => {
  const item = (over: Partial<FeedItem>): FeedItem =>
    ({
      id: 'a1',
      clientId: 'c1',
      sourceType: 'bill',
      kind: 'bill_text_changed',
      severity: 'notable',
      materiality: 'medium',
      score: 0.5,
      clientImpact: null,
      urgency: null,
      title: 't',
      whyItMatters: null,
      recommendedAction: null,
      evidence: {},
      status: 'new',
      createdAt: '2026-09-01T00:00:00.000Z',
      ...over,
    }) as FeedItem;

  it('labels a federal bill text change as BILL, never DEADLINE', () => {
    expect(packetBand(item({ kind: 'bill_text_changed', severity: 'notable' }))).toEqual({
      band: 'BILL',
      tone: 'gray',
    });
  });

  it('labels a new matched bill as BILL, never DEADLINE', () => {
    expect(packetBand(item({ kind: 'bill_new_match', severity: 'info' }))).toEqual({
      band: 'BILL',
      tone: 'gray',
    });
  });

  it('keeps critical severity as CRITICAL/error regardless of source kind', () => {
    expect(packetBand(item({ severity: 'critical' }))).toEqual({ band: 'CRITICAL', tone: 'error' });
    expect(packetBand(item({ sourceType: 'state_bill', severity: 'critical' }))).toEqual({
      band: 'CRITICAL',
      tone: 'error',
    });
  });

  it('preserves the known hearing/combined/state/regulation/budget mappings', () => {
    expect(packetBand(item({ sourceType: 'hearing' })).band).toBe('HEARING');
    expect(packetBand(item({ sourceType: 'combined' })).band).toBe('HEARING');
    expect(packetBand(item({ sourceType: 'state_bill' })).band).toBe('STATE BILL');
    expect(packetBand(item({ sourceType: 'regulation' })).band).toBe('REGULATION');
    expect(packetBand(item({ sourceType: 'program_element' })).band).toBe('BUDGET');
  });

  it('degrades an unknown future sourceType to the neutral UPDATE, never a deadline', () => {
    const future = item({ sourceType: 'court_filing' as unknown as FeedItem['sourceType'] });
    expect(packetBand(future)).toEqual({ band: 'UPDATE', tone: 'gray' });
  });
});
