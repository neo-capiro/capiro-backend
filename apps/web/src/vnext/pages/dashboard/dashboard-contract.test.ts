// Phase 2 Dashboard contract tests. These lock the module rules the brief makes
// normative: what Needs Attention may carry, that a failed request is never
// reported as zero, and that the Dashboard stays all-client.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectAttentionItems } from '../../adapters/legacy/useDashboardVNextModel.js';
import type {
  IntelligenceChange,
  PortfolioAlertItem,
} from '../../../pages/intelligence/types.js';

function alert(overrides: Partial<PortfolioAlertItem>): PortfolioAlertItem {
  return {
    id: 'a1',
    type: 'hearing',
    severity: 'high',
    title: 'HASC markup',
    subtitle: 'House Armed Services',
    when: new Date().toISOString(),
    countdownDays: 2,
    countdownLabel: 'in 2 days',
    href: '/legiwatch',
    clientId: 'c1',
    clientName: 'Overland AI',
    ...overrides,
  };
}

function change(overrides: Partial<IntelligenceChange>): IntelligenceChange {
  return {
    id: 'ch1',
    source: 'appropriations',
    changeType: 'pe_mark_added',
    severity: 'critical',
    title: 'Army robotics mark reduced',
    description: 'HAC-D reduced the line by $22.7M',
    relatedClientIds: [],
    relatedIssues: [],
    data: {},
    detectedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Needs Attention module contract', () => {
  it('excludes overdue comments', () => {
    const items = selectAttentionItems({
      alerts: [alert({ id: 'overdue', type: 'comment_overdue' })],
      changes: [],
      failedSourceReason: null,
    });

    expect(items).toHaveLength(0);
  });

  it('includes external deadlines, hearings and legislative movement', () => {
    const items = selectAttentionItems({
      alerts: [
        alert({ id: 'd', type: 'comment_deadline' }),
        alert({ id: 'h', type: 'hearing' }),
        alert({ id: 'b', type: 'bill_movement' }),
      ],
      changes: [],
      failedSourceReason: null,
    });

    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining(['alert-d', 'alert-h', 'alert-b']),
    );
  });

  it('excludes alert types outside the external taxonomy', () => {
    const items = selectAttentionItems({
      alerts: [
        alert({ id: 'x', type: 'internal_review' }),
        alert({ id: 'y', type: 'crm_task' }),
        alert({ id: 'z', type: 'assigned_action' }),
      ],
      changes: [],
      failedSourceReason: null,
    });

    expect(items).toHaveLength(0);
  });

  it('carries only material intelligence changes', () => {
    const items = selectAttentionItems({
      alerts: [],
      changes: [
        change({ id: 'low', severity: 'low', relatedClientIds: ['c1'] }),
        change({ id: 'big', severity: 'critical', relatedClientIds: ['c1'] }),
      ],
      failedSourceReason: null,
    });

    expect(items.map((item) => item.id)).toEqual(['change-big']);
  });

  // Regression: os.capiro.ai served four rows of pipeline telemetry
  // ("379954 new LDA filings synced") because severity alone let the ingestion
  // feed through. Needs Attention is client-facing work, so an item must be
  // attributable to at least one client.
  it('excludes portfolio-wide ingestion counters that carry no client', () => {
    const items = selectAttentionItems({
      alerts: [],
      changes: [
        change({
          id: 'ingest',
          severity: 'high',
          title: '379954 new LDA filings synced',
          relatedClientIds: [],
        }),
      ],
      failedSourceReason: null,
    });

    expect(items).toHaveLength(0);
  });

  it('raises material source failures but not configuration states', () => {
    const failure = selectAttentionItems({
      alerts: [],
      changes: [],
      failedSourceReason: 'provider_unavailable',
    });
    expect(failure.map((item) => item.id)).toEqual(['source-news']);

    const noClients = selectAttentionItems({
      alerts: [],
      changes: [],
      failedSourceReason: 'no_clients',
    });
    expect(noClients).toHaveLength(0);
  });

  it('orders critical items first', () => {
    const items = selectAttentionItems({
      alerts: [
        alert({ id: 'normal', type: 'hearing', severity: 'normal' }),
        alert({ id: 'crit', type: 'comment_deadline', severity: 'critical' }),
      ],
      changes: [],
      failedSourceReason: null,
    });

    expect(items[0]!.id).toBe('alert-crit');
    expect(items[0]!.kind).toBe('CRITICAL');
  });
});

describe('dashboard source contract', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/vnext/adapters/legacy/useDashboardVNextModel.ts'),
    'utf8',
  );

  it('reuses the canonical dashboard query keys rather than creating new caches', () => {
    for (const key of [
      "'portfolio-alerts'",
      "'intel-changes-tracked'",
      "'coming-up'",
      "'engagement-meetings-week'",
      "'dashboard-news-custom'",
      "'dashboard-work-outreach'",
      "'dashboard-workspace-drafts'",
    ]) {
      expect(source).toContain(key);
    }
  });

  it('stays all-client — no client filter is read or sent', () => {
    expect(source).not.toContain('useClientFilter');
    expect(source).not.toContain('selectedClientId');
  });

  it('orders Today & Coming Up by real instant, not the rendered time string', () => {
    // Regression: the week query returns every day's meetings, so sorting by
    // "10:00 AM" interleaved each day's recurring standup indistinguishably.
    expect(source).toContain('a.at - b.at');
    expect(source).not.toContain('a.time.localeCompare(b.time)');
  });

  it('never turns a failed request into a zero or empty result', () => {
    // Each module must branch on isError before it can report empty.
    const unavailableBranches = source.match(/'unavailable' as DashboardModuleState/g) ?? [];
    expect(unavailableBranches.length).toBeGreaterThanOrEqual(4);
  });
});
