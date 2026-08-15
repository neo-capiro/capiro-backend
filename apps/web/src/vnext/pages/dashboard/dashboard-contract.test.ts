import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectAttentionItems } from '../../adapters/legacy/useDashboardVNextModel.js';
import type { IntelligenceChange, PortfolioAlertItem } from '../../../pages/intelligence/types.js';

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

const adapter = readFileSync(resolve(process.cwd(), 'src/vnext/adapters/legacy/useDashboardVNextModel.ts'), 'utf8');
const view = readFileSync(resolve(process.cwd(), 'src/vnext/pages/dashboard/DashboardVNext.tsx'), 'utf8');
const drawer = readFileSync(resolve(process.cwd(), 'src/vnext/pages/dashboard/CustomizeDrawer.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/vnext/pages/dashboard/dashboard.css'), 'utf8');
const meri = readFileSync(resolve(process.cwd(), 'src/vnext/shell/MeriLauncher/index.tsx'), 'utf8');

describe('Dashboard v2 Needs Attention contract', () => {
  it('keeps the triage taxonomy restricted to externally-driven work', () => {
    expect(selectAttentionItems({
      alerts: [
        alert({ id: 'deadline', type: 'comment_deadline' }),
        alert({ id: 'hearing', type: 'hearing' }),
        alert({ id: 'bill', type: 'bill_movement' }),
        alert({ id: 'internal', type: 'internal_review' }),
        alert({ id: 'overdue', type: 'comment_overdue' }),
      ],
      changes: [],
      failedSourceReason: null,
    }).map((item) => item.id)).toEqual(expect.arrayContaining([
      'alert-deadline', 'alert-hearing', 'alert-bill',
    ]));
    expect(selectAttentionItems({
      alerts: [alert({ id: 'internal', type: 'internal_review' }), alert({ id: 'overdue', type: 'comment_overdue' })],
      changes: [],
      failedSourceReason: null,
    })).toHaveLength(0);
  });

  it('rejects portfolio-wide ingestion counters with no client attribution', () => {
    expect(selectAttentionItems({
      alerts: [],
      changes: [change({ id: 'ingest', severity: 'high', relatedClientIds: [], title: '379954 new LDA filings synced' })],
      failedSourceReason: null,
    })).toHaveLength(0);
  });

  it('orders critical client-attributed changes ahead of normal work', () => {
    const items = selectAttentionItems({
      alerts: [alert({ id: 'normal', type: 'hearing', severity: 'normal' })],
      changes: [change({ id: 'critical', severity: 'critical', relatedClientIds: ['c1'] })],
      failedSourceReason: null,
    });
    expect(items[0]?.id).toBe('change-critical');
    expect(items[0]?.kind).toBe('Critical');
  });
});

describe('Dashboard v2 prototype structure', () => {
  it('renders one Wire instead of separate News and X cards', () => {
    expect(view).toContain('The Wire');
    expect(view).toContain('dashv2-wire');
    expect(view).not.toContain('function NewsAndNarrative');
    expect(view).not.toContain('function XIntelligenceFeed');
    expect(view).toContain("type WireFilter = 'all' | 'x' | 'news'");
  });

  it('uses a pinned four-tile triage ribbon and a chronological spine', () => {
    expect(view).toContain('attentionItems.slice(0, 4)');
    expect(view).toContain('dashv2-triage__grid');
    expect(view).toContain('TODAY ·');
    expect(view).toContain('TOMORROW ·');
    expect(view).toContain('LATER THIS WEEK');
    expect(view).toContain('NOW');
    expect(view).toContain('data-clearing');
  });

  it('uses date-only greeting metadata and mobile short date', () => {
    expect(view).not.toContain('model.header.meta');
    expect(view).toContain('formatLongDate()');
    expect(view).toContain('formatShortDate()');
    expect(css).toContain('.dashv2-head__date-short');
  });

  it('interleaves news by the raw provider instant, not the rounded label', () => {
    expect(adapter).toContain('publishedAt?: string');
    expect(adapter).toContain('publishedAt: item.publishedAt');
    expect(view).toContain("Date.parse(item.publishedAt ?? '')");
  });

  it('does not pre-truncate source arrays before v2 combines or groups them', () => {
    expect(adapter).toContain('return { status, items: ordered, total: ordered.length }');
    expect(adapter).not.toContain('items: items.slice(0, limits.news)');
    expect(adapter).not.toContain('.slice(0, limits.today)');
    expect(adapter).toContain('startsAt?: string');
    expect(adapter).toContain('startsAt: meeting.startsAt');
    expect(adapter).toContain('return { status, items, total: items.length }');
  });

  it('never substitutes zero for an unavailable Wire source', () => {
    expect(view).toContain('sourceCountKnown');
    expect(view).toContain("'X unavailable'");
    expect(view).toContain("'News unavailable'");
    expect(view).toContain("'Sources updating'");
  });
});

describe('Dashboard v2 responsive and density contract', () => {
  it('uses the prototype lane widths and responsive breakpoints', () => {
    expect(css).toContain('minmax(0,1.15fr) minmax(360px,1fr)');
    expect(css).toContain('minmax(0,1.42fr) minmax(400px,1fr)');
    expect(css).toContain('@media (max-width: 1099px)');
    expect(css).toContain('@media (max-width: 779px)');
    expect(css).toContain('@media (min-width: 1360px)');
    expect(css).toContain('min-width: 250px');
  });

  it('keeps the Wire sticky with its own internal list scroll', () => {
    expect(css).toMatch(/\.dashv2-wire \{[^}]*position: sticky;[^}]*top: 24px;[^}]*max-height: calc\(100vh - 120px\)/);
    expect(css).toMatch(/\.dashv2-wire__list \{[^}]*overflow-y: auto/);
  });

  it('implements the exact density paddings and combined Wire row caps', () => {
    expect(css).toContain("[data-density='presentation'] .dashv2-spine-row { padding-top: 13px; padding-bottom: 13px; }");
    expect(css).toContain("[data-density='compact'] .dashv2-spine-row { padding-top: 7px; padding-bottom: 7px; }");
    expect(css).toContain("[data-density='presentation'] .dashv2-work-row { padding-top: 15px; padding-bottom: 15px; }");
    expect(css).toContain("[data-density='compact'] .dashv2-wire-row { padding-top: 10px; padding-bottom: 10px; }");
    expect(view).toContain("model.density === 'presentation' ? 6 : 8");
    expect(view).toContain("model.density === 'presentation' ? 3 : model.density === 'compact' ? 5 : 4");
  });

  it('honors reduced motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('Dashboard v2 customization and chrome', () => {
  it('keeps Needs Attention pinned and only reorders the two work-lane modules', () => {
    expect(drawer).toContain('Pinned strip');
    expect(drawer).toContain('dashv2-drawer-card--pinned');
    expect(drawer).toContain("type WorkKey = 'today' | 'work'");
    expect(drawer).toContain('The Wire');
    expect(drawer).toContain('X accounts');
    expect(drawer).toContain('News subscriptions');
    expect(drawer).toContain('Information density');
  });

  it('uses a full-height modal drawer with Escape, outside click and equal footer buttons', () => {
    expect(drawer).toContain('aria-modal="true"');
    expect(drawer).toContain("event.key === 'Escape'");
    expect(drawer).toContain('if (e.target === e.currentTarget) onClose()');
    expect(css).toContain('.dashv2-drawer__footer .capiro-button { flex: 1;');
    expect(css).toContain('height: 44px');
  });

  it('uses the prototype action icons and metallic button face', () => {
    expect(view).toContain('name="Sliders02"');
    expect(view).toContain('name="RefreshCw01"');
    expect(meri).toContain('name="Stars02"');
    expect(view).toContain("linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%)");
  });

  it('keeps component CSS token-only for the foundation gate', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/rgba?\s*\(/i);
  });
});
