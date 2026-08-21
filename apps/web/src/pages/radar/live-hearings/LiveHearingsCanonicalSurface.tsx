import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Input, Select, Spin } from 'antd';
import {
  AudioOutlined,
  BankOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ScheduleOutlined,
  SearchOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import {
  normalizeCanonicalHearingEvent,
  normalizeHearingUpdate,
} from './live-hearings-api.js';
import { LiveHearingsPage } from './LiveHearingsPage.js';
import type {
  CanonicalHearingEvent,
  HearingMember,
  HearingSiteUpdate,
} from './live-hearings.types.js';
import './LiveHearingsCanonicalSurface.css';

type UnknownRecord = Record<string, unknown>;
type CanonicalView = 'calendar' | 'committees' | 'committee';
type TopLevelView =
  | 'calendar'
  | 'live'
  | 'committees'
  | 'scheduled'
  | 'sessions'
  | 'archive';

interface CommitteeEventSummary {
  id: string;
  title: string;
  date: string;
  startsAt?: string;
  eventStatus: string;
  eventType?: string;
}

interface CommitteeDirectoryItem {
  systemCode: string;
  thomasId?: string;
  name: string;
  chamber: string;
  parentSystemCode?: string;
  parentName?: string;
  officialUrl?: string;
  jurisdiction?: string;
  isSubcommittee: boolean;
  lastSyncedAt?: string;
  upcomingEventCount: number;
  recentEventCount: number;
  sourceHealth: string;
  lastSourceSuccessAt?: string;
  sourceId?: string;
  sourceUrl?: string;
  sourceHealthInheritedFrom?: string;
  captureSupportObservation?: string;
  streamResolutionObservation?: string;
  nextEvent?: CommitteeEventSummary;
}

interface CommitteeDirectoryResponse {
  rows: CommitteeDirectoryItem[];
  total: number;
  parentCount: number;
  subcommitteeCount: number;
  asOf?: string;
}

interface CommitteeRoomResponse extends CommitteeDirectoryItem {
  parent?: CommitteeDirectoryItem;
  subcommittees: CommitteeDirectoryItem[];
  chair?: HearingMember;
  rankingMember?: HearingMember;
  members: HearingMember[];
  liveEvent?: CanonicalHearingEvent;
  upcomingEvents: CanonicalHearingEvent[];
  recentEvents: CanonicalHearingEvent[];
  updates: HearingSiteUpdate[];
  asOf?: string;
}

interface CalendarFilters {
  from: string;
  to: string;
  chamber?: string;
  committee?: string;
  subcommittee?: string;
  eventType?: string;
  eventStatus?: string;
  streamState?: string;
  captureState?: string;
  followState?: 'scheduled' | 'unscheduled';
  q?: string;
}

interface CalendarResponse {
  rows: CanonicalHearingEvent[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 100;

const NAV_ITEMS: ReadonlyArray<{
  id: TopLevelView;
  label: string;
  icon: ReactNode;
}> = [
  { id: 'calendar', label: 'Master Calendar', icon: <CalendarOutlined /> },
  { id: 'live', label: 'Live Now', icon: <PlayCircleOutlined /> },
  { id: 'committees', label: 'Committee Rooms', icon: <BankOutlined /> },
  { id: 'scheduled', label: 'Scheduled Recordings', icon: <ScheduleOutlined /> },
  { id: 'sessions', label: 'My Sessions', icon: <AudioOutlined /> },
  { id: 'archive', label: 'Archive', icon: <HistoryOutlined /> },
];

const CHAMBER_LABELS: Record<string, string> = {
  house: 'House',
  senate: 'Senate',
  joint: 'Joint',
};

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === '1' || value === 1) return true;
    if (value === 'false' || value === '0' || value === 0) return false;
  }
  return undefined;
}

function isoValue(...values: unknown[]): string | undefined {
  const value = stringValue(...values);
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function safeHttpUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMember(value: unknown): HearingMember | undefined {
  const row = record(value);
  const id = stringValue(row.id, row.bioguideId, row.memberId);
  const name = stringValue(row.name, row.fullName);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    party: stringValue(row.party),
    state: stringValue(row.state),
    role: stringValue(row.role, row.title),
    rank: numberValue(row.rank),
    profileUrl: stringValue(row.profileUrl, row.url),
  };
}

function normalizeEventSummary(value: unknown): CommitteeEventSummary | undefined {
  const row = record(value);
  const id = stringValue(row.id, row.hearingId);
  const title = stringValue(row.title);
  const date = stringValue(row.date);
  if (!id || !title || !date) return undefined;
  return {
    id,
    title,
    date,
    startsAt: isoValue(row.startsAt),
    eventStatus: stringValue(row.eventStatus, row.status) ?? 'unknown',
    eventType: stringValue(row.eventType, row.type),
  };
}

function normalizeDirectoryItem(value: unknown): CommitteeDirectoryItem | undefined {
  const row = record(value);
  const systemCode = stringValue(row.systemCode, row.id);
  const name = stringValue(row.name);
  if (!systemCode || !name) return undefined;
  return {
    systemCode,
    thomasId: stringValue(row.thomasId),
    name,
    chamber: (stringValue(row.chamber) ?? 'joint').toLowerCase(),
    parentSystemCode: stringValue(row.parentSystemCode),
    parentName: stringValue(row.parentName),
    officialUrl: stringValue(row.officialUrl, row.url),
    jurisdiction: stringValue(row.jurisdiction),
    isSubcommittee:
      booleanValue(row.isSubcommittee) ?? Boolean(stringValue(row.parentSystemCode)),
    lastSyncedAt: isoValue(row.lastSyncedAt),
    upcomingEventCount: numberValue(row.upcomingEventCount) ?? 0,
    recentEventCount: numberValue(row.recentEventCount) ?? 0,
    sourceHealth: stringValue(row.sourceHealth) ?? 'unknown',
    lastSourceSuccessAt: isoValue(row.lastSourceSuccessAt),
    sourceId: stringValue(row.sourceId),
    sourceUrl: stringValue(row.sourceUrl),
    sourceHealthInheritedFrom: stringValue(row.sourceHealthInheritedFrom),
    captureSupportObservation: stringValue(row.captureSupportObservation),
    streamResolutionObservation: stringValue(row.streamResolutionObservation),
    nextEvent: normalizeEventSummary(row.nextEvent),
  };
}

function normalizeDirectory(value: unknown): CommitteeDirectoryResponse {
  const envelope = record(value);
  const rows = array(envelope.rows ?? envelope.items)
    .map(normalizeDirectoryItem)
    .filter((item): item is CommitteeDirectoryItem => Boolean(item));
  const parentCount =
    numberValue(envelope.parentCount) ?? rows.filter((item) => !item.isSubcommittee).length;
  return {
    rows,
    total: numberValue(envelope.total) ?? rows.length,
    parentCount,
    subcommitteeCount:
      numberValue(envelope.subcommitteeCount) ?? rows.length - parentCount,
    asOf: isoValue(envelope.asOf),
  };
}

function normalizeRoom(value: unknown): CommitteeRoomResponse | undefined {
  const row = record(value);
  const base = normalizeDirectoryItem(row);
  if (!base) return undefined;
  const members = array(row.members)
    .map(normalizeMember)
    .filter((item): item is HearingMember => Boolean(item));
  const normalizeEvents = (input: unknown) =>
    array(input).map(normalizeCanonicalHearingEvent);
  return {
    ...base,
    parent: normalizeDirectoryItem(row.parent),
    subcommittees: array(row.subcommittees)
      .map(normalizeDirectoryItem)
      .filter((item): item is CommitteeDirectoryItem => Boolean(item)),
    chair: normalizeMember(row.chair),
    rankingMember: normalizeMember(row.rankingMember),
    members,
    liveEvent: row.liveEvent ? normalizeCanonicalHearingEvent(row.liveEvent) : undefined,
    upcomingEvents: normalizeEvents(row.upcomingEvents),
    recentEvents: normalizeEvents(row.recentEvents),
    updates: array(row.updates)
      .map(normalizeHearingUpdate)
      .filter((item): item is HearingSiteUpdate => Boolean(item)),
    asOf: isoValue(row.asOf),
  };
}

function normalizeCalendar(value: unknown): CalendarResponse {
  const envelope = record(value);
  const rawRows = array(envelope.rows ?? envelope.items ?? envelope.events ?? envelope.data);
  return {
    rows: rawRows.map(normalizeCanonicalHearingEvent),
    total: numberValue(envelope.total, envelope.count) ?? rawRows.length,
    page: numberValue(envelope.page) ?? 1,
    pageSize: numberValue(envelope.pageSize) ?? PAGE_SIZE,
  };
}

function localDateInput(offsetDays = 0): string {
  const value = new Date();
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() + offsetDays);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function titleCase(value?: string): string {
  return (value ?? 'Unknown')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDateTime(value?: string, timeZone = 'America/New_York'): string {
  if (!value) return 'Time not announced';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(parsed);
}

function errorMessage(error: unknown): string {
  const outer = record(error);
  const response = record(outer.response);
  const data = record(response.data);
  return (
    stringValue(data.message, outer.message) ??
    'The canonical Live Hearings service did not return a readable response.'
  );
}

function chamberLabel(value: string): string {
  return CHAMBER_LABELS[value.toLowerCase()] ?? titleCase(value);
}

function healthTone(value?: string): string {
  const normalized = (value ?? '').toLowerCase();
  if (normalized === 'healthy') return 'healthy';
  if (normalized === 'degraded') return 'degraded';
  if (normalized === 'failing' || normalized === 'unavailable') return 'failing';
  if (normalized === 'review_required' || normalized === 'custom_adapter_required') {
    return 'review';
  }
  return 'unknown';
}

function eventTone(event: CanonicalHearingEvent): string {
  const status = (event.eventStatus ?? '').toUpperCase();
  const stream = (event.streamState ?? '').toUpperCase();
  if (status === 'LIVE' || status === 'IN_PROGRESS' || stream === 'LIVE') return 'live';
  if (status === 'CANCELED' || status === 'POSTPONED') return 'exception';
  if (event.subscription?.scheduled) return 'scheduled';
  return 'normal';
}

function ViewNavigation({
  active,
  onSelect,
}: {
  active: TopLevelView;
  onSelect: (view: TopLevelView) => void;
}) {
  return (
    <nav className="lhc-nav" aria-label="Live Hearings views">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={active === item.id ? 'is-active' : ''}
          aria-current={active === item.id ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <span aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="lhc-loading" role="status">
      <Spin />
      <span>{label}</span>
    </div>
  );
}

function ErrorState({
  error,
  retry,
  title,
}: {
  error: unknown;
  retry: () => void;
  title: string;
}) {
  return (
    <Alert
      type="error"
      showIcon
      message={title}
      description={errorMessage(error)}
      action={
        <Button size="small" icon={<ReloadOutlined />} onClick={retry}>
          Retry
        </Button>
      }
    />
  );
}

function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`lhc-pill lhc-pill--${tone}`}>{children}</span>;
}

function EventRow({
  event,
  onOpen,
  compact = false,
}: {
  event: CanonicalHearingEvent;
  onOpen: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`lhc-event-row${compact ? ' lhc-event-row--compact' : ''}`}
      data-tone={eventTone(event)}
      onClick={() => onOpen(event.id)}
    >
      <div className="lhc-event-row__time">
        <ClockCircleOutlined />
        <span>{formatDateTime(event.scheduledStart, event.timeZone)}</span>
      </div>
      <div className="lhc-event-row__body">
        <div className="lhc-event-row__meta">
          <span>{chamberLabel(event.chamber)}</span>
          <span>·</span>
          <span>{event.subcommittee?.name ?? event.committee.name}</span>
          <span>·</span>
          <span>{titleCase(event.eventType)}</span>
        </div>
        <strong>{event.title}</strong>
        <div className="lhc-event-row__facts">
          <StatusPill tone={eventTone(event)}>{titleCase(event.eventStatus)}</StatusPill>
          <span>{titleCase(event.streamState)}</span>
          {event.subscription?.scheduled ? <span>Recording scheduled</span> : null}
          {event.location ? <span>{event.location}</span> : null}
        </div>
      </div>
    </button>
  );
}

function CalendarView({
  directory,
  directoryLoading,
  directoryError,
  retryDirectory,
  onOpenEvent,
  onOpenCommittee,
}: {
  directory?: CommitteeDirectoryResponse;
  directoryLoading: boolean;
  directoryError: unknown;
  retryDirectory: () => void;
  onOpenEvent: (id: string) => void;
  onOpenCommittee: (id: string) => void;
}) {
  const api = useApi();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<CalendarFilters>({
    from: localDateInput(0),
    to: localDateInput(13),
  });

  const setFilter = <K extends keyof CalendarFilters>(key: K, value: CalendarFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value || undefined }));
    setPage(1);
  };

  const query = useQuery<CalendarResponse>({
    queryKey: ['legiwatch', 'live-hearings', 'canonical-calendar', filters, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('from', filters.from);
      params.set('to', filters.to);
      params.set('page', String(page));
      params.set('pageSize', String(PAGE_SIZE));
      if (filters.chamber) params.set('chamber', filters.chamber);
      if (filters.committee) params.set('committee', filters.committee);
      if (filters.subcommittee) params.set('subcommittee', filters.subcommittee);
      if (filters.eventType) params.set('eventType', filters.eventType);
      if (filters.eventStatus) params.set('eventStatus', filters.eventStatus);
      if (filters.streamState) params.set('streamState', filters.streamState);
      if (filters.captureState) params.set('captureState', filters.captureState);
      if (filters.followState) params.set('followState', filters.followState);
      if (filters.q) params.set('q', filters.q.trim());
      const response = await api.get<unknown>(
        `/api/legiwatch/live-hearings/calendar?${params.toString()}`,
      );
      return normalizeCalendar(response.data);
    },
    retry: false,
    staleTime: 30_000,
  });

  const parents = useMemo(
    () =>
      (directory?.rows ?? []).filter(
        (item) => !item.isSubcommittee && (!filters.chamber || item.chamber === filters.chamber),
      ),
    [directory, filters.chamber],
  );
  const subcommittees = useMemo(
    () =>
      (directory?.rows ?? []).filter(
        (item) =>
          item.isSubcommittee &&
          (!filters.chamber || item.chamber === filters.chamber) &&
          (!filters.committee || item.parentSystemCode === filters.committee),
      ),
    [directory, filters.chamber, filters.committee],
  );

  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / PAGE_SIZE));

  return (
    <section className="lhc-view" aria-labelledby="lhc-calendar-title">
      <header className="lhc-view__header">
        <div>
          <span className="lhc-eyebrow">Canonical congressional schedule</span>
          <h2 id="lhc-calendar-title">Master Calendar</h2>
          <p>
            Official House, Senate, joint committee, and subcommittee proceedings—reconciled into
            one event per public hearing.
          </p>
        </div>
        <Button icon={<BankOutlined />} onClick={() => onOpenCommittee('')}>
          Browse committee rooms
        </Button>
      </header>

      {directoryError ? (
        <ErrorState
          error={directoryError}
          retry={retryDirectory}
          title="Committee filters could not be loaded"
        />
      ) : null}

      <div className="lhc-filter-panel" aria-label="Master Calendar filters">
        <div className="lhc-filter-panel__primary">
          <label>
            <span>From</span>
            <Input
              type="date"
              value={filters.from}
              onChange={(event) => setFilter('from', event.target.value)}
            />
          </label>
          <label>
            <span>Through</span>
            <Input
              type="date"
              value={filters.to}
              onChange={(event) => setFilter('to', event.target.value)}
            />
          </label>
          <label>
            <span>Chamber</span>
            <Select
              allowClear
              placeholder="All chambers"
              value={filters.chamber}
              options={[
                { value: 'house', label: 'House' },
                { value: 'senate', label: 'Senate' },
                { value: 'joint', label: 'Joint' },
              ]}
              onChange={(value) => {
                setFilters((current) => ({
                  ...current,
                  chamber: value,
                  committee: undefined,
                  subcommittee: undefined,
                }));
                setPage(1);
              }}
            />
          </label>
          <label>
            <span>Committee</span>
            <Select
              showSearch
              allowClear
              loading={directoryLoading}
              placeholder="All committees"
              optionFilterProp="label"
              value={filters.committee}
              options={parents.map((item) => ({ value: item.systemCode, label: item.name }))}
              onChange={(value) => {
                setFilters((current) => ({
                  ...current,
                  committee: value,
                  subcommittee: undefined,
                }));
                setPage(1);
              }}
            />
          </label>
          <label>
            <span>Subcommittee</span>
            <Select
              showSearch
              allowClear
              loading={directoryLoading}
              placeholder="All subcommittees"
              optionFilterProp="label"
              value={filters.subcommittee}
              options={subcommittees.map((item) => ({ value: item.systemCode, label: item.name }))}
              onChange={(value) => setFilter('subcommittee', value)}
            />
          </label>
        </div>

        <div className="lhc-filter-panel__secondary">
          <Select
            allowClear
            placeholder="Event type"
            value={filters.eventType}
            options={[
              { value: 'hearing', label: 'Hearing' },
              { value: 'markup', label: 'Markup' },
              { value: 'meeting', label: 'Meeting' },
              { value: 'business_meeting', label: 'Business meeting' },
            ]}
            onChange={(value) => setFilter('eventType', value)}
          />
          <Select
            allowClear
            placeholder="Event status"
            value={filters.eventStatus}
            options={[
              { value: 'scheduled', label: 'Scheduled' },
              { value: 'in_progress', label: 'In progress' },
              { value: 'completed', label: 'Completed' },
              { value: 'postponed', label: 'Postponed' },
              { value: 'canceled', label: 'Canceled' },
            ]}
            onChange={(value) => setFilter('eventStatus', value)}
          />
          <Select
            allowClear
            placeholder="Public stream"
            value={filters.streamState}
            options={[
              { value: 'unknown', label: 'Not checked' },
              { value: 'none', label: 'No stream found' },
              { value: 'live_only', label: 'Live only' },
              { value: 'archived', label: 'Archive available' },
              { value: 'embedded_third_party', label: 'Embedded third-party' },
            ]}
            onChange={(value) => setFilter('streamState', value)}
          />
          <Select
            allowClear
            placeholder="Coverage outcome"
            value={filters.captureState}
            options={[
              { value: 'not_covered', label: 'Not covered' },
              { value: 'discovered', label: 'Discovered' },
              { value: 'stream_ready', label: 'Stream ready' },
              { value: 'capturing', label: 'Capturing' },
              { value: 'captured', label: 'Captured' },
              { value: 'no_public_stream', label: 'No public stream' },
              { value: 'blocked', label: 'Blocked' },
            ]}
            onChange={(value) => setFilter('captureState', value)}
          />
          <Select
            allowClear
            placeholder="Recording state"
            value={filters.followState}
            options={[
              { value: 'scheduled', label: 'Scheduled by me' },
              { value: 'unscheduled', label: 'Not scheduled by me' },
            ]}
            onChange={(value) => setFilter('followState', value)}
          />
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Search title, committee, issue, or keyword"
            value={filters.q}
            onChange={(event) => setFilter('q', event.target.value)}
          />
        </div>
      </div>

      {query.isLoading ? <LoadingState label="Loading the canonical calendar…" /> : null}
      {query.error ? (
        <ErrorState
          error={query.error}
          retry={() => void query.refetch()}
          title="The Master Calendar could not be loaded"
        />
      ) : null}

      {query.data ? (
        <>
          <div className="lhc-result-summary">
            <span>
              <strong>{query.data.total}</strong> proceeding{query.data.total === 1 ? '' : 's'}
            </span>
            <span>
              Page {query.data.page} of {totalPages}
            </span>
          </div>
          {query.data.rows.length ? (
            <div className="lhc-event-list">
              {query.data.rows.map((event) => (
                <EventRow key={event.id} event={event} onOpen={onOpenEvent} />
              ))}
            </div>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No reconciled proceedings match these filters."
            />
          )}
          {totalPages > 1 ? (
            <div className="lhc-pagination">
              <Button disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
                Previous
              </Button>
              <Button
                disabled={page >= totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function DirectoryBodyCard({
  body,
  subcommittees,
  onOpen,
  onOpenEvent,
}: {
  body: CommitteeDirectoryItem;
  subcommittees: CommitteeDirectoryItem[];
  onOpen: (id: string) => void;
  onOpenEvent: (id: string) => void;
}) {
  const officialUrl = safeHttpUrl(body.officialUrl);
  return (
    <article className="lhc-committee-card">
      <div className="lhc-committee-card__topline">
        <StatusPill tone={healthTone(body.sourceHealth)}>{titleCase(body.sourceHealth)}</StatusPill>
        <span>{body.systemCode}</span>
      </div>
      <button type="button" className="lhc-committee-card__title" onClick={() => onOpen(body.systemCode)}>
        {body.name}
      </button>
      {body.jurisdiction ? <p>{body.jurisdiction}</p> : null}
      <div className="lhc-committee-card__stats">
        <span>
          <strong>{body.upcomingEventCount}</strong> upcoming
        </span>
        <span>
          <strong>{body.recentEventCount}</strong> recent
        </span>
        <span>
          <strong>{subcommittees.length}</strong> subcommittee{subcommittees.length === 1 ? '' : 's'}
        </span>
      </div>
      {body.nextEvent ? (
        <button
          type="button"
          className="lhc-next-event"
          onClick={() => onOpenEvent(body.nextEvent!.id)}
        >
          <span>Next proceeding</span>
          <strong>{body.nextEvent.title}</strong>
          <small>{formatDateTime(body.nextEvent.startsAt ?? body.nextEvent.date)}</small>
        </button>
      ) : (
        <div className="lhc-next-event lhc-next-event--empty">
          <span>No proceeding currently scheduled</span>
        </div>
      )}
      <div className="lhc-committee-card__actions">
        <Button type="primary" onClick={() => onOpen(body.systemCode)}>
          Enter room
        </Button>
        {officialUrl ? (
          <a href={officialUrl} target="_blank" rel="noreferrer">
            Official site
          </a>
        ) : null}
      </div>
      {subcommittees.length ? (
        <div className="lhc-subcommittee-list">
          <span>Subcommittees</span>
          {subcommittees.map((subcommittee) => (
            <button
              key={subcommittee.systemCode}
              type="button"
              onClick={() => onOpen(subcommittee.systemCode)}
            >
              <span>{subcommittee.name}</span>
              <small>
                {subcommittee.upcomingEventCount} upcoming · {titleCase(subcommittee.sourceHealth)}
              </small>
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function CommitteeDirectoryView({
  directory,
  loading,
  error,
  retry,
  onOpen,
  onOpenEvent,
}: {
  directory?: CommitteeDirectoryResponse;
  loading: boolean;
  error: unknown;
  retry: () => void;
  onOpen: (id: string) => void;
  onOpenEvent: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [chamber, setChamber] = useState<string>();
  const normalizedQuery = query.trim().toLowerCase();

  const visible = useMemo(
    () =>
      (directory?.rows ?? []).filter((item) => {
        if (chamber && item.chamber !== chamber) return false;
        if (!normalizedQuery) return true;
        return [item.name, item.systemCode, item.parentName, item.jurisdiction]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(normalizedQuery));
      }),
    [directory, chamber, normalizedQuery],
  );
  const visibleCodes = new Set(visible.map((item) => item.systemCode));

  return (
    <section className="lhc-view" aria-labelledby="lhc-committee-title">
      <header className="lhc-view__header">
        <div>
          <span className="lhc-eyebrow">Persistent congressional workspaces</span>
          <h2 id="lhc-committee-title">Committee Rooms</h2>
          <p>
            Every current committee and subcommittee remains available even when it has no hearing
            on this week’s calendar.
          </p>
        </div>
        {directory ? (
          <div className="lhc-directory-counts">
            <span>
              <strong>{directory.parentCount}</strong> parent bodies
            </span>
            <span>
              <strong>{directory.subcommitteeCount}</strong> subcommittees
            </span>
          </div>
        ) : null}
      </header>

      <div className="lhc-directory-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Find a committee or jurisdiction"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          allowClear
          placeholder="All chambers"
          value={chamber}
          options={[
            { value: 'house', label: 'House' },
            { value: 'senate', label: 'Senate' },
            { value: 'joint', label: 'Joint' },
          ]}
          onChange={setChamber}
        />
      </div>

      {loading ? <LoadingState label="Loading every current committee and subcommittee…" /> : null}
      {error ? (
        <ErrorState error={error} retry={retry} title="Committee Rooms could not be loaded" />
      ) : null}

      {directory ? (
        <div className="lhc-chambers">
          {(['house', 'senate', 'joint'] as const).map((chamberKey) => {
            const parents = visible.filter(
              (item) => item.chamber === chamberKey && !item.isSubcommittee,
            );
            const orphanSubcommittees = visible.filter(
              (item) =>
                item.chamber === chamberKey &&
                item.isSubcommittee &&
                (!item.parentSystemCode || !visibleCodes.has(item.parentSystemCode)),
            );
            if (!parents.length && !orphanSubcommittees.length) return null;
            return (
              <section key={chamberKey} className="lhc-chamber-section">
                <div className="lhc-chamber-section__heading">
                  <h3>{chamberLabel(chamberKey)}</h3>
                  <span>{parents.length + orphanSubcommittees.length} visible rooms</span>
                </div>
                <div className="lhc-committee-grid">
                  {parents.map((parent) => (
                    <DirectoryBodyCard
                      key={parent.systemCode}
                      body={parent}
                      subcommittees={visible.filter(
                        (item) => item.parentSystemCode === parent.systemCode,
                      )}
                      onOpen={onOpen}
                      onOpenEvent={onOpenEvent}
                    />
                  ))}
                  {orphanSubcommittees.map((subcommittee) => (
                    <DirectoryBodyCard
                      key={subcommittee.systemCode}
                      body={subcommittee}
                      subcommittees={[]}
                      onOpen={onOpen}
                      onOpenEvent={onOpenEvent}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {!visible.length ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No current committee or subcommittee matches this search."
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function LeadershipCard({ label, member }: { label: string; member?: HearingMember }) {
  return (
    <div className="lhc-leadership-card">
      <span>{label}</span>
      {member ? (
        <>
          <strong>{member.name}</strong>
          <small>{[member.party, member.state, member.role].filter(Boolean).join(' · ')}</small>
        </>
      ) : (
        <small>Not stated in the current roster</small>
      )}
    </div>
  );
}

function CommitteeRoomView({
  committeeId,
  onBack,
  onOpenCommittee,
  onOpenEvent,
}: {
  committeeId: string;
  onBack: () => void;
  onOpenCommittee: (id: string) => void;
  onOpenEvent: (id: string) => void;
}) {
  const api = useApi();
  const query = useQuery<CommitteeRoomResponse | undefined>({
    queryKey: ['legiwatch', 'live-hearings', 'canonical-committee', committeeId],
    enabled: Boolean(committeeId),
    queryFn: async () => {
      const response = await api.get<unknown>(
        `/api/legiwatch/live-hearings/committees/${encodeURIComponent(committeeId)}`,
      );
      return normalizeRoom(response.data);
    },
    retry: false,
    staleTime: 60_000,
  });

  if (!committeeId) {
    return (
      <section className="lhc-view">
        <Alert
          type="warning"
          showIcon
          message="No committee room was selected"
          action={<Button onClick={onBack}>Browse rooms</Button>}
        />
      </section>
    );
  }
  if (query.isLoading) return <LoadingState label="Opening the committee room…" />;
  if (query.error) {
    return (
      <section className="lhc-view">
        <ErrorState
          error={query.error}
          retry={() => void query.refetch()}
          title="The committee room could not be loaded"
        />
      </section>
    );
  }
  const room = query.data;
  if (!room) {
    return (
      <section className="lhc-view">
        <Alert
          type="error"
          showIcon
          message="The committee service returned no readable room"
          action={<Button onClick={onBack}>Browse rooms</Button>}
        />
      </section>
    );
  }

  const officialUrl = safeHttpUrl(room.officialUrl);
  const sourceUrl = safeHttpUrl(room.sourceUrl);

  return (
    <section className="lhc-view lhc-room" aria-labelledby="lhc-room-title">
      <button type="button" className="lhc-back" onClick={onBack}>
        ← All Committee Rooms
      </button>
      <header className="lhc-room__hero">
        <div>
          <div className="lhc-room__breadcrumbs">
            <span>{chamberLabel(room.chamber)}</span>
            {room.parent ? (
              <>
                <span>›</span>
                <button type="button" onClick={() => onOpenCommittee(room.parent!.systemCode)}>
                  {room.parent.name}
                </button>
              </>
            ) : null}
          </div>
          <h2 id="lhc-room-title">{room.name}</h2>
          {room.jurisdiction ? <p>{room.jurisdiction}</p> : null}
          <div className="lhc-room__meta">
            <StatusPill tone={healthTone(room.sourceHealth)}>
              Source {titleCase(room.sourceHealth)}
            </StatusPill>
            <span>{room.systemCode}</span>
            {room.sourceHealthInheritedFrom ? (
              <span>Coverage inherited from {room.parentName ?? room.sourceHealthInheritedFrom}</span>
            ) : null}
            {room.lastSourceSuccessAt ? (
              <span>Last source success {formatDateTime(room.lastSourceSuccessAt)}</span>
            ) : null}
          </div>
        </div>
        <div className="lhc-room__actions">
          {officialUrl ? (
            <a href={officialUrl} target="_blank" rel="noreferrer">
              Official committee site
            </a>
          ) : null}
          {sourceUrl && sourceUrl !== officialUrl ? (
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              Monitored source
            </a>
          ) : null}
        </div>
      </header>

      {room.captureSupportObservation || room.streamResolutionObservation ? (
        <div className="lhc-room__observations">
          <span>Observed capture policy</span>
          <strong>{titleCase(room.captureSupportObservation)}</strong>
          <span>Latest stream resolution</span>
          <strong>{titleCase(room.streamResolutionObservation)}</strong>
        </div>
      ) : (
        <Alert
          type="info"
          showIcon
          message="No stream-support observation has been recorded for this body yet"
          description="The room remains available. Capiro does not infer capture support until an official event produces a real stream candidate."
        />
      )}

      {room.liveEvent ? (
        <section className="lhc-room__section lhc-room__live">
          <div className="lhc-section-heading">
            <div>
              <span className="lhc-eyebrow">Live now</span>
              <h3>Proceeding in progress</h3>
            </div>
          </div>
          <EventRow event={room.liveEvent} onOpen={onOpenEvent} />
        </section>
      ) : null}

      <section className="lhc-room__section">
        <div className="lhc-section-heading">
          <div>
            <span className="lhc-eyebrow">Roster</span>
            <h3>Members and leadership</h3>
          </div>
          <span>{room.members.length} current roster entries</span>
        </div>
        <div className="lhc-leadership-grid">
          <LeadershipCard label="Chair" member={room.chair} />
          <LeadershipCard label="Ranking member" member={room.rankingMember} />
        </div>
        {room.members.length ? (
          <div className="lhc-member-grid">
            {room.members.map((member) => (
              <article key={member.id} className="lhc-member-card">
                <TeamOutlined />
                <div>
                  <strong>{member.name}</strong>
                  <span>{[member.party, member.state].filter(Boolean).join(' · ') || 'Party/state not stated'}</span>
                  {member.role ? <small>{member.role}</small> : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No current roster entries were returned for this body."
          />
        )}
      </section>

      {room.subcommittees.length ? (
        <section className="lhc-room__section">
          <div className="lhc-section-heading">
            <div>
              <span className="lhc-eyebrow">Hierarchy</span>
              <h3>Subcommittee rooms</h3>
            </div>
            <span>{room.subcommittees.length}</span>
          </div>
          <div className="lhc-room-subcommittee-grid">
            {room.subcommittees.map((subcommittee) => (
              <button
                key={subcommittee.systemCode}
                type="button"
                onClick={() => onOpenCommittee(subcommittee.systemCode)}
              >
                <strong>{subcommittee.name}</strong>
                <span>{subcommittee.upcomingEventCount} upcoming proceedings</span>
                <StatusPill tone={healthTone(subcommittee.sourceHealth)}>
                  {titleCase(subcommittee.sourceHealth)}
                </StatusPill>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="lhc-room__section">
        <div className="lhc-section-heading">
          <div>
            <span className="lhc-eyebrow">Schedule</span>
            <h3>Upcoming proceedings</h3>
          </div>
          <span>{room.upcomingEvents.length}</span>
        </div>
        {room.upcomingEvents.length ? (
          <div className="lhc-event-list">
            {room.upcomingEvents.map((event) => (
              <EventRow key={event.id} event={event} onOpen={onOpenEvent} compact />
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No upcoming proceeding is currently scheduled."
          />
        )}
      </section>

      <section className="lhc-room__section">
        <div className="lhc-section-heading">
          <div>
            <span className="lhc-eyebrow">Official activity</span>
            <h3>Committee site updates</h3>
          </div>
          <span>{room.updates.length}</span>
        </div>
        {room.updates.length ? (
          <div className="lhc-update-list">
            {room.updates.map((update) => {
              const updateUrl = safeHttpUrl(update.sourceUrl);
              return (
                <article key={update.id}>
                  <div>
                    <StatusPill>{titleCase(update.updateType)}</StatusPill>
                    <span>{formatDateTime(update.publishedAt ?? update.firstSeenAt)}</span>
                  </div>
                  <strong>{update.title}</strong>
                  {update.summary ? <p>{update.summary}</p> : null}
                  {updateUrl ? (
                    <a href={updateUrl} target="_blank" rel="noreferrer">
                      View official update
                    </a>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No official site change has been recorded for this room yet."
          />
        )}
      </section>

      <section className="lhc-room__section">
        <div className="lhc-section-heading">
          <div>
            <span className="lhc-eyebrow">History</span>
            <h3>Recent proceedings</h3>
          </div>
          <span>{room.recentEvents.length}</span>
        </div>
        {room.recentEvents.length ? (
          <div className="lhc-event-list">
            {room.recentEvents.map((event) => (
              <EventRow key={event.id} event={event} onOpen={onOpenEvent} compact />
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No recent proceeding is available in the current history window."
          />
        )}
      </section>
    </section>
  );
}

/**
 * V2 canonical surface for the Phase 3/4 views. The established hearing room,
 * live, scheduled, session, archive, transcript, and browser-capture surfaces
 * remain mounted and receive their existing routes unchanged.
 */
export function LiveHearingsCanonicalSurface() {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawView = searchParams.get('hearingView') ?? 'calendar';
  const isCanonicalView = ['calendar', 'committees', 'committee'].includes(rawView);

  const directoryQuery = useQuery<CommitteeDirectoryResponse>({
    queryKey: ['legiwatch', 'live-hearings', 'canonical-committee-directory'],
    enabled: isCanonicalView,
    queryFn: async () => {
      const response = await api.get<unknown>('/api/legiwatch/live-hearings/committees');
      return normalizeDirectory(response.data);
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  if (!isCanonicalView) return <LiveHearingsPage />;

  const view = rawView as CanonicalView;
  const committeeId = searchParams.get('committee') ?? '';

  const navigate = (nextView: TopLevelView | 'committee', values?: { committee?: string; event?: string }) => {
    const next = new URLSearchParams(searchParams);
    next.set('hearingView', nextView);
    next.delete('committee');
    next.delete('event');
    if (values?.committee) next.set('committee', values.committee);
    if (values?.event) next.set('event', values.event);
    setSearchParams(next);
  };

  const openEvent = (eventId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('hearingView', 'event');
    next.set('event', eventId);
    next.delete('committee');
    setSearchParams(next);
  };

  const activeTopLevel: TopLevelView = view === 'committee' ? 'committees' : view;

  return (
    <div className="lhc-surface">
      <ViewNavigation active={activeTopLevel} onSelect={(nextView) => navigate(nextView)} />
      {view === 'calendar' ? (
        <CalendarView
          directory={directoryQuery.data}
          directoryLoading={directoryQuery.isLoading}
          directoryError={directoryQuery.error}
          retryDirectory={() => void directoryQuery.refetch()}
          onOpenEvent={openEvent}
          onOpenCommittee={(id) => navigate(id ? 'committee' : 'committees', { committee: id })}
        />
      ) : null}
      {view === 'committees' ? (
        <CommitteeDirectoryView
          directory={directoryQuery.data}
          loading={directoryQuery.isLoading}
          error={directoryQuery.error}
          retry={() => void directoryQuery.refetch()}
          onOpen={(id) => navigate('committee', { committee: id })}
          onOpenEvent={openEvent}
        />
      ) : null}
      {view === 'committee' ? (
        <CommitteeRoomView
          committeeId={committeeId}
          onBack={() => navigate('committees')}
          onOpenCommittee={(id) => navigate('committee', { committee: id })}
          onOpenEvent={openEvent}
        />
      ) : null}
    </div>
  );
}

export default LiveHearingsCanonicalSurface;
