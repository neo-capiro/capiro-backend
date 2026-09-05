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
  momentOfCanonicalEvent,
} from '../lib/hearing-datetime.js';
import { LwPill, LwButton, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
import { liveHearingApiError } from '../../../../pages/radar/live-hearings/live-hearings-api.js';
import {
  normalizeCanonicalHearingEvent,
  safeOfficialHttpUrl,
  type CanonicalHearingEvent,
} from '../lib/canonical-hearings.js';
import {
  SOURCE_HEALTH_LABEL,
  SOURCE_HEALTH_TONE,
  normalizeSourceHealth,
  type SourceHealth,
} from '../lib/source-health.js';

interface RoomMember { id: string; name: string; party?: string; state?: string; role?: string }
/** `key` is derived, never fabricated — see `updateKey()`. */
interface RoomUpdate { key: string; title?: string; url?: string; publishedAt?: string }
interface RoomResponse {
  systemCode: string;
  name: string;
  chamber: string;
  isSubcommittee: boolean;
  parent?: { systemCode: string; name: string } | null;
  subcommittees: Array<{ systemCode: string; name: string }>;
  officialUrl?: string;
  jurisdiction?: string;
  /** Health of the OFFICIAL source feeding this committee, always displayable. */
  sourceHealth: SourceHealth;
  /** Parent system code when this body has no source of its own. */
  sourceHealthInheritedFrom?: string | null;
  /** When the committee RECORD was last reconciled. */
  lastSyncedAt?: string;
  /** When the official source last fetched successfully — a different fact. */
  lastSourceSuccessAt?: string | null;
  sourceUrl?: string | null;
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

/**
 * A stable React key for one official-update row. The server always sends a
 * `CommitteeSiteUpdate.id`, so the compound fallback is a guard, not a source
 * of identity — it must stay DETERMINISTIC. This previously fell back to
 * `Math.random()` inside the query function, which produced a different key for
 * the same row on every refetch (React remounts the row instead of reconciling
 * it) and fabricated identity for a row the server failed to identify.
 */
function updateKey(row: Record<string, unknown>, index: number): string {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const id = s(row.id);
  if (id) return id;
  const hash = s(row.contentHash);
  if (hash) return `hash:${hash}`;
  return `row:${index}|${s(row.publishedAt) || s(row.lastSeenAt)}|${s(row.sourceUrl) || s(row.url)}|${s(row.title)}`;
}

/** Timestamp label, or an honest "unreadable" rather than "Invalid Date". */
function stampLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'at an unreadable timestamp';
  return new Date(t).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
      // LW-QA-018: the room's event rows are the SAME `LiveHearingsService`
      // rows `/calendar` and `/events/:id` serve, and they arrive under the
      // service's own field names (`date`, `startsAt`, `timezone`, `status`).
      // Casting them to the canonical shape — as this route used to — left
      // calendarDate/scheduledStart/timeZone undefined, so the identical
      // hearing rendered a blank day and "Time not announced" here while
      // Schedule and Hearing Detail showed its real day and time. Run them
      // through the SHARED normalizer every other surface uses; this is the one
      // boundary where the legacy aliases are mapped.
      const ev = (arr: unknown) =>
        Array.isArray(arr) ? arr.map(normalizeCanonicalHearingEvent) : [];
      // Source health is spread FLAT onto the response by CommitteeDirectory-
      // Service (`{ ...committee, parent, subcommittees, ... }`) — there is no
      // `raw.committee` envelope on this endpoint — so read `raw` first and
      // keep `src` only as the fallback for a future nested shape.
      const outer = (k: string) => str(raw[k]) ?? str(src[k]);
      return {
        systemCode: str(src.systemCode) ?? systemCode,
        name: str(src.name) ?? systemCode,
        chamber: str(src.chamber) ?? '',
        isSubcommittee: Boolean(src.isSubcommittee),
        parent: parent && parent.systemCode ? parent : null,
        subcommittees,
        officialUrl: str(src.officialUrl) ?? str(src.url),
        jurisdiction: str(src.jurisdiction),
        sourceHealth: normalizeSourceHealth(outer('sourceHealth')),
        sourceHealthInheritedFrom: outer('sourceHealthInheritedFrom') ?? null,
        lastSyncedAt: outer('lastSyncedAt'),
        lastSourceSuccessAt: outer('lastSourceSuccessAt') ?? null,
        sourceUrl: outer('sourceUrl') ?? null,
        members,
        chair: raw.chair ? normalizeMemberRow(raw.chair) : null,
        rankingMember: raw.rankingMember ? normalizeMemberRow(raw.rankingMember) : null,
        upcomingEvents: ev(raw.upcomingEvents ?? raw.upcoming),
        recentEvents: ev(raw.recentEvents ?? raw.recent),
        updates: Array.isArray(raw.updates)
          ? (raw.updates as Array<Record<string, unknown>>).map((u, i) => ({
              key: updateKey(u, i),
              title: str(u.title),
              // `CommitteeSiteUpdate` publishes its link as `sourceUrl`; the
              // bare `url` alias this route read never exists on the wire, so
              // every official update rendered as unlinked text.
              url: str(u.sourceUrl) ?? str(u.url),
              publishedAt: str(u.publishedAt),
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
  // Committee URLs are official-source strings from the directory table; only
  // real http(s) origins become hrefs.
  const officialHref = safeOfficialHttpUrl(c.officialUrl);
  const sourceHref = safeOfficialHttpUrl(c.sourceUrl);

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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          {/* Unconditional: "we don't know" is a state an operator must see.
              A missing pill reads as "healthy". */}
          <LwPill tone={SOURCE_HEALTH_TONE[c.sourceHealth]} size="22">
            {SOURCE_HEALTH_LABEL[c.sourceHealth]}
            {c.sourceHealthInheritedFrom ? ` · inherited from ${c.sourceHealthInheritedFrom.toUpperCase()}` : ''}
          </LwPill>
          {/* Two distinct facts, never conflated: when the official source last
              answered, and when this committee record was reconciled. */}
          {c.lastSourceSuccessAt ? (
            <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
              Last official sync {stampLabel(c.lastSourceSuccessAt)}
            </span>
          ) : (
            <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
              No successful official sync recorded
            </span>
          )}
          {c.lastSyncedAt ? (
            <span className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-faint)' }}>
              Committee record updated {stampLabel(c.lastSyncedAt)}
            </span>
          ) : null}
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {officialHref ? (
            <a className="lw-backlink" href={officialHref} target="_blank" rel="noreferrer noopener">Official site ↗</a>
          ) : null}
          {sourceHref ? (
            <a className="lw-backlink" href={sourceHref} target="_blank" rel="noreferrer noopener">Monitored source ↗</a>
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

      {/* The second bucket is a DATE window the server computes (past → yesterday),
          not a lifecycle state. Naming it "completed" made the heading contradict
          a row's own status pill whenever the lifecycle job had not yet run. */}
      {(['Upcoming hearings', 'Past hearings'] as const).map((title, idx) => {
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
                  const m = momentOfCanonicalEvent(e);
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
            {c.updates.slice(0, 12).map((u) => {
              const href = safeOfficialHttpUrl(u.url);
              return (
                <li key={u.key} style={{ fontSize: 13 }}>
                  {href ? (
                    <a className="lw-backlink" href={href} target="_blank" rel="noreferrer noopener">{u.title ?? href}</a>
                  ) : (
                    u.title ?? 'Update'
                  )}
                  {u.publishedAt ? <span style={{ color: 'var(--lw-meta)', fontSize: 11 }}> · {u.publishedAt.slice(0, 10)}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* W1-4 — derived from this committee's OWN canonical hearings. */}
      <CommitteeIntelligenceHistorySection systemCode={systemCode} clientId={clientId} />
    </div>
  );
}
