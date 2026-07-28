/**
 * Section 1, Snapshot
 * Fetches comment alerts, recent changes, meetings, and client profile.
 * Renders: hero metrics, Meri briefing, top alerts, 90-day activity strip.
 */
import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Skeleton } from 'antd';
import { useApi } from '../../../../lib/use-api.js';
import type { ClientIntelProfile, HealthScore, CommentAlert } from '../mappers.js';
import { daysUntil, formatDate, type ClientProfileV1 } from '../mappers.js';
import { BriefingCard } from '../components/BriefingCard.js';
import { HelpTip } from '../components/HelpTip.js';
import { TopAlertsList } from '../components/TopAlertsList.js';

interface SnapshotSectionProps {
  clientId: string;
  clientName: string;
  profile?: ClientIntelProfile | null;
  aggregate?: ClientProfileV1;
}

export function SnapshotSection({
  clientId,
  clientName,
  profile: profileFromParent,
  aggregate,
}: SnapshotSectionProps) {
  const api = useApi();

  const profile = profileFromParent ?? null;

  /* ── Engagement health score ── */
  const healthQuery = useQuery<HealthScore | null>({
    queryKey: ['client-health-score', clientId],
    queryFn: async () => {
      try {
        return (await api.get<HealthScore>(`/api/intelligence/clients/${clientId}/health-score`))
          .data;
      } catch {
        return null;
      }
    },
    enabled: !!clientId,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Comment alerts (global; filter by client) ── */
  const alertsQuery = useQuery<{ alerts: CommentAlert[] }>({
    queryKey: ['comment-alerts'],
    queryFn: async () =>
      (await api.get<{ alerts: CommentAlert[] }>('/api/intelligence/comment-alerts')).data,
    staleTime: 5 * 60 * 1000,
  });

  /* ── Recent intelligence changes (7 days) ── */
  const sinceDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString();
  }, []);

  const changesQuery = useQuery<{ id: string; title: string; severity: string }[]>({
    queryKey: ['intel-changes-snap', clientId, sinceDate],
    // No `limit` param: ChangesQueryDto does not declare one and the global
    // ValidationPipe runs whitelist + forbidNonWhitelisted, so sending it made
    // every request 400 (getChanges takes no limit argument either, so it
    // never capped anything even before it started failing). No try/catch: a
    // caught failure here used to render as "No new events this week" — a
    // confident wrong answer indistinguishable from a real zero. Letting the
    // query fail lets meriText read `changesQuery.isError` and say so instead.
    queryFn: async () =>
      (
        await api.get<{ id: string; title: string; severity: string }[]>(
          '/api/intelligence/changes',
          { params: { clientId, since: sinceDate } },
        )
      ).data,
    staleTime: 2 * 60 * 1000,
  });

  /* ── Meetings (last 14 days) ── */
  // Kept at 14 days to match the "Activity · 14 days" panel header. This is
  // only used as a fallback meetings count when the aggregate profile-v1
  // endpoint doesn't supply activity14d; using a 90-day window here made the
  // "Meetings" bar silently represent a different window than its label.
  const meetingsFrom = useMemo(
    () => new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    [],
  );
  // No try/catch: see changesQuery above for why. A failed fetch here used to
  // render as "0 meetings" in the Activity bar's critical-red styling AND as
  // "No meetings logged this quarter" in the briefing — both confident wrong
  // answers. `meetingsQuery.isError` lets both render sites say "unknown".
  const meetingsQuery = useQuery<unknown[]>({
    queryKey: ['client-meetings-snap', clientId, meetingsFrom],
    queryFn: async () =>
      (
        await api.get<unknown[]>('/api/engagement/meetings', {
          params: { clientId, from: meetingsFrom },
        })
      ).data,
    staleTime: 60_000,
  });

  const fallbackAlerts = (alertsQuery.data?.alerts ?? []).filter((a) => a.clientId === clientId);
  const clientAlerts = aggregate?.sections.snapshot.topAlerts?.length
    ? aggregate.sections.snapshot.topAlerts.map((a, idx) => ({
        documentId: `${a.type}-${idx}`,
        title: a.title,
        type: a.type,
        commentEndDate: a.when,
        daysToDeadline: daysUntil(a.when) ?? 0,
        severity: a.severity,
        agencies: a.subtitle ? [a.subtitle] : [],
        clientId,
        clientName,
        relevanceScore: 1,
      }))
    : fallbackAlerts;
  const criticalAlerts = clientAlerts.filter((a) => (a.daysToDeadline ?? 99) <= 7);
  const changes = changesQuery.data ?? [];
  const meetings = meetingsQuery.data ?? [];
  const trackedTotal =
    aggregate?.sections.legislativeRegulatory.kanban.total ?? profile?.relevantBills?.total ?? 0;
  const activityRows = aggregate?.sections.snapshot.activity14d ?? null;
  // The Meetings bar's number falls back to meetingsQuery only when the
  // aggregate has no activity14d — when activityRows is present, meetingsQuery
  // isn't consulted for the bar at all, so its failure only matters here.
  const meetingsBarUnknown = !activityRows && meetingsQuery.isError;
  const activityMeetings = activityRows
    ? activityRows.reduce((sum, d) => sum + d.meetings, 0)
    : meetings.length;
  // Aggregate the 14-day breakdown into 5 totals the mockup specifies:
  // Meetings / Outreach sent / Tasks done / Bills tracked / Critical alerts.
  // `outreach` is optional on the row type (older API responses didn't
  // include it); treat undefined as 0.
  const activityOutreach = activityRows
    ? activityRows.reduce((sum, d) => sum + (d.outreach ?? 0), 0)
    : 0;
  // Bars are scaled to the largest single category so the visual emphasis
  // is "which kind of activity dominates", not the absolute totals.
  const activityMax = Math.max(
    activityMeetings,
    activityOutreach,
    trackedTotal,
    criticalAlerts.length,
    1,
  );
  // Whether there is any CRM activity at all in the window. When everything is
  // zero we render a compact empty state instead of flat zero-bars, which
  // read as a broken/empty chart. An unknown Meetings count must NOT collapse
  // into this empty state — "we don't know" is a different claim from "there
  // was genuinely nothing", and the empty state's copy asserts the latter.
  const hasActivity =
    activityMeetings > 0 ||
    activityOutreach > 0 ||
    trackedTotal > 0 ||
    criticalAlerts.length > 0 ||
    meetingsBarUnknown;
  return (
    <section id="snapshot" className="iv1-section">
      {/* ── Section heading ── */}
      <div className="iv1-sec-head">
        <span className="iv1-sec-num">1</span>
        <h2>Snapshot</h2>
        <span className="iv1-sec-sub">30-second status · what changed today</span>
      </div>

      {/* ── Hero: Meri briefing ── */}
      {healthQuery.isLoading && !aggregate && !profile ? (
        <Skeleton active paragraph={{ rows: 3 }} style={{ marginBottom: 14 }} />
      ) : (
        <div className="iv1-snap-hero">
          {/* Meri briefing */}
          <BriefingCard
            briefing={aggregate?.sections.snapshot.dailyBriefing ?? null}
            fallbackSummary={meriText(
              profile,
              clientAlerts,
              changes.length,
              meetings.length,
              clientName,
              changesQuery.isError,
              meetingsQuery.isError,
            )}
            ctaHref={aggregate?.links.changesInbox ?? '/intelligence/changes'}
          />
        </div>
      )}

      {/* ── Bottom row: Alerts | Activity ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 14, marginTop: 14 }}>
        {/* Top alerts */}
        <TopAlertsList
          aggregate={aggregate}
          fallbackAlerts={clientAlerts}
          loading={alertsQuery.isLoading}
          clientId={clientId}
          hiddenCount={aggregate?.sections.snapshot.alertsHiddenCount}
          links={{
            viewAllHref: aggregate?.links.changesInbox ?? '/intelligence/changes',
            mappingsHref: aggregate?.links.mappingsAdmin ?? '/settings/intelligence-mappings',
          }}
        />

        {/* Activity 14-day summary */}
        <div className="iv1-surface">
          <div className="iv1-surface-head">
            <h3>
              Activity · 14 days{' '}
              <HelpTip title="Your logged CRM activity for this client over the last 14 days — meetings, outreach sent, relevant bills matched, and critical alerts. A flat or empty panel is a prompt to re-engage. (Curated bill tracking lives in the Tracker tab.)" />
            </h3>
            <span className="iv1-surface-sub">CRM signals</span>
          </div>
          <div className="iv1-surface-body">
            {/* When the client has any CRM activity in the window we show the
                sparkline + per-category bars; otherwise a compact empty state
                so the panel doesn't read as a broken chart of flat zero-bars. */}
            {hasActivity ? (
              <>
                {activityRows && activityRows.length > 0 && (
                  <ActivitySparkline rows={activityRows} />
                )}
                <ActivityBar
                  label="Meetings"
                  value={activityMeetings}
                  max={activityMax}
                  color={activityMeetings === 0 ? 'var(--ink-4)' : 'var(--accent)'}
                  criticalIfZero
                  unknown={meetingsBarUnknown}
                />
                <ActivityBar
                  label="Outreach sent"
                  value={activityOutreach}
                  max={activityMax}
                  color={activityOutreach === 0 ? 'var(--ink-4)' : 'var(--info)'}
                />
                <ActivityBar
                  label="Relevant bills"
                  value={trackedTotal}
                  max={Math.max(trackedTotal, activityMax, 1)}
                  color="var(--info)"
                />
                <ActivityBar
                  label="Critical alerts"
                  value={criticalAlerts.length}
                  max={Math.max(criticalAlerts.length, clientAlerts.length, 1)}
                  color={criticalAlerts.length > 0 ? 'var(--critical)' : 'var(--ink-4)'}
                />
              </>
            ) : (
              <div className="iv1-empty" style={{ padding: '20px 8px 16px', textAlign: 'center' }}>
                <b>No activity in the last 14 days</b>
                <span>Logged meetings, outreach, and tracked bills will appear here.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── Sub-components ──────────────────────────────────────────────── */

/**
 * Tiny inline-SVG sparkline above the Activity row list.
 *
 * Renders one stacked bar per day from `activity14d`. Total daily activity
 * is meetings + outreach + tasks + debriefs (emails intentionally excluded
 *, they're noisy and not in the 5-row breakdown below). Height is fixed
 * at 28px; width fills the parent.
 *
 * Empty input → renders nothing (the caller already gates with a length
 * check). Single-spike-day → that bar reaches the full height; quieter
 * days sit proportionally low.
 */
function ActivitySparkline({
  rows,
}: {
  rows: Array<{
    date: string;
    meetings: number;
    tasks: number;
    debriefs: number;
    outreach?: number;
  }>;
}) {
  const totals = rows.map((d) => d.meetings + d.tasks + d.debriefs + (d.outreach ?? 0));
  const max = Math.max(...totals, 1);
  const barW = 100 / rows.length;
  const gap = 0.5;
  return (
    <div
      style={{
        marginBottom: 14,
        paddingBottom: 12,
        borderBottom: '1px solid var(--border-1)',
      }}
    >
      <svg
        viewBox="0 0 100 28"
        preserveAspectRatio="none"
        role="img"
        aria-label="Daily activity over the last 14 days"
        style={{ width: '100%', height: 28, display: 'block' }}
      >
        {totals.map((value, i) => {
          const h = (value / max) * 26;
          // Days with no activity still get a 1px nub so the user can
          // scan the cadence without empty gaps reading as "no chart".
          const minH = 1;
          const finalH = value === 0 ? minH : Math.max(h, 2);
          return (
            <rect
              key={i}
              x={i * barW + gap / 2}
              y={28 - finalH}
              width={barW - gap}
              height={finalH}
              rx={0.6}
              fill={value === 0 ? 'var(--ink-4)' : 'var(--accent)'}
              opacity={value === 0 ? 0.4 : 0.85}
            />
          );
        })}
      </svg>
    </div>
  );
}

function ActivityBar({
  label,
  value,
  max,
  color,
  criticalIfZero = false,
  unknown = false,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  criticalIfZero?: boolean;
  /** The fetch behind this metric failed. Render "—", never a confident 0 —
   *  `criticalIfZero` would otherwise paint an unknown value critical-red,
   *  asserting a problem ("zero meetings") the data never actually showed. */
  unknown?: boolean;
}) {
  const pct = unknown ? 0 : max > 0 ? Math.round((value / max) * 100) : 0;
  const isCritical = !unknown && criticalIfZero && value === 0;
  return (
    <div className="iv1-activity-row">
      <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{label}</span>
      <div className="iv1-bar-track">
        <div
          className="iv1-bar-fill"
          style={{ width: `${pct}%`, background: unknown ? 'var(--ink-4)' : color }}
        />
      </div>
      <span
        className="num"
        style={{
          textAlign: 'right',
          fontWeight: 500,
          fontSize: 12,
          color: isCritical ? 'var(--critical)' : 'var(--ink-1)',
        }}
        title={unknown ? "Couldn't load this metric. Try refreshing." : undefined}
      >
        {unknown ? '—' : value}
      </span>
    </div>
  );
}

function meriText(
  profile: ClientIntelProfile | null,
  alerts: CommentAlert[],
  changeCount: number,
  meetingCount: number,
  clientName: string,
  changesUnknown: boolean,
  meetingsUnknown: boolean,
): ReactNode {
  const critAlerts = alerts.filter((a) => a.daysToDeadline <= 7);
  const totalBills = profile?.relevantBills?.total ?? 0;
  const noMapping = !profile?.lda?.matched && !profile?.contracting?.matched;

  if (!profile) {
    return (
      <>
        Loading intelligence data for <b>{clientName}</b>…
      </>
    );
  }

  if (noMapping) {
    return (
      <>
        No LDA or contract mapping confirmed for <b>{clientName}</b>. Visit <b>Manage sources</b> to
        confirm the intelligence mapping and unlock financial data.
        {totalBills > 0
          ? ` ${totalBills} relevant bills matched from this client's capabilities.`
          : ''}
      </>
    );
  }

  return (
    <>
      {critAlerts.length > 0 && (
        <>
          <mark className="crit">
            {critAlerts.length} comment deadline{critAlerts.length > 1 ? 's' : ''} in the next 7
            days
          </mark>
          {', '}
        </>
      )}
      {totalBills > 0 && (
        <>
          <mark>{totalBills} relevant bills</mark> matching this client&apos;s issues &amp;
          capabilities.{' '}
        </>
      )}
      {/* A failed fetch defaults meetingCount/changeCount to 0 — without the
          isError checks below, "0" and "genuinely none" would read identically. */}
      {meetingCount === 0 && !meetingsUnknown && 'No meetings logged this quarter. '}
      {changesUnknown
        ? 'Recent activity unavailable — try refreshing.'
        : changeCount > 0
          ? `${changeCount} new intel event${changeCount === 1 ? '' : 's'} this week.`
          : 'No new events this week.'}
    </>
  );
}
