import { ArrowRightOutlined, CheckOutlined } from '@ant-design/icons';
import { Card, Empty, Skeleton, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useBillTarget } from '../bills/bill-target.js';
import type { ProgramElementBill, ProgramElementBillAction } from './types.js';
import { PeSecondaryFailed } from './PeSecondaryFailed.js';

const { Text } = Typography;

export interface BillsTouchingPePanelProps {
  bills: ProgramElementBill[];
  loading?: boolean;

  errored?: boolean;
  onRetry?: () => void;
  /** Phase 5 B15 — /bill-actions failed; must not paint "No action history synced". */
  billActionsErrored?: boolean;
  onRetryBillActions?: () => void;
}

type EventKind = 'reported' | 'committee' | 'passed' | 'president' | 'law' | 'procedural';

interface ActionStyle {
  kind: EventKind;
  label: string;
  chartLabel: string | null;
  rank: number;
}

interface TimelineEvent {
  id: string;
  billId: string;
  billLabel: string;
  date: Date;
  dateKey: string;
  text: string;
  kind: EventKind;
  label: string;
  chartLabel: string | null;
  rank: number;
  chamber: string | null;
}

interface BillLane {
  bill: ProgramElementBill;
  label: string;
  latestDate: Date | null;
  outcomeRank: number;
  events: TimelineEvent[];
}

interface PositionedEvent {
  event: TimelineEvent;
  left: number;
}

interface EventCluster {
  id: string;
  left: number;
  events: TimelineEvent[];
  representative: TimelineEvent;
}

// Congress.gov bill-type codes -> conventional citation form (e.g. HR -> "H.R.").
const BILL_TYPE_LABELS: Record<string, string> = {
  HR: 'H.R.',
  S: 'S.',
  HJRES: 'H.J.Res.',
  SJRES: 'S.J.Res.',
  HCONRES: 'H.Con.Res.',
  SCONRES: 'S.Con.Res.',
  HRES: 'H.Res.',
  SRES: 'S.Res.',
};

const BLANKET_PE_THRESHOLD = 50;

const EVENT_LEGEND: Array<{ kind: EventKind; label: string }> = [
  { kind: 'reported', label: 'Reported' },
  { kind: 'committee', label: 'Committee' },
  { kind: 'passed', label: 'Passed' },
  { kind: 'president', label: 'To President' },
  { kind: 'law', label: 'Became law' },
  { kind: 'procedural', label: 'Other action' },
];

function billLabel(bill: ProgramElementBill): string {
  const type = BILL_TYPE_LABELS[bill.billType?.toUpperCase()] ?? bill.billType ?? '';
  return `${type} ${bill.billNumber}`.trim() || bill.id;
}

function chamberLabel(bill: ProgramElementBill): string {
  const t = (bill.billType ?? '').toUpperCase();
  if (t.startsWith('H')) return 'House';
  if (t.startsWith('S')) return 'Senate';
  return 'Congress';
}

function isBlanketAuthorizer(bill: ProgramElementBill): boolean {
  return (bill.peCodeCount ?? 0) >= BLANKET_PE_THRESHOLD;
}

function parseDateOnly(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) {
    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateKey(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, '0');
  const dd = `${date.getDate()}`.padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatActionDate(value: string | Date | null | undefined): string | null {
  const d = parseDateOnly(value);
  if (!d) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function compactDate(value: Date): string {
  return value.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function actionStyle(text: string): ActionStyle {
  const normalized = text.toLowerCase();

  if (
    normalized.includes('became public law') ||
    normalized.includes('became law') ||
    normalized.includes('signed by president') ||
    /public law no/.test(normalized)
  ) {
    return { kind: 'law', label: 'Became law', chartLabel: 'Became law', rank: 0 };
  }

  if (
    normalized.includes('presented to president') ||
    normalized.includes('to president') ||
    normalized.includes('ordered to be presented')
  ) {
    return { kind: 'president', label: 'To President', chartLabel: 'To President', rank: 1 };
  }

  if (normalized.includes('passed') || normalized.includes('agreed to')) {
    const chamberLabel = normalized.includes('senate')
      ? 'Passed Senate'
      : normalized.includes('house')
        ? 'Passed House'
        : 'Passed';
    return { kind: 'passed', label: chamberLabel, chartLabel: chamberLabel, rank: 2 };
  }

  if (normalized.includes('reported')) {
    return { kind: 'reported', label: 'Reported', chartLabel: 'Reported', rank: 3 };
  }

  if (
    normalized.includes('markup') ||
    normalized.includes('mark-up') ||
    normalized.includes('committee') ||
    normalized.includes('ordered to be reported')
  ) {
    return { kind: 'committee', label: 'Committee action', chartLabel: null, rank: 4 };
  }

  if (
    normalized.includes('calendar') ||
    normalized.includes('cloture') ||
    normalized.includes('referred') ||
    normalized.includes('introduced') ||
    normalized.includes('received') ||
    normalized.includes('read the first') ||
    normalized.includes('read the second')
  ) {
    return { kind: 'procedural', label: 'Procedural', chartLabel: null, rank: 5 };
  }

  return { kind: 'procedural', label: 'Action', chartLabel: null, rank: 5 };
}

function toTimelineEvent(
  bill: ProgramElementBill,
  action: ProgramElementBillAction,
): TimelineEvent | null {
  const date = parseDateOnly(action.date);
  if (!date || !action.text) return null;
  const style = actionStyle(action.text);
  return {
    id: action.id,
    billId: bill.id,
    billLabel: billLabel(bill),
    date,
    dateKey: dateKey(date),
    text: action.text,
    kind: style.kind,
    label: style.label,
    chartLabel: style.chartLabel,
    rank: style.rank,
    chamber: action.chamber,
  };
}

function latestActionEvent(bill: ProgramElementBill): TimelineEvent | null {
  if (!bill.latestActionDate || !bill.latestActionText) return null;
  return toTimelineEvent(bill, {
    id: `${bill.id}-latest`,
    date: bill.latestActionDate,
    text: bill.latestActionText,
    type: null,
    chamber: null,
  });
}

function eventsForBill(bill: ProgramElementBill): TimelineEvent[] {
  const fromActions = (bill.actions ?? [])
    .map((action) => toTimelineEvent(bill, action))
    .filter((event): event is TimelineEvent => event != null);

  const fallback = fromActions.length === 0 ? latestActionEvent(bill) : null;
  const events = fallback ? [fallback] : fromActions;
  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function latestEventDate(events: TimelineEvent[], bill: ProgramElementBill): Date | null {
  if (events.length) return events[events.length - 1]?.date ?? null;
  return parseDateOnly(bill.latestActionDate);
}

function outcomeRank(events: TimelineEvent[], bill: ProgramElementBill): number {
  if (events.length) return Math.min(...events.map((event) => event.rank));
  const fallback = actionStyle(bill.latestActionText ?? '');
  return fallback.rank;
}

function buildLanes(bills: ProgramElementBill[]): BillLane[] {
  return bills
    .map((bill) => {
      const events = eventsForBill(bill);
      return {
        bill,
        label: billLabel(bill),
        latestDate: latestEventDate(events, bill),
        outcomeRank: outcomeRank(events, bill),
        events,
      };
    })
    .sort((a, b) => {
      if (a.outcomeRank !== b.outcomeRank) return a.outcomeRank - b.outcomeRank;
      const aTime = a.latestDate?.getTime() ?? 0;
      const bTime = b.latestDate?.getTime() ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.label.localeCompare(b.label);
    });
}

function timelineRange(
  events: TimelineEvent[],
): { start: number; end: number; years: number[] } | null {
  if (events.length === 0) return null;
  const times = events.map((event) => event.date.getTime());
  const minDate = new Date(Math.min(...times));
  const maxDate = new Date(Math.max(...times));
  const minYear = minDate.getFullYear();
  const maxYear = maxDate.getFullYear();
  const start = new Date(minYear, 0, 1).getTime();
  const end = new Date(maxYear, 11, 31, 23, 59, 59).getTime();
  const years = Array.from({ length: maxYear - minYear + 1 }, (_, idx) => minYear + idx);
  return { start, end, years };
}

function positionForDate(date: Date, start: number, end: number): number {
  if (end <= start) return 0;
  const raw = ((date.getTime() - start) / (end - start)) * 100;
  return Math.max(0, Math.min(100, raw));
}

function clusterEvents(events: TimelineEvent[], start: number, end: number): EventCluster[] {
  const positioned = events.map<PositionedEvent>((event) => ({
    event,
    left: positionForDate(event.date, start, end),
  }));

  const clusters: EventCluster[] = [];
  for (const item of positioned) {
    const last = clusters[clusters.length - 1];
    if (!last || item.left - last.left > 3.1) {
      clusters.push({
        id: item.event.id,
        left: item.left,
        events: [item.event],
        representative: item.event,
      });
      continue;
    }

    last.events.push(item.event);
    last.left =
      last.events.reduce((sum, event) => sum + positionForDate(event.date, start, end), 0) /
      last.events.length;
    last.representative = [...last.events].sort(
      (a, b) => a.rank - b.rank || b.date.getTime() - a.date.getTime(),
    )[0]!;
  }

  return clusters;
}

function yearPosition(year: number, start: number, end: number): number {
  return positionForDate(new Date(year, 0, 1), start, end);
}

function markerContent(kind: EventKind, count: number) {
  if (count > 1) return `+${count}`;
  if (kind === 'law') return <CheckOutlined />;
  if (kind === 'president') return <ArrowRightOutlined />;
  return null;
}

function clusterTooltip(cluster: EventCluster): string {
  return cluster.events
    .map(
      (event) =>
        `${formatActionDate(event.date) ?? event.dateKey} - ${event.billLabel}: ${event.text}`,
    )
    .join('\n');
}

/** Explicit PE-code links are auto-accepted; anything fuzzier stays a candidate. */
const EXPLICIT_LINK_TYPES = new Set(['explicit_pe_code', 'manual']);

/**
 * Match-basis / confidence / package chips for one bill lane (R4 §4.2).
 *
 * Renders nothing when the server sent no link row (a legacy `peCodes`-array link) —
 * an absent basis is shown as absent, never as "explicit". The full evidence string
 * is the hover title so the calm swimlane stays calm.
 */
function PeLinkBasis({ bill }: { bill: ProgramElementBill }) {
  const link = bill.link ?? null;
  const pkg = bill.budgetPackage ?? null;
  if (!link && !pkg) return null;
  const explicit = link ? EXPLICIT_LINK_TYPES.has(link.type) : false;
  return (
    <span className="pe-lane-basis" title={link?.evidence ?? undefined}>
      {pkg ? (
        <span className="pe-basis-chip pkg">
          {pkg.name} · {pkg.track} · {pkg.stage}
        </span>
      ) : null}
      {link ? (
        <span className={`pe-basis-chip ${explicit ? 'explicit' : 'inferred'}`}>
          {explicit ? 'Explicit PE match' : 'Inferred match'}
          {link.status === 'candidate' ? ' · candidate' : ''}
          {` · ${Math.round(link.confidence * 100)}%`}
        </span>
      ) : null}
    </span>
  );
}

export function BillsTouchingPePanel({ bills, loading = false,
  errored = false,
  onRetry,
  billActionsErrored = false,
  onRetryBillActions,
}: BillsTouchingPePanelProps) {
  const navigate = useNavigate();
  // R2 §2.5 routes a bill lane to Bill 360 — but ONLY for a tenant that has it.
  // useBillTarget keeps the Explorer destination for tenants without the flag, so
  // PE Watch never sends anyone to a "not enabled" page.
  const billTarget = useBillTarget();

  if (loading) {
    return (
      <Card title="Legislative bill timeline">
        <Skeleton active paragraph={{ rows: 4 }} />
      </Card>
    );
  }

  if (errored) {
    return (
      <PeSecondaryFailed label="bills" testId="pe-secondary-failed-bills" onRetry={onRetry} />
    );
  }


  if (bills.length === 0) {
    return (
      <Card title="Legislative bill timeline">
        <Empty description="No linked bills yet" />
      </Card>
    );
  }

  const lanes = buildLanes(bills);
  const allEvents = lanes.flatMap((lane) => lane.events);
  const range = timelineRange(allEvents);
  const detailEvents = [...allEvents].sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <Card
      className="pe-bills-card pe-swimlane-card"
      title="Legislative bill timeline"
      extra={
        <Text type="secondary">
          {bills.length} bills / {allEvents.length} actions
        </Text>
      }
    >
      <div className="pe-scroll-5 pe-scroll-swimlane">
        {range ? (
          <div className="pe-swimlane" role="group" aria-label="Bill-by-bill legislative timeline">
            <div className="pe-swimlane-head">
              <div className="pe-swimlane-head-label">Bill / measure</div>
              <div className="pe-swimlane-axis">
                {range.years.map((year) => (
                  <span key={year} className="pe-year-label">
                    {year}
                  </span>
                ))}
              </div>
            </div>

            <div className="pe-swimlane-body">
              {lanes.map((lane) => {
                const blanket = isBlanketAuthorizer(lane.bill);
                const clusters = clusterEvents(lane.events, range.start, range.end);
                return (
                  <div
                    key={lane.bill.id}
                    className={`pe-swimlane-row${blanket ? ' pe-bill-blanket' : ''}`}
                  >
                    <button
                      type="button"
                      className="pe-lane-bill"
                      onClick={() =>
                        navigate(billTarget(lane.bill.id))
                      }
                      title={lane.bill.title}
                    >
                      <span className="pe-lane-bill-num">{lane.label}</span>
                      <span className="pe-lane-bill-sub">
                        {chamberLabel(lane.bill)}
                        {blanket && lane.bill.peCodeCount
                          ? ` / ${lane.bill.peCodeCount.toLocaleString()} PEs`
                          : ''}
                      </span>
                      {/* R4 §4.2: Program Element 360 stays the line-level source of
                          truth, so each legislative vehicle carries its package label,
                          its match basis, and its confidence — never a bare link. The
                          package label keeps authorization and appropriation distinct. */}
                      <PeLinkBasis bill={lane.bill} />
                    </button>
                    <div className="pe-lane-track">
                      <span className="pe-lane-line" />
                      {range.years.map((year) => (
                        <span
                          key={year}
                          className="pe-year-grid"
                          style={{ left: `${yearPosition(year, range.start, range.end)}%` }}
                        />
                      ))}
                      {clusters.map((cluster) => {
                        const rep = cluster.representative;
                        return (
                          <Tooltip key={cluster.id} title={clusterTooltip(cluster)}>
                            <span
                              className={`pe-event-mark ${rep.kind}${
                                cluster.events.length > 1 ? ' is-cluster' : ''
                              }`}
                              style={{ left: `${cluster.left}%` }}
                            >
                              {markerContent(rep.kind, cluster.events.length)}
                            </span>
                          </Tooltip>
                        );
                      })}
                      {clusters.map((cluster) => {
                        const label = cluster.representative.chartLabel;
                        if (!label) return null;
                        return (
                          <span
                            key={`${cluster.id}-label`}
                            className="pe-event-label"
                            style={{ left: `${cluster.left}%` }}
                          >
                            {label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="pe-swimlane-legend" aria-label="Timeline legend">
              {EVENT_LEGEND.map((item) => (
                <span key={item.kind} className="pe-legend-item">
                  <span className={`pe-event-mark ${item.kind} pe-legend-mark`}>
                    {markerContent(item.kind, 1)}
                  </span>
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="pe-swimlane-empty">
            <b>No dated legislative actions</b>
            <span>Linked bills are present, but no dated actions are available for this view.</span>
            <div className="pe-undated-bills">
              {lanes.map((lane) => (
                <button
                  key={lane.bill.id}
                  type="button"
                  className="pe-undated-bill"
                  onClick={() =>
                    navigate(billTarget(lane.bill.id))
                  }
                  title={lane.bill.title}
                >
                  <span>{lane.label}</span>
                  <small>{lane.bill.title}</small>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pe-action-history">
          <div className="pe-action-history-title">Action history</div>
          {billActionsErrored ? (
            <PeSecondaryFailed
              label="bill action history"
              testId="pe-secondary-failed-bill-actions"
              onRetry={onRetryBillActions}
            />
          ) : detailEvents.length > 0 ? (
            <div className="pe-action-table">
              <div className="pe-action-row pe-action-head">
                <span>Date</span>
                <span>Bill</span>
                <span>Action</span>
              </div>
              {detailEvents.map((event) => (
                <div key={`${event.billId}-${event.id}`} className="pe-action-row">
                  <span className="pe-action-date">{compactDate(event.date)}</span>
                  <span className="pe-action-bill">{event.billLabel}</span>
                  <span className="pe-action-text">
                    <span className={`pe-action-kind ${event.kind}`}>{event.label}</span>
                    {event.text}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="pe-action-empty">No action history synced yet.</div>
          )}
        </div>
      </div>
    </Card>
  );
}
