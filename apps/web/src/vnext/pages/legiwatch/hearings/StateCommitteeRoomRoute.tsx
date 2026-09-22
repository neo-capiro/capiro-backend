import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { DIRECTORY_PROFILE_ROUTES } from '../../directory/directory-routes.js';
import { safeOfficialHttpUrl } from '../lib/canonical-hearings.js';
import { LwPill, LwSkeleton } from '../lib/primitives.js';
import {
  SOURCE_HEALTH_LABEL,
  SOURCE_HEALTH_TONE,
  normalizeSourceHealth,
  type SourceHealth,
} from '../lib/source-health.js';
import { LwStateUnavailable } from '../states/SystemStates.js';

type SourceLink = { url?: string | null; note?: string | null };
interface StateCommitteeBody {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  legislativeSession: string | null;
  officialSourceKey: string | null;
  sourceUrl: string | null;
  sourceEvidence?: {
    directory?: { sourceUrl?: string | null; aliasIds?: string[] };
    openstates?: {
      committeeId?: string | null;
      classification?: string | null;
      parentId?: string | null;
      links?: SourceLink[];
      sources?: SourceLink[];
    };
  } | null;
  legiscanCommitteeId?: number | null;
  lastSyncedAt: string;
}
interface StateMember {
  id: string;
  name: string;
  role: string | null;
  roles?: string[];
  party: string | null;
  district?: string | null;
  email?: string | null;
  active?: boolean;
}
interface StateProceeding {
  id: string;
  title: string;
  date: string;
  startsAt?: string | null;
  time?: string | null;
  eventStatus: string;
  eventType?: string | null;
  location?: string | null;
  officialPageUrl?: string | null;
  streamAvailability?: string;
  coverageStatus?: string;
  agenda?: unknown;
  documents?: unknown;
}
interface CalendarWindow {
  rows: StateProceeding[];
  total: number;
  page?: number;
  pageSize?: number;
}
interface SourceCoverage {
  chamber: string;
  status: string;
  from: string;
  to: string;
  attemptedAt: string;
  items: number;
  sourceHealth: string;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  sourceUrl: string | null;
  adapterKey: string | null;
}
interface DirectoryProfile {
  contacts: Array<{
    location: string | null;
    mailingAddress: string | null;
    phone: string | null;
    voip: string | null;
  }>;
  jurisdiction: string | null;
  leadership: Array<{ name: string; role: string }>;
  staff: Array<{
    name: string;
    role: string;
    email: string | null;
    phone: string | null;
    sourcePage: number | null;
  }>;
  sources: Array<{ document: string; sha256: string; asOfDate: string; pages: number[] }>;
}
interface ReferredBill {
  id: string;
  identifier: string;
  title: string;
  status: string | null;
  latestActionDate: string | null;
  latestActionText: string | null;
  stateUrl: string | null;
  url: string | null;
  syncedAt?: string;
  calendarEvents?: Array<{
    id: string;
    eventType: string;
    date: string;
    time: string | null;
    location: string | null;
    description: string | null;
  }>;
}
interface StateCommitteeDetail {
  body: StateCommitteeBody;
  members: StateMember[];
  sourceRecords?: StateCommitteeBody[];
  sourceCommitteeIds?: string[];
  relatedLegacyBodies?: Array<{ id: string; name: string; chamber: string | null }>;
  rosterStatus: string;
  upcomingEvents?: CalendarWindow;
  recentEvents?: CalendarWindow;
  events?: CalendarWindow;
  sourceCoverage?: SourceCoverage[];
  referredBills?: { rows: ReferredBill[]; total: number };
  directoryProfile?: DirectoryProfile | null;
}

type Section = 'overview' | 'proceedings' | 'members' | 'records' | 'sources';
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'proceedings', label: 'Proceedings' },
  { id: 'members', label: 'Members' },
  { id: 'records', label: 'Agendas & records' },
  { id: 'sources', label: 'Source health' },
];

function titleCase(value: string | null | undefined): string {
  return value
    ? value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    : 'Unknown';
}
function chamberLabel(chamber: string | null): string {
  if (chamber === 'lower' || chamber === 'house') return 'HOUSE';
  if (chamber === 'upper' || chamber === 'senate') return 'SENATE';
  if (chamber === 'joint') return 'JOINT';
  return 'CHAMBER UNCONFIRMED';
}
export function readableDate(value: string | null | undefined): string {
  if (!value) return 'Unavailable';
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(isDateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: isDateOnly ? undefined : 'numeric',
    minute: isDateOnly ? undefined : '2-digit',
    timeZone: isDateOnly ? 'UTC' : undefined,
  }).format(date);
}
function asObjects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}
function field(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof row[key] === 'string' && row[key]) return row[key] as string;
  return null;
}
function sourceHealth(rows: SourceCoverage[]): SourceHealth {
  const states = rows.map((row) => normalizeSourceHealth(row.sourceHealth));
  if (states.includes('failing')) return 'failing';
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('healthy')) return 'healthy';
  return 'unknown';
}
function latestSuccess(rows: SourceCoverage[]): string | null {
  return (
    rows
      .map((row) => row.lastSuccessAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  );
}
type EvidenceLink = {
  label: string;
  url: string;
  provenance: 'official' | 'published' | 'provider';
};
function evidenceLinks(body: StateCommitteeBody): EvidenceLink[] {
  const links: EvidenceLink[] = [];
  const add = (
    provenance: EvidenceLink['provenance'],
    label: string,
    candidate: string | null | undefined,
  ) => {
    const url = safeOfficialHttpUrl(candidate);
    if (url && !links.some((item) => item.url === url)) links.push({ label, url, provenance });
  };
  const directoryUrl = body.sourceEvidence?.directory?.sourceUrl;
  add(
    body.officialSourceKey ? 'official' : 'published',
    body.officialSourceKey ? 'Official committee page' : 'Published directory source',
    directoryUrl,
  );
  add(
    body.officialSourceKey && body.sourceUrl === directoryUrl ? 'official' : 'published',
    body.officialSourceKey && body.sourceUrl === directoryUrl
      ? 'Official committee page'
      : 'Published committee source',
    body.sourceUrl,
  );
  for (const link of body.sourceEvidence?.openstates?.links ?? [])
    add('provider', `OpenStates · ${link.note?.trim() || 'published link'}`, link.url);
  for (const link of body.sourceEvidence?.openstates?.sources ?? [])
    add('provider', `OpenStates · ${link.note?.trim() || 'source citation'}`, link.url);
  return links;
}

export function StateCommitteeRoomRoute() {
  const { stateCommitteeId = '' } = useParams<{ stateCommitteeId: string }>();
  const api = useApi();
  const apiScope = useApiScope();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const clientId = searchParams.get('client') ?? '';
  const sectionParam = searchParams.get('section');
  const section: Section = SECTIONS.some((item) => item.id === sectionParam)
    ? (sectionParam as Section)
    : 'overview';
  const detail = useQuery<StateCommitteeDetail, Error>({
    queryKey: ['lw-vnext', 'state-committee-room', apiScope, stateCommitteeId],
    enabled: Boolean(stateCommitteeId),
    retry: false,
    staleTime: 60_000,
    queryFn: async () =>
      (
        await api.get<StateCommitteeDetail>(
          `/api/legiwatch/live-hearings/state-committees/${encodeURIComponent(stateCommitteeId)}`,
        )
      ).data,
  });

  if (detail.isLoading)
    return (
      <div className="lwcr">
        <div className="lwcr-banner">
          <div className="lwcr-banner__inner">
            <LwSkeleton height={100} />
          </div>
        </div>
        <div className="lwcr__grid">
          <div className="lwcr__main">
            <section className="lwcr-card">
              <div className="lwcr-card__body">
                <LwSkeleton height={260} />
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  if (detail.isError || !detail.data)
    return (
      <div className="lw">
        <div className="lw-body">
          <LwStateUnavailable
            source="Florida committee room"
            reason={
              /404|not found/i.test(detail.error?.message ?? '')
                ? 'This Florida committee is not in the current official directory.'
                : 'The Florida committee record could not be loaded.'
            }
            onRetry={() => void detail.refetch()}
          />
        </div>
      </div>
    );

  const data = detail.data;
  const body = data.body;
  const upcoming = data.upcomingEvents ?? { rows: [], total: 0 };
  const recent = data.recentEvents ?? data.events ?? { rows: [], total: 0 };
  const coverage = data.sourceCoverage ?? [];
  const health = sourceHealth(coverage);
  const links = (data.sourceRecords?.length ? data.sourceRecords : [body])
    .flatMap(evidenceLinks)
    .filter(
      (item, index, rows) => rows.findIndex((candidate) => candidate.url === item.url) === index,
    );
  const primarySource = links.find((link) => link.provenance === 'official') ?? links[0] ?? null;
  const clientQuery = clientId ? `?client=${encodeURIComponent(clientId)}` : '';
  const backParams = new URLSearchParams({ tab: 'committees', jurisdiction: 'FL' });
  if (clientId) backParams.set('client', clientId);
  const records = [...upcoming.rows, ...recent.rows];
  const proceedingTotal = upcoming.total + recent.total;
  const agendaCount = records.reduce((count, event) => count + asObjects(event.agenda).length, 0);
  const documentCount = records.reduce(
    (count, event) => count + asObjects(event.documents).length,
    0,
  );

  const openSection = (next: Section) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'overview') params.delete('section');
    else params.set('section', next);
    navigate({ search: params.toString() ? `?${params}` : '' }, { replace: true });
  };
  const openHearing = (id: string) =>
    navigate(`/legiwatch/hearings/${encodeURIComponent(id)}${clientQuery}`, {
      state: { legiwatchReturnTo: `${location.pathname}${location.search}` },
    });

  return (
    <div className="lwcr" aria-label={`Florida committee room: ${body.name}`}>
      <header className="lwcr-banner">
        <div className="lwcr-banner__inner">
          <nav className="lwcr-crumbs" aria-label="Breadcrumb">
            <button
              type="button"
              className="lwcr-crumbs__parent"
              onClick={() => navigate(`/legiwatch?${backParams}`)}
            >
              LegiWatch
            </button>
            <span>/</span>
            <span>Florida committees</span>
          </nav>
          <div className="lwcr-banner__row">
            <div className="lwcr-seal" aria-hidden="true">
              FL
            </div>
            <div style={{ flex: 1, minWidth: 280 }}>
              <div className="lwcr-lockup">
                <span className="lwcr-chamber">FLORIDA · {chamberLabel(body.chamber)}</span>
                <span className="lwcr-level">STATE COMMITTEE</span>
                <span className="lwcr-divider" aria-hidden="true" />
                <span className="lwcr-syscode">
                  {body.legislativeSession ?? 'SESSION UNCONFIRMED'}
                </span>
              </div>
              <h1 className="lwcr-title">{body.name}</h1>
            </div>
            <div className="lwcr-actions">
              <span role="status" aria-label="Florida committee alerts unavailable">
                <LwPill tone="gray" size="24">
                  Alerts unavailable for Florida
                </LwPill>
              </span>
              {primarySource ? (
                <a
                  className="lwcr-extlink"
                  href={primarySource.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {primarySource.provenance === 'official' ? 'Official source' : 'Published source'}
                  {' ↗'}
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      <div className="lwcr-ledger" aria-label="Florida committee provenance">
        <Ledger
          label="Source health"
          value={SOURCE_HEALTH_LABEL[health]}
          detail={
            coverage.length
              ? `${coverage.length} provider receipt${coverage.length === 1 ? '' : 's'}`
              : 'No coverage receipt returned'
          }
        />
        <Ledger
          label="Last source success"
          value={readableDate(latestSuccess(coverage))}
          detail="Returned calendar-provider receipts"
        />
        <Ledger
          label="Committee record"
          value={readableDate(body.lastSyncedAt)}
          detail={
            body.officialSourceKey
              ? 'Official Florida identity verified'
              : 'Published identity · official verification unavailable'
          }
        />
        <Ledger
          label="Published material"
          value={`${agendaCount} agenda · ${documentCount} document${documentCount === 1 ? '' : 's'}`}
          detail={`Across ${records.length} of ${proceedingTotal} proceedings returned`}
        />
      </div>

      <div className="lwcr-tabs" aria-label="Florida committee sections">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={section === item.id}
            className={`lwcr-tab${section === item.id ? ' is-active' : ''}`}
            onClick={() => openSection(item.id)}
          >
            {item.label}
            {item.id === 'proceedings' ? (
              <span className="lwcr-tab__count">{upcoming.total + recent.total}</span>
            ) : null}
            {item.id === 'members' ? (
              <span className="lwcr-tab__count">{data.members.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="lwcr__grid">
        <div className="lwcr__main">
          {section === 'overview' || section === 'proceedings' ? (
            <Proceedings upcoming={upcoming} recent={recent} onOpen={openHearing} />
          ) : null}
          {section === 'overview' || section === 'members' ? (
            <Roster
              members={data.members}
              clientQuery={clientQuery}
              rosterStatus={data.rosterStatus}
            />
          ) : null}
          {section === 'overview' || section === 'records' ? (
            <PublishedRecords
              events={records}
              referred={data.referredBills}
              clientQuery={clientQuery}
            />
          ) : null}
          {section === 'overview' || section === 'sources' ? (
            <SourceCoveragePanel rows={coverage} />
          ) : null}
        </div>
        <aside className="lwcr__rail">
          <div className="lwcr-follow-card">
            <div className="lwcr-follow-card__eyebrow">Florida capabilities</div>
            <p className="lwcr-follow-card__lead">
              Committee records and proceedings are available.
            </p>
            <p className="lwcr-follow-card__body">
              Open a proceeding for its verified stream, recording, transcript, agenda and hearing
              intelligence. Committee-level Follow and alerts are not connected for Florida yet.
            </p>
          </div>
          {data.directoryProfile ? (
            <DirectoryFacts profile={data.directoryProfile} />
          ) : (
            <div className="lwcr-railcard">
              <div className="lwcr-railcard__eyebrow">Contacts & staff</div>
              <p className="lwcr-jurisdiction lwcr-jurisdiction--null">
                No reviewed committee contact profile was returned.
              </p>
            </div>
          )}
          <div className="lwcr-railcard">
            <div className="lwcr-railcard__eyebrow">Source provenance</div>
            {links.length ? (
              links.map((link) => (
                <a
                  key={link.url}
                  className="lwcr-chain__link"
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {link.label} ↗
                </a>
              ))
            ) : (
              <p className="lwcr-jurisdiction lwcr-jurisdiction--null">
                No source URL was returned for this record.
              </p>
            )}
            {body.officialSourceKey ? (
              <p className="lwcr-chain__note">Identity: {body.officialSourceKey}</p>
            ) : null}
            {body.legiscanCommitteeId ? (
              <p className="lwcr-chain__note">LegiScan committee {body.legiscanCommitteeId}</p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Ledger({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="lwcr-ledger__cell">
      <div className="lwcr-eyebrow">{label}</div>
      <div className="lwcr-ledger__value">{value}</div>
      <div className="lwcr-ledger__sub">{detail}</div>
    </div>
  );
}

function Proceedings({
  upcoming,
  recent,
  onOpen,
}: {
  upcoming: CalendarWindow;
  recent: CalendarWindow;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="lwcr-card" aria-label="Florida proceedings">
      <div className="lwcr-card__head">
        <h2 className="lwcr-card__title">Proceedings</h2>
        <span className="lwcr-card__meta">
          {upcoming.total} UPCOMING · {recent.total} RECENT
        </span>
      </div>
      <div className="lwcr-card__body">
        {upcoming.rows.length || recent.rows.length ? (
          <>
            <ProceedingGroup
              title="Upcoming"
              rows={upcoming.rows}
              total={upcoming.total}
              onOpen={onOpen}
            />
            <ProceedingGroup
              title="Recent"
              rows={recent.rows}
              total={recent.total}
              onOpen={onOpen}
            />
          </>
        ) : (
          <p className="lwcr-claim">
            No proceedings are available in Capiro for these one-year windows.
          </p>
        )}
      </div>
    </section>
  );
}
function ProceedingGroup({
  title,
  rows,
  total,
  onOpen,
}: {
  title: string;
  rows: StateProceeding[];
  total: number;
  onOpen: (id: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h3 className="lwcr-rosterhead__title">{title}</h3>
        <span className="lwcr-card__meta">
          SHOWING {rows.length} OF {total}
        </span>
      </div>
      <div>
        {rows.map((event) => (
          <button
            key={event.id}
            type="button"
            className="lwcr-event"
            onClick={() => onOpen(event.id)}
          >
            <span className="lwcr-event__when">{readableDate(event.startsAt ?? event.date)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="lwcr-event__title">{event.title}</span>
              <span className="lwcr-event__meta">
                {[
                  event.time,
                  event.eventType ? titleCase(event.eventType) : null,
                  titleCase(event.eventStatus),
                  event.location,
                  event.coverageStatus && event.coverageStatus !== 'not_covered'
                    ? titleCase(event.coverageStatus)
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <span className="lwcr-update__type">
              {event.streamAvailability && event.streamAvailability !== 'unknown'
                ? titleCase(event.streamAvailability)
                : 'Open hearing'}{' '}
              →
            </span>
          </button>
        ))}
      </div>
      {total > rows.length ? (
        <p className="lwcr-provenance">
          Showing {rows.length} of {total} proceedings in this one-year window.
        </p>
      ) : null}
    </div>
  );
}

function Roster({
  members,
  clientQuery,
  rosterStatus,
}: {
  members: StateMember[];
  clientQuery: string;
  rosterStatus: string;
}) {
  return (
    <section className="lwcr-card" aria-label="Florida committee members">
      <div className="lwcr-card__head">
        <h2 className="lwcr-card__title">Members</h2>
        <span className="lwcr-card__meta">{members.length} PUBLISHED</span>
      </div>
      <div className="lwcr-card__body">
        {members.length ? (
          <div className="lwcr-roster">
            {members.map((member, index) => (
              <Link
                key={member.id}
                className="lwcr-member"
                to={`${DIRECTORY_PROFILE_ROUTES.stateLegislator(member.id)}${clientQuery}`}
              >
                <span className="lwcr-member__rank">{index + 1}</span>
                <span className="lwcr-member__name">{member.name}</span>
                <span className="lwcr-member__role">
                  {[
                    member.role,
                    member.party,
                    member.district ? `District ${member.district}` : null,
                    member.active === false ? 'Former' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="lwcr-claim">
            {rosterStatus === 'unqualified'
              ? 'The official committee identity is present, but no roster is linked by a stable provider ID.'
              : 'No roster was returned for this committee.'}
          </p>
        )}
      </div>
    </section>
  );
}

function PublishedRecords({
  events,
  referred,
  clientQuery,
}: {
  events: StateProceeding[];
  referred?: { rows: ReferredBill[]; total: number };
  clientQuery: string;
}) {
  const rows = events.flatMap((event) => [
    ...asObjects(event.agenda).map((item) => ({ event, item, kind: 'Agenda item' })),
    ...asObjects(event.documents).map((item) => ({ event, item, kind: 'Document' })),
  ]);
  return (
    <section className="lwcr-card" aria-label="Florida agendas and records">
      <div className="lwcr-card__head">
        <h2 className="lwcr-card__title">Agendas & published records</h2>
        <span className="lwcr-card__meta">
          {rows.length} ITEMS · {referred?.total ?? 0} REFERRED BILLS
        </span>
      </div>
      <div className="lwcr-card__body">
        {rows.length ? (
          <div>
            {rows.map(({ event, item, kind }, index) => {
              const href = safeOfficialHttpUrl(field(item, 'sourceUrl', 'url', 'href'));
              const label =
                field(item, 'title', 'name', 'label', 'description') ?? `${kind} ${index + 1}`;
              const content = (
                <>
                  <span className="lwcr-update__date">{kind}</span>
                  <span className="lwcr-update__body">
                    <span className="lwcr-update__title">{label}</span>
                    <span className="lwcr-update__diff">Published with {event.title}</span>
                  </span>
                  <span className="lwcr-update__type">
                    {href ? 'Open published source ↗' : 'Source URL unavailable'}
                  </span>
                </>
              );
              return href ? (
                <a
                  key={`${event.id}-${kind}-${index}`}
                  className="lwcr-update"
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {content}
                </a>
              ) : (
                <div
                  key={`${event.id}-${kind}-${index}`}
                  className="lwcr-update"
                  style={{ cursor: 'default' }}
                >
                  {content}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="lwcr-claim">
            No agenda items or documents were returned in these proceeding windows.
          </p>
        )}
        {referred ? (
          <>
            <h3 className="lwcr-rosterhead__title" style={{ marginTop: 20 }}>
              Bills currently referred
            </h3>
            {referred.rows.length ? (
              <div>
                {referred.rows.map((bill) => (
                  <Link
                    key={bill.id}
                    className="lwcr-update"
                    to={`/bills/${encodeURIComponent(bill.id)}${clientQuery}`}
                  >
                    <span className="lwcr-update__date">{bill.identifier}</span>
                    <span className="lwcr-update__body">
                      <span className="lwcr-update__title">{bill.title}</span>
                      <span className="lwcr-update__diff">
                        {[
                          titleCase(bill.status),
                          bill.latestActionDate ? readableDate(bill.latestActionDate) : null,
                          bill.latestActionText,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {bill.calendarEvents?.map((event) => (
                        <span className="lwcr-update__diff" key={event.id}>
                          LegiScan bill calendar · {titleCase(event.eventType)} ·{' '}
                          {readableDate(event.date)}
                          {event.time ? ` · ${event.time}` : ''}
                          {event.location ? ` · ${event.location}` : ''}
                          {event.description ? ` · ${event.description}` : ''}
                        </span>
                      ))}
                    </span>
                    <span className="lwcr-update__type">Open bill →</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="lwcr-claim">No current LegiScan referrals are linked.</p>
            )}
            {referred.total > referred.rows.length ? (
              <p className="lwcr-provenance">
                Showing {referred.rows.length} of {referred.total} currently referred bills.
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function SourceCoveragePanel({ rows }: { rows: SourceCoverage[] }) {
  return (
    <section className="lwcr-card" aria-label="Florida source health">
      <div className="lwcr-card__head">
        <h2 className="lwcr-card__title">Source health & coverage</h2>
        <span className="lwcr-card__meta">{rows.length} RECEIPTS</span>
      </div>
      <div className="lwcr-card__body">
        {rows.length ? (
          <div className="lwcr-roster">
            {rows.map((row, index) => {
              const health = normalizeSourceHealth(row.sourceHealth);
              const href = safeOfficialHttpUrl(row.sourceUrl);
              return (
                <div
                  key={`${row.chamber}-${row.adapterKey ?? index}-${row.attemptedAt}`}
                  className="lwcr-member"
                >
                  <span>
                    <LwPill tone={SOURCE_HEALTH_TONE[health]} size="22">
                      {SOURCE_HEALTH_LABEL[health]}
                    </LwPill>
                  </span>
                  <span>
                    <span className="lwcr-member__name">
                      {row.adapterKey ? titleCase(row.adapterKey) : chamberLabel(row.chamber)}
                    </span>
                    <span className="lwcr-member__role">
                      {row.items} proceedings checked · {row.from}–{row.to} · Last success{' '}
                      {readableDate(row.lastSuccessAt)}
                    </span>
                    {row.lastError ? (
                      <span className="lwcr-member__role">
                        Latest source error: {row.lastError}
                      </span>
                    ) : null}
                  </span>
                  {href ? (
                    <a
                      className="lwcr-chain__link"
                      href={href}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Open source ↗
                    </a>
                  ) : (
                    <span className="lwcr-member__role">Source URL unavailable</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="lwcr-claim">
            No source-coverage receipt was returned. This does not establish that the committee has
            no activity.
          </p>
        )}
      </div>
    </section>
  );
}

function DirectoryFacts({ profile }: { profile: DirectoryProfile }) {
  return (
    <div className="lwcr-railcard">
      <div className="lwcr-railcard__eyebrow">Contacts & staff</div>
      {profile.jurisdiction ? <p className="lwcr-jurisdiction">{profile.jurisdiction}</p> : null}
      {profile.contacts.map((contact, index) => (
        <div key={`${contact.location ?? ''}-${index}`} className="lwcr-identity__row">
          <span className="lwcr-identity__label">{contact.location ?? 'Committee office'}</span>
          <span className="lwcr-identity__value">
            {[contact.mailingAddress, contact.phone, contact.voip ? `VOIP ${contact.voip}` : null]
              .filter(Boolean)
              .join(' · ') || 'Contact details unavailable'}
          </span>
        </div>
      ))}
      {profile.leadership.length ? (
        <div style={{ marginTop: 12 }}>
          <div className="lwcr-railcard__eyebrow">Directory leadership</div>
          {profile.leadership.map((leader) => (
            <div key={`${leader.name}-${leader.role}`} className="lwcr-identity__row">
              <span className="lwcr-identity__label">{leader.name}</span>
              <span className="lwcr-identity__value">{leader.role}</span>
            </div>
          ))}
        </div>
      ) : null}
      {profile.staff.length ? (
        <div style={{ marginTop: 12 }}>
          <div className="lwcr-railcard__eyebrow">Professional staff</div>
          {profile.staff.map((staffer) => (
            <div key={`${staffer.name}-${staffer.role}`} className="lwcr-identity__row">
              <span className="lwcr-identity__label">{staffer.name}</span>
              <span className="lwcr-identity__value">
                {[
                  staffer.role,
                  staffer.phone,
                  staffer.sourcePage ? `Directory page ${staffer.sourcePage}` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                {staffer.email ? (
                  <>
                    <br />
                    <a className="lwcr-chain__link" href={`mailto:${staffer.email}`}>
                      {staffer.email}
                    </a>
                  </>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="lwcr-chain__note">
          No professional staff are listed in the reviewed directory source.
        </p>
      )}
      {profile.sources.length ? (
        <div style={{ marginTop: 12 }}>
          <div className="lwcr-railcard__eyebrow">Directory citations</div>
          {profile.sources.map((source) => (
            <p className="lwcr-chain__note" key={`${source.sha256}-${source.pages.join('-')}`}>
              {source.document} · as of {readableDate(source.asOfDate)} · page
              {source.pages.length === 1 ? '' : 's'} {source.pages.join(', ')}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
