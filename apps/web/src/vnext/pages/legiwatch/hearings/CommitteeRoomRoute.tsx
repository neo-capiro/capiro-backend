/**
 * Committee room route — `/legiwatch/committees/:systemCode` (PR B, LW-QA-013).
 * Composes the canonical committee-directory room contract: official identity,
 * hierarchy, members/leadership, official source, upcoming + recent hearings,
 * and the site-update feed. Zero-recent-hearing and unknown-code states are
 * honest; nothing is a static fixture.
 */
import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CommitteeFollowControl,
  CommitteeIntelligenceHistorySection,
} from './CommitteeFollow.js';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  formatHearingDay,
  formatHearingTime,
  parseHearingMoment,
} from '../lib/hearing-datetime.js';
import { LwPill, LwButton, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
import { liveHearingApiError } from '../../../../pages/radar/live-hearings/live-hearings-api.js';
import type { CanonicalHearingEvent } from '../lib/canonical-hearings.js';

interface RoomMember { id: string; name: string; party?: string; state?: string; role?: string }
interface RoomUpdate { id: string; title?: string; url?: string; publishedAt?: string }
interface RoomResponse {
  systemCode: string;
  name: string;
  chamber: string;
  isSubcommittee: boolean;
  parent?: { systemCode: string; name: string } | null;
  subcommittees: Array<{ systemCode: string; name: string }>;
  officialUrl?: string;
  jurisdiction?: string;
  members: RoomMember[];
  chair?: RoomMember | null;
  rankingMember?: RoomMember | null;
  upcomingEvents: CanonicalHearingEvent[];
  recentEvents: CanonicalHearingEvent[];
  updates: RoomUpdate[];
  asOf?: string;
}

function normalizeMemberRow(v: unknown): RoomMember | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : typeof r.bioguideId === 'string' ? r.bioguideId : null;
  const name = typeof r.name === 'string' ? r.name : typeof r.fullName === 'string' ? r.fullName : null;
  if (!id || !name) return null;
  return {
    id,
    name,
    party: typeof r.party === 'string' ? r.party : undefined,
    state: typeof r.state === 'string' ? r.state : undefined,
    role: typeof r.role === 'string' ? r.role : typeof r.title === 'string' ? r.title : undefined,
  };
}

export function CommitteeRoomRoute() {
  const { systemCode = '' } = useParams<{ systemCode: string }>();
  const navigate = useNavigate();
  // The module's client lens travels in `?client`, so committee intelligence
  // narrows to the same client the rest of LegiWatch is scoped to.
  const [searchParams] = useSearchParams();
  const clientId = searchParams.get('client') ?? '';
  const api = useApi();

  const room = useQuery<RoomResponse, Error>({
    queryKey: ['lw', 'committee-room', systemCode],
    enabled: Boolean(systemCode),
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const raw = (await api.get<unknown>(`/api/legiwatch/live-hearings/committees/${encodeURIComponent(systemCode)}`)).data as Record<string, unknown>;
      const src = (raw.committee ?? raw) as Record<string, unknown>;
      const members = Array.isArray(raw.members) ? raw.members.map(normalizeMemberRow).filter((m): m is RoomMember => Boolean(m)) : [];
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const subcommittees = Array.isArray(src.subcommittees)
        ? (src.subcommittees as Array<Record<string, unknown>>).map((s) => ({
            systemCode: str(s.systemCode) ?? '',
            name: str(s.name) ?? '',
          })).filter((s) => s.systemCode)
        : [];
      const parent = src.parent && typeof src.parent === 'object'
        ? { systemCode: str((src.parent as Record<string, unknown>).systemCode) ?? '', name: str((src.parent as Record<string, unknown>).name) ?? '' }
        : null;
      // Upcoming/recent rows arrive as canonical CalendarEvent shapes.
      const ev = (arr: unknown) =>
        Array.isArray(arr) ? (arr as CanonicalHearingEvent[]) : [];
      return {
        systemCode: str(src.systemCode) ?? systemCode,
        name: str(src.name) ?? systemCode,
        chamber: str(src.chamber) ?? '',
        isSubcommittee: Boolean(src.isSubcommittee),
        parent: parent && parent.systemCode ? parent : null,
        subcommittees,
        officialUrl: str(src.officialUrl) ?? str(src.url),
        jurisdiction: str(src.jurisdiction),
        members,
        chair: raw.chair ? normalizeMemberRow(raw.chair) : null,
        rankingMember: raw.rankingMember ? normalizeMemberRow(raw.rankingMember) : null,
        upcomingEvents: ev(raw.upcomingEvents ?? raw.upcoming),
        recentEvents: ev(raw.recentEvents ?? raw.recent),
        updates: Array.isArray(raw.updates)
          ? (raw.updates as Array<Record<string, unknown>>).map((u) => ({
              id: str(u.id) ?? Math.random().toString(36).slice(2),
              title: str(u.title),
              url: str(u.url),
              publishedAt: str(u.publishedAt) ?? str(u.createdAt),
            }))
          : [],
        asOf: str(raw.asOf),
      };
    },
  });

  const leadership = useMemo(() => {
    if (!room.data) return [];
    const out: Array<{ label: string; m: RoomMember }> = [];
    if (room.data.chair) out.push({ label: 'Chair', m: room.data.chair });
    if (room.data.rankingMember) out.push({ label: 'Ranking member', m: room.data.rankingMember });
    return out;
  }, [room.data]);

  if (room.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-card" style={{ padding: 18 }}>
          <LwSkeleton height={36} />
          <div style={{ height: 12 }} />
          <LwSkeleton height={140} delay={2} />
        </div>
      </div>
    );
  }

  if (room.isError || !room.data) {
    return (
      <div className="lw-body">
        <LwStateUnavailable
          source="Committee room"
          reason={room.error ? liveHearingApiError(room.error) : 'This committee could not be found in the current directory.'}
          onRetry={() => void room.refetch()}
        />
        <div style={{ marginTop: 12 }}>
          <LwButton onClick={() => navigate('/legiwatch?tab=hearings')}>← Back to LegiWatch</LwButton>
        </div>
      </div>
    );
  }

  const c = room.data;

  return (
    <div className="lw-body lw-detail" aria-label={`Committee room: ${c.name}`}>
      <button type="button" className="lw-backlink" onClick={() => navigate('/legiwatch?tab=hearings')}>
        ← Back to LegiWatch
      </button>

      <section className="lw-card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <LwPill tone="brand" size="22">{c.chamber.toUpperCase() || 'COMMITTEE'}</LwPill>
          {c.isSubcommittee ? <LwPill tone="gray" size="22">SUBCOMMITTEE</LwPill> : null}
          {c.parent ? <LwPill tone="gray" size="22">of {c.parent.name}</LwPill> : null}
        </div>
        <h1 style={{ margin: '10px 0 4px', fontSize: 22 }}>{c.name}</h1>
        {c.jurisdiction ? <p style={{ fontSize: 13, color: 'var(--lw-meta)', margin: '0 0 8px' }}>{c.jurisdiction}</p> : null}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {c.officialUrl ? (
            <a className="lw-backlink" href={c.officialUrl} target="_blank" rel="noreferrer noopener">Official site ↗</a>
          ) : null}
          {c.subcommittees.map((s) => (
            <button key={s.systemCode} type="button" className="lw-backlink" style={{ padding: 0 }} onClick={() => navigate(`/legiwatch/committees/${encodeURIComponent(s.systemCode)}`)}>
              {s.name}
            </button>
          ))}
        </div>
        {/* W1-4 — committee following. Tenant/user interest pointing at this
            canonical system code; no committee facts are duplicated into it. */}
        <div style={{ marginTop: 12 }}>
          <CommitteeFollowControl systemCode={systemCode} committeeName={c.name} />
        </div>
      </section>

      <section className="lw-card" style={{ padding: 18 }} aria-label="Members and leadership">
        <div className="lw-card__head">
          <h2 className="lw-card__title">Members & leadership</h2>
          <span className="lw-card__meta">{c.members.length} members</span>
        </div>
        {leadership.map(({ label, m }) => (
          <p key={label} style={{ margin: '0 0 6px', fontSize: 14 }}>
            <strong>{m.name}</strong> <span style={{ color: 'var(--lw-meta)', fontSize: 12 }}>· {label}{m.party ? ` · ${m.party}` : ''}{m.state ? `-${m.state}` : ''}</span>
          </p>
        ))}
        {c.members.length > 0 ? (
          <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {c.members.map((m) => (
              <li key={m.id} style={{ fontSize: 13, border: '1px solid var(--lw-faint)', borderRadius: 6, padding: '4px 8px' }}>
                {m.name}{m.party ? ` · ${m.party}` : ''}{m.state ? `-${m.state}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--lw-meta)' }}>Membership has not been synced for this body yet.</p>
        )}
      </section>

      {(['Upcoming hearings', 'Recent & completed hearings'] as const).map((title, idx) => {
        const events = idx === 0 ? c.upcomingEvents : c.recentEvents;
        return (
          <section key={title} className="lw-card" style={{ padding: 18 }} aria-label={title}>
            <div className="lw-card__head">
              <h2 className="lw-card__title">{title}</h2>
              <span className="lw-card__meta">{events.length}</span>
            </div>
            {events.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--lw-meta)', margin: 0 }}>
                {idx === 0 ? 'Nothing scheduled in the current window.' : 'No recent proceedings in the current window.'}
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {events.map((e) => {
                  const m = parseHearingMoment({
                    date: e.calendarDate ?? (e.scheduledStart ? e.scheduledStart.slice(0, 10) : ''),
                    startsAt: e.scheduledStart ?? null,
                    timeZone: e.timeZone ?? null,
                  });
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        className="lw-backlink"
                        style={{ padding: 0, textAlign: 'left', width: '100%' }}
                        onClick={() => navigate(`/legiwatch/hearings/${encodeURIComponent(e.id)}`)}
                      >
                        <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{e.title}</span>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--lw-meta)' }}>
                          {formatHearingDay(m)} · {formatHearingTime(m)} · {(e.eventStatus ?? '').toUpperCase()}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <section className="lw-card" style={{ padding: 18 }} aria-label="Official updates">
        <div className="lw-card__head">
          <h2 className="lw-card__title">Official updates</h2>
          <span className="lw-card__meta">{c.updates.length}</span>
        </div>
        {c.updates.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--lw-meta)', margin: 0 }}>No official site updates recorded yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {c.updates.slice(0, 12).map((u) => (
              <li key={u.id} style={{ fontSize: 13 }}>
                {u.url ? (
                  <a className="lw-backlink" href={u.url} target="_blank" rel="noreferrer noopener">{u.title ?? u.url}</a>
                ) : (
                  u.title ?? 'Update'
                )}
                {u.publishedAt ? <span style={{ color: 'var(--lw-meta)', fontSize: 11 }}> · {u.publishedAt.slice(0, 10)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* W1-4 — derived from this committee's OWN canonical hearings. */}
      <CommitteeIntelligenceHistorySection systemCode={systemCode} clientId={clientId} />
    </div>
  );
}
