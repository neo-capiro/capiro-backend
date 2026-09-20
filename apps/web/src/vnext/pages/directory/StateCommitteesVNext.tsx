import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { useApiScope } from '../../../lib/use-api-scope.js';
import { safeOfficialHttpUrl } from '../legiwatch/lib/canonical-hearings.js';
import {
  STATE_CALENDAR_FEATURE,
  useIntelFeatureEnabled,
} from '../../../lib/intel-feature-flags.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DIRECTORY_PROFILE_ROUTES } from './directory-routes.js';
import {
  ProfileCard,
  ProfileErrorState,
  ProfileLoading,
  ProfilePage,
} from './profile-primitives.js';

type SourceLink = { url?: string | null; note?: string | null };
type SourceEvidence = {
  directory?: { sourceUrl?: string | null; aliasIds?: string[] };
  openstates?: {
    committeeId?: string | null;
    classification?: string | null;
    parentId?: string | null;
    links?: SourceLink[];
    sources?: SourceLink[];
  };
};

type Body = {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  legislativeSession: string | null;
  officialSourceKey: string | null;
  sourceUrl: string | null;
  sourceEvidence?: SourceEvidence | null;
  legiscanCommitteeId?: number | null;
  lastSyncedAt: string;
};

type Member = {
  id: string;
  name: string;
  role: string | null;
  roles?: string[];
  party: string | null;
  chamber?: string | null;
  district?: string | null;
  email?: string | null;
  image?: string | null;
  url?: string | null;
  active?: boolean;
  legiscanPeopleId?: number | null;
  sourceCommitteeIds?: string[];
  lastSyncedAt?: string;
};

type CommitteeEvent = {
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
  agenda?: unknown[];
};

type CalendarWindow = { rows: CommitteeEvent[]; total: number };
type SourceCoverage = {
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
};
type ReferredBill = {
  id: string;
  identifier: string;
  title: string;
  status: string | null;
  latestActionDate: string | null;
  latestActionText: string | null;
  stateUrl: string | null;
  url: string | null;
  syncedAt: string;
  calendarEvents?: Array<{
    id: string;
    eventType: string;
    date: string;
    time: string | null;
    location: string | null;
    description: string | null;
  }>;
};

export type StateCommitteeDetail = {
  body: Body;
  members: Member[];
  relatedLegacyBodies?: Array<{ id: string; name: string; chamber: string | null }>;
  sourceRecords?: Body[];
  sourceCommitteeIds?: string[];
  rosterStatus: string;
  upcomingEvents?: CalendarWindow;
  recentEvents?: CalendarWindow;
  /** Rolling-deploy compatibility with the previous API revision. */
  events?: CalendarWindow;
  sourceCoverage?: SourceCoverage[];
  referredBills?: { rows: ReferredBill[]; total: number };
};

export function chamberLabel(chamber: string | null): string {
  if (chamber === 'lower' || chamber === 'house') return 'House';
  if (chamber === 'upper' || chamber === 'senate') return 'Senate';
  if (chamber === 'joint') return 'Joint';
  return 'Chamber unconfirmed';
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readableInstant(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function eventDate(event: CommitteeEvent): string {
  const exact = readableInstant(event.startsAt);
  if (exact) return exact;
  if (/^\d{4}-\d{2}-\d{2}$/.test(event.date)) {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${event.date}T00:00:00Z`));
  }
  return event.date;
}

function evidenceLinks(body: Body): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  const add = (label: string, value: string | null | undefined) => {
    const safe = safeOfficialHttpUrl(value);
    if (safe && !links.some((link) => link.url === safe)) links.push({ label, url: safe });
  };
  add('Official committee page', body.sourceEvidence?.directory?.sourceUrl);
  add('Published committee source', body.sourceUrl);
  for (const link of body.sourceEvidence?.openstates?.links ?? [])
    add(link.note?.trim() || 'OpenStates published link', link.url);
  for (const source of body.sourceEvidence?.openstates?.sources ?? [])
    add(source.note?.trim() || 'OpenStates source', source.url);
  return links;
}

function leadership(member: Member): boolean {
  return /\b(chair|ranking|leader|whip)\b/i.test(member.roles?.join(' ') || member.role || '');
}

function StateRoster({ members }: { members: Member[] }) {
  if (!members.length) return <CapiroEmptyState title="No qualified roster" />;
  return (
    <div className="capiro-dirpage-roster" data-testid="state-committee-roster">
      {members.map((member) => (
        <div key={member.id} className="capiro-dirpage-roster__row">
          <IdentityMark
            kind="person"
            size="md"
            name={member.name}
            imageUrl={member.image ?? null}
            aria-hidden="true"
          />
          <div className="capiro-dirpage-roster__main">
            <Link
              className="capiro-dirprofile__link capiro-dirpage-roster__name"
              to={DIRECTORY_PROFILE_ROUTES.stateLegislator(member.id)}
            >
              {member.name}
            </Link>
            <div className="capiro-dirpage-roster__meta">
              <span className="capiro-dirprofile__meta">{member.role || 'Member'}</span>
              {member.party ? <CapiroBadge>{member.party}</CapiroBadge> : null}
              {member.district ? <CapiroBadge>District {member.district}</CapiroBadge> : null}
              <CapiroBadge tone={member.active === false ? 'neutral' : 'success'}>
                {member.active === false ? 'Former' : 'Current'}
              </CapiroBadge>
              {member.email ? (
                <a className="capiro-dirprofile__link" href={`mailto:${member.email}`}>
                  Email
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Proceedings({
  title,
  window,
  returnTo,
}: {
  title: string;
  window: CalendarWindow;
  returnTo: string;
}) {
  return (
    <ProfileCard title={`${title} (${window.total})`}>
      {window.rows.length ? (
        <div className="capiro-dirpage__rows">
          {window.rows.map((event) => (
            <div className="capiro-dirpage__row" key={event.id}>
              <Link
                className="capiro-dirprofile__link capiro-dirpage__row-title"
                to={`/legiwatch/hearings/${encodeURIComponent(event.id)}`}
                state={{ legiwatchReturnTo: returnTo }}
              >
                {event.title}
              </Link>
              <p className="capiro-dirprofile__meta">
                {[
                  eventDate(event),
                  event.time,
                  event.eventType ? titleCase(event.eventType) : null,
                  titleCase(event.eventStatus),
                  event.location,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <div className="capiro-dirprofile__pills">
                {event.streamAvailability && event.streamAvailability !== 'unknown' ? (
                  <CapiroBadge tone="info">{titleCase(event.streamAvailability)}</CapiroBadge>
                ) : null}
                {event.coverageStatus && event.coverageStatus !== 'not_covered' ? (
                  <CapiroBadge>{titleCase(event.coverageStatus)}</CapiroBadge>
                ) : null}
                {event.agenda?.length ? (
                  <CapiroBadge>{event.agenda.length} agenda items</CapiroBadge>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <CapiroEmptyState title={`No ${title.toLowerCase()} are linked to this committee`} />
      )}
      {window.total > window.rows.length ? (
        <p className="capiro-dirprofile__meta">
          Showing {window.rows.length} of {window.total} proceedings in this one-year window.
        </p>
      ) : null}
    </ProfileCard>
  );
}

export function StateCommitteeProfile({ detail }: { detail: StateCommitteeDetail }) {
  const location = useLocation();
  const [rosterFilter, setRosterFilter] = useState<'all' | 'leadership'>('all');
  const [currentOnly, setCurrentOnly] = useState(false);
  const [query, setQuery] = useState('');
  const body = detail.body;
  const currentPath = `${location.pathname}${location.search}`;
  const sourceRecords = detail.sourceRecords?.length ? detail.sourceRecords : [body];
  const links = sourceRecords
    .flatMap(evidenceLinks)
    .filter(
      (link, index, rows) => rows.findIndex((candidate) => candidate.url === link.url) === index,
    );
  const openstatesIdentities = sourceRecords
    .flatMap((record) =>
      record.sourceEvidence?.openstates?.committeeId ? [record.sourceEvidence.openstates] : [],
    )
    .filter(
      (identity, index, rows) =>
        rows.findIndex((candidate) => candidate.committeeId === identity.committeeId) === index,
    );
  const legiscanCommitteeIds = [
    ...new Set(
      sourceRecords
        .map((record) => record.legiscanCommitteeId)
        .filter((id): id is number => typeof id === 'number'),
    ),
  ];
  const upcoming = detail.upcomingEvents ?? { rows: [], total: 0 };
  const recent = detail.recentEvents ?? detail.events ?? { rows: [], total: 0 };
  const members = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return detail.members.filter((member) => {
      if (currentOnly && member.active === false) return false;
      if (rosterFilter === 'leadership' && !leadership(member)) return false;
      if (!needle) return true;
      return [member.name, member.role, member.party, member.district]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [currentOnly, detail.members, query, rosterFilter]);

  return (
    <ProfilePage>
      <Link className="capiro-dirpage__back" to="/directory/state-committees">
        ← Back to state committees
      </Link>

      <header className="capiro-dirpage__hero">
        <IdentityMark kind="committee" size="lg" name={body.name} aria-hidden="true" />
        <div className="capiro-dirpage__hero-main">
          <h1 className="capiro-dirpage__title">{body.name}</h1>
          <div className="capiro-dirprofile__pills">
            <CapiroBadge tone="info">{body.state}</CapiroBadge>
            <CapiroBadge>{chamberLabel(body.chamber)}</CapiroBadge>
            {body.legislativeSession ? <CapiroBadge>{body.legislativeSession}</CapiroBadge> : null}
            <CapiroBadge>committee</CapiroBadge>
          </div>
          <p className="capiro-dirprofile__meta">
            {detail.members.length} members · {upcoming.total} upcoming · {recent.total} recent
          </p>
          <p className="capiro-dirprofile__meta">
            {[
              body.officialSourceKey
                ? 'Official Florida identity verified'
                : 'Official identity unconfirmed',
              readableInstant(body.lastSyncedAt)
                ? `Updated ${readableInstant(body.lastSyncedAt)}`
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </header>

      {detail.rosterStatus === 'unqualified' ? (
        <ProfileCard title="Roster qualification">
          <p className="capiro-dirprofile__line">
            An official committee identity is present, but no roster is linked by a stable provider
            ID. Capiro will not infer members from names alone.
          </p>
        </ProfileCard>
      ) : null}

      <Proceedings title="Upcoming proceedings" window={upcoming} returnTo={currentPath} />
      <Proceedings title="Recent proceedings" window={recent} returnTo={currentPath} />

      <div className="capiro-dirpage__toolbar">
        <div className="capiro-dirpage-segmented" role="group" aria-label="Roster type">
          <button
            type="button"
            data-selected={rosterFilter === 'all' || undefined}
            aria-pressed={rosterFilter === 'all'}
            onClick={() => setRosterFilter('all')}
          >
            Members
          </button>
          <button
            type="button"
            data-selected={rosterFilter === 'leadership' || undefined}
            aria-pressed={rosterFilter === 'leadership'}
            onClick={() => setRosterFilter('leadership')}
          >
            Leadership
          </button>
        </div>
        <div className="capiro-dirpage-segmented" role="group" aria-label="Tenure">
          <button
            type="button"
            data-selected={!currentOnly || undefined}
            aria-pressed={!currentOnly}
            onClick={() => setCurrentOnly(false)}
          >
            All
          </button>
          <button
            type="button"
            data-selected={currentOnly || undefined}
            aria-pressed={currentOnly}
            onClick={() => setCurrentOnly(true)}
          >
            Current only
          </button>
        </div>
        <div className="capiro-dirpage__search">
          <input
            type="search"
            className="capiro-dirpage__search-input"
            aria-label="Filter by name or role"
            placeholder="Filter by name or role"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <CapiroButton size="compact" variant="quiet" onClick={() => setQuery('')}>
              Clear
            </CapiroButton>
          ) : null}
        </div>
      </div>
      <StateRoster members={members} />

      {detail.referredBills ? (
        <ProfileCard title={`Bills currently referred (${detail.referredBills.total})`}>
          {detail.referredBills.rows.length ? (
            <div className="capiro-dirpage__rows">
              {detail.referredBills.rows.map((bill) => (
                <div className="capiro-dirpage__row" key={bill.id}>
                  <Link
                    className="capiro-dirprofile__link capiro-dirpage__row-title"
                    to={`/bills/${encodeURIComponent(bill.id)}`}
                  >
                    {bill.identifier} · {bill.title}
                  </Link>
                  <p className="capiro-dirprofile__meta">
                    {[
                      bill.status ? titleCase(bill.status) : null,
                      bill.latestActionDate,
                      bill.latestActionText,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {bill.calendarEvents?.map((event) => (
                    <p className="capiro-dirprofile__meta" key={event.id}>
                      LegiScan bill calendar · {titleCase(event.eventType)} · {event.date}
                      {event.time ? ` · ${event.time}` : ''}
                      {event.location ? ` · ${event.location}` : ''}
                      {event.description ? ` · ${event.description}` : ''}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <CapiroEmptyState title="No current LegiScan referrals are linked" />
          )}
        </ProfileCard>
      ) : null}

      <ProfileCard title="Sources & data coverage">
        <div className="capiro-dirpage__rows">
          {links.map((link) => (
            <div className="capiro-dirpage__row" key={link.url}>
              <a
                className="capiro-dirprofile__link capiro-dirpage__row-title"
                href={link.url}
                target="_blank"
                rel="noreferrer"
              >
                {link.label} ↗
              </a>
            </div>
          ))}
          {openstatesIdentities.map((identity) => (
            <div className="capiro-dirpage__row" key={identity.committeeId}>
              <p className="capiro-dirpage__row-title">OpenStates committee identity</p>
              <p className="capiro-dirprofile__meta">
                {identity.committeeId}
                {identity.classification ? ` · ${titleCase(identity.classification)}` : ''}
              </p>
            </div>
          ))}
          {legiscanCommitteeIds.length ? (
            <div className="capiro-dirpage__row">
              <p className="capiro-dirpage__row-title">LegiScan committee identity</p>
              <p className="capiro-dirprofile__meta">
                {legiscanCommitteeIds.map((id) => `Committee ${id}`).join(' · ')}
              </p>
            </div>
          ) : null}
          {(detail.sourceCoverage ?? []).map((coverage) => (
            <div
              className="capiro-dirpage__row"
              key={`${coverage.chamber}-${coverage.attemptedAt}`}
            >
              <p className="capiro-dirpage__row-title">
                {coverage.adapterKey
                  ? titleCase(coverage.adapterKey)
                  : chamberLabel(coverage.chamber)}{' '}
                · {titleCase(coverage.sourceHealth)}
              </p>
              <p className="capiro-dirprofile__meta">
                {coverage.items} proceedings checked · {coverage.from}–{coverage.to} ·{' '}
                {titleCase(coverage.status)}
                {readableInstant(coverage.lastSuccessAt)
                  ? ` · Last success ${readableInstant(coverage.lastSuccessAt)}`
                  : ''}
              </p>
              {coverage.lastError ? (
                <p className="capiro-dirprofile__meta" role="status">
                  Latest source error: {coverage.lastError}
                </p>
              ) : null}
            </div>
          ))}
          {detail.relatedLegacyBodies?.length ? (
            <div className="capiro-dirpage__row">
              <p className="capiro-dirpage__row-title">Verified linked records</p>
              <p className="capiro-dirprofile__meta">
                {detail.relatedLegacyBodies.map((record, index) => (
                  <span key={record.id}>
                    {index ? ' · ' : ''}
                    <Link
                      className="capiro-dirprofile__link"
                      to={DIRECTORY_PROFILE_ROUTES.stateCommittee(record.id)}
                    >
                      {chamberLabel(record.chamber)} record: {record.name}
                    </Link>
                  </span>
                ))}
              </p>
            </div>
          ) : null}
          {!links.length && !detail.sourceCoverage?.length ? (
            <CapiroEmptyState title="No source evidence is published for this record" />
          ) : null}
        </div>
      </ProfileCard>
    </ProfilePage>
  );
}

export function StateCommitteesVNext({ id }: { id?: string }) {
  const api = useApi();
  const actor = useApiScope();
  const enabled = useIntelFeatureEnabled(STATE_CALENDAR_FEATURE);
  const data = useQuery({
    queryKey: ['state-committees', actor, id, enabled],
    enabled,
    retry: false,
    queryFn: async () =>
      (
        await api.get<Body[] | StateCommitteeDetail>(
          `/api/legiwatch/live-hearings/state-committees${id ? `/${encodeURIComponent(id)}` : ''}`,
        )
      ).data,
  });
  const detail = id && data.data && !Array.isArray(data.data) ? data.data : null;

  if (!enabled)
    return (
      <ProfilePage>
        <CapiroEmptyState title="State committee calendars are not enabled for this workspace." />
      </ProfilePage>
    );
  if (data.isPending)
    return (
      <ProfilePage>
        <ProfileLoading />
      </ProfilePage>
    );
  if (data.isError)
    return (
      <ProfilePage>
        <ProfileErrorState
          title="Committee data unavailable"
          description="Committee sources could not be loaded from the current directory snapshot."
        />
        <CapiroButton onClick={() => void data.refetch()}>Retry</CapiroButton>
      </ProfilePage>
    );
  if (detail) return <StateCommitteeProfile detail={detail} />;

  return (
    <DirectoryShell
      eyebrow="DIRECTORY · FLORIDA"
      title="State Committees"
      subtitle="Official Florida committee directory with OpenStates rosters and LegiScan referrals."
    >
      <div className="capiro-directory-leg-grid">
        {(Array.isArray(data.data) ? data.data : []).map((body) => (
          <Link
            key={body.id}
            className="capiro-directory-leg-card"
            to={DIRECTORY_PROFILE_ROUTES.stateCommittee(body.id)}
          >
            <div className="capiro-directory-leg-card__head">
              <IdentityMark kind="committee" size="md" name={body.name} aria-hidden="true" />
              <div className="capiro-directory-leg-card__id">
                <span className="capiro-directory-leg-card__eyebrow">
                  {body.state} · {chamberLabel(body.chamber)}
                </span>
                <strong className="capiro-directory-leg-card__name">{body.name}</strong>
              </div>
            </div>
            <div className="capiro-directory-leg-card__meta">
              {body.legislativeSession ?? 'Session unconfirmed'}
              {!body.officialSourceKey ? ' · Official identity unconfirmed' : ''}
            </div>
          </Link>
        ))}
      </div>
    </DirectoryShell>
  );
}
