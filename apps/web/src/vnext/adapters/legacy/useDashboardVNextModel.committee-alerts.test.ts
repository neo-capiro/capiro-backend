/**
 * committee-follow alerts — selectAttentionItems merge behavior.
 *
 * Pure function coverage: durable committee/hearing notifications merge into
 * Needs Attention as NORMAL severity (never outranking critical/high portfolio
 * work), read rows are excluded, identity is the server notification id, and
 * ordering is severity-then-recency.
 */
import { describe, expect, it } from 'vitest';
import {
  selectAttentionItems,
  type AttentionItem,
} from './useDashboardVNextModel.js';
import type { LwNotification } from '../../pages/legiwatch/lib/wave1-api.js';
import type { IntelligenceChange, PortfolioAlertItem } from '../../../pages/intelligence/types.js';

function lw(over: Partial<LwNotification>): LwNotification {
  return {
    id: 'n-1',
    eventType: 'new_hearing',
    hearingId: 'h-1',
    committeeSystemCode: 'HLIG01',
    clientId: null,
    title: 'Hearing announced: FY27 posture',
    body: 'The committee announced a new proceeding.',
    deepLink: '/legiwatch/committees/HLIG01',
    read: false,
    createdAt: '2026-09-17T10:00:00Z',
    ...over,
  };
}

function criticalAlert(): PortfolioAlertItem {
  return {
    id: 'a-1',
    type: 'contract_award',
    severity: 'critical',
    title: 'Major award modified',
    subtitle: 'Client X',
    clientName: 'Client X',
    href: '/explorer',
    when: null,
    countdownLabel: null,
  } as unknown as PortfolioAlertItem;
}

describe('selectAttentionItems — committee/hearing notifications', () => {
  it('merges unread committee notifications as normal severity with stable id + deepLink', () => {
    const items = selectAttentionItems({
      alerts: [],
      changes: [],
      failedSourceReason: null,
      lwNotifications: [lw({ id: 'n-42' })],
    });
    expect(items).toHaveLength(1);
    const item = items[0] as AttentionItem;
    expect(item.id).toBe('lw-notif-n-42');
    expect(item.severity).toBe('normal');
    expect(item.kind).toBe('Hearing');
    expect(item.href).toBe('/legiwatch/committees/HLIG01');
    expect(item.attentionSource).toBe('lw-notification');
    expect(item.title).toBe('Hearing announced: FY27 posture');
  });

  it('maps committee_publication rows to the Publication badge', () => {
    const items = selectAttentionItems({
      alerts: [],
      changes: [],
      failedSourceReason: null,
      lwNotifications: [
        lw({
          id: 'n-pub',
          eventType: 'committee_publication',
          hearingId: null,
          title: 'Witness testimony published',
        }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('Publication');
    expect(items[0]!.eyebrow).toBe('Committee publication');
  });

  it('excludes read rows (defensive — Needs Attention is unread-only)', () => {
    const items = selectAttentionItems({
      alerts: [],
      changes: [],
      failedSourceReason: null,
      lwNotifications: [lw({ id: 'n-read', read: true }), lw({ id: 'n-unread' })],
    });
    expect(items.map((i) => i.id)).toEqual(['lw-notif-n-unread']);
  });

  it('committee rows never outrank critical portfolio alerts; newest normal first', () => {
    const items = selectAttentionItems({
      alerts: [criticalAlert()],
      changes: [],
      failedSourceReason: null,
      lwNotifications: [
        lw({ id: 'n-old', createdAt: '2026-09-16T09:00:00Z' }),
        lw({ id: 'n-new', createdAt: '2026-09-17T09:00:00Z' }),
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['alert-a-1', 'lw-notif-n-new', 'lw-notif-n-old']);
  });

  it('omitting lwNotifications leaves the existing sources untouched', () => {
    const baseline = selectAttentionItems({
      alerts: [criticalAlert()],
      changes: [],
      failedSourceReason: null,
    });
    expect(baseline.map((i) => i.id)).toEqual(['alert-a-1']);
  });

  it('internal helper fields (_sortAt/_group) never leak onto the output rows', () => {
    const items = selectAttentionItems({
      alerts: [],
      changes: [],
      failedSourceReason: null,
      lwNotifications: [lw({ id: 'n-1' })],
    });
    expect('_sortAt' in items[0]!).toBe(false);
    expect('_group' in items[0]!).toBe(false);
  });

  it('an intelligence change without client attribution is still excluded (regression)', () => {
    const change = {
      id: 'c-1',
      severity: 'critical',
      title: 'Pipeline counter',
      description: '',
      source: 'FEDERAL_REGISTER',
      detectedAt: '2026-09-17T00:00:00Z',
      relatedClientIds: [],
    } as unknown as IntelligenceChange;
    const items = selectAttentionItems({
      alerts: [],
      changes: [change],
      failedSourceReason: null,
      lwNotifications: [lw({ id: 'n-1' })],
    });
    expect(items.map((i) => i.id)).toEqual(['lw-notif-n-1']);
  });
});
