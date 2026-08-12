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

const source = readFileSync(
  resolve(process.cwd(), 'src/vnext/adapters/legacy/useDashboardVNextModel.ts'),
  'utf8',
);

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
    expect(items[0]!.severity).toBe('critical');
    // Badge names the kind of work; severity rides the tone axis instead, so an
    // urgent comment deadline still reads DEADLINE rather than CRITICAL.
    expect(items[0]!.kind).toBe('DEADLINE');
  });

  it('caps rendered rows to the card budget while reporting the true total', () => {
    const alerts = Array.from({ length: 32 }, (_, index) =>
      alert({ id: `a${index}`, type: 'hearing' }),
    );
    const items = selectAttentionItems({ alerts, changes: [], failedSourceReason: null });

    // selectAttentionItems returns everything; the module applies the budget.
    expect(items).toHaveLength(32);
    expect(source).toContain('limits.attention');
    // Density changes how many rows are visible, never what they mean, so all
    // three modes must declare a budget for every module (760:2695).
    for (const mode of ['presentation', 'standard', 'compact']) {
      expect(source).toMatch(new RegExp(`${mode}: \\{ attention: \\d+, news: \\d+, today: \\d+, work: \\d+ \\}`));
    }
  });
});

describe('dashboard source contract', () => {
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

  it('stays all-client — scope is cleared, never used to narrow a request', () => {
    // Acceptance A (760:2740) requires the Dashboard to *clear* hidden client
    // scope, so it does touch the filter — but only to reset it. The guarantee
    // that matters is that no request is ever scoped by client.
    expect(source).toContain('setSelectedClientId(null)');
    expect(source).not.toMatch(/params:\s*\{[^}]*\bclientId\b/);
    expect(source).not.toMatch(/\bclientId:\s*selectedClientId/);
    // The only read of the selection is the equality guard on the clear.
    const reads = source.match(/selectedClientId/g) ?? [];
    expect(reads.length).toBeLessThanOrEqual(3);
  });

  it('keeps Needs Attention out of the reorderable set and pinned at 00', () => {
    // Customization contract (760:2683): Needs Attention is excluded from the
    // hide/reorder controls and always renders first.
    expect(source).toContain("export type DashboardModuleKey = 'news' | 'today' | 'work'");
    expect(source).toContain("DEFAULT_ORDER: readonly DashboardModuleKey[] = ['news', 'today', 'work']");

    const drawer = readFileSync(resolve(process.cwd(), 'src/vnext/pages/dashboard/CustomizeDrawer.tsx'), 'utf8');
    expect(drawer).toContain('uui-dash-drawer__module--pinned');
    expect(drawer).toContain('>00<');
    // The pinned row carries a static PINNED pill, never a visibility switch.
    const pinnedRow = drawer.slice(
      drawer.indexOf('uui-dash-drawer__module--pinned'),
      drawer.indexOf('Optional modules'),
    );
    expect(pinnedRow).not.toContain('role="switch"');
  });

  it('keeps the relevance explanation at every density', () => {
    // Regression, caught on os.capiro.ai: compact density hid
    // .capiro-dash-news__reason, so stories showed source and client but no
    // relevance. Acceptance D (760:2755) requires every story to explain it.
    const css = readFileSync(
      resolve(process.cwd(), 'src/vnext/pages/dashboard/dashboard.css'),
      'utf8',
    );
    expect(css).not.toMatch(/\[data-density='compact'\][^\n]*__reason[^\n]*display:\s*none/);
  });

  it('renders Customize as a full-height drawer, not a popover', () => {
    // 754:2766 is a 390×936 right drawer with its own News Grid and density
    // section — the earlier 244px popover was the wrong component.
    const view = readFileSync(resolve(process.cwd(), 'src/vnext/pages/dashboard/DashboardVNext.tsx'), 'utf8');
    expect(view).toContain('CustomizeDrawer');
    expect(view).not.toContain('capiro-dash__customize-panel');

    const drawer = readFileSync(resolve(process.cwd(), 'src/vnext/pages/dashboard/CustomizeDrawer.tsx'), 'utf8');
    expect(drawer).toContain('aria-modal="true"');
    expect(drawer).toContain('Information density');
    expect(drawer).toContain('News &amp; Narrative');
  });

  it('orders Today & Coming Up by real instant, not the rendered time string', () => {
    // Regression: the week query returns every day's meetings, so sorting by
    // "10:00 AM" interleaved each day's recurring standup indistinguishably.
    expect(source).toContain('a.at - b.at');
    expect(source).not.toContain('a.time.localeCompare(b.time)');
  });

  it('never turns a failed request into a zero or empty result', () => {
    // State selection is centralised in buildStatus, so the guarantee is
    // checked once there: a module only reaches its empty state after every
    // source has answered without error. Failures surface as unavailable or,
    // when a prior result survives, stale (760:2692).
    const buildStatus = source.slice(source.indexOf('function buildStatus'));
    const emptyIndex = buildStatus.indexOf('state: emptyKind');
    expect(emptyIndex).toBeGreaterThan(-1);
    const beforeEmpty = buildStatus.slice(0, emptyIndex);
    expect(beforeEmpty).toContain("state: 'unavailable'");
    expect(beforeEmpty).toContain("state: 'stale'");
    expect(beforeEmpty).toContain("state: 'partial'");

    // Every module must hand its real error/loading flags to buildStatus.
    for (const flag of [
      'portfolioAlerts.isError',
      'recentChanges.isError',
      'meetings.isError',
      'comingUp.isError',
      'outreach.isError',
      'workspaceDrafts.isError',
    ]) {
      expect(source).toContain(flag);
    }
  });
});
