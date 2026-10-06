/**
 * Committee room — `/legiwatch/committees/:systemCode`, rebuilt to
 * COMMITTEE-ROOM-HANDOFF (supersedes LEGIWATCH-V2-HANDOFF §5.7 for this
 * screen). Reference record HLIG01.
 *
 * The design keeps every fact the shipped page rendered and adds rank: a
 * metallic banner, a four-cell provenance strip, a tab strip, a confident
 * proceedings empty state, leadership + a service-ordered roster, an
 * update feed rendered through a real enum-to-language map, and a 320px
 * rail (follow, source chain, identity, jurisdiction).
 *
 * Four contract facts (handoff §0) are implemented as stated, not preferences:
 *   1. The event window is ±365 days (DIRECTORY_EVENT_WINDOW_DAYS = 365).
 *      Copy never says "current window" or implies a month.
 *   2. `clientExposureCount` is NOT an exposure claim — it counts the distinct
 *      clients a user attached when following. No copy implies a client is
 *      affected by the committee's activity; the follow rail carries the
 *      required not-a-claim sentence verbatim.
 *   3. There is no committee-scoped Ask Meri and no committee export. The
 *      header carries exactly three actions: Follow, Official site, Monitored
 *      source.
 *   4. `notifyOnNewHearing` is part of the follow payload, not a separate
 *      alert. The empty state's CTA is Follow.
 */
import { useMemo, useState } from 'react';
import { hearingEventLabel } from '../lib/hearing-presentation.js';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  formatHearingDay,
  formatHearingTime,
  momentOfCanonicalEvent,
} from '../lib/hearing-datetime.js';
import { LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
import { liveHearingApiError } from '../../../../pages/radar/live-hearings/live-hearings-api.js';
import {
  normalizeCanonicalHearingEvent,
  safeOfficialHttpUrl,
  type CanonicalHearingEvent,
} from '../lib/canonical-hearings.js';
import { normalizeSourceHealth, type SourceHealth } from '../lib/source-health.js';
import { DashboardIcon } from '../../../components/untitledui/dashboard-icons.js';
import {
  CommitteeFollowDialog,
  CommitteeIntelligenceHistorySection,
} from './CommitteeFollow.js';
import { useCommitteeFollow } from '../lib/wave1-api.js';
import { DIRECTORY_PROFILE_ROUTES } from '../../directory/directory-routes.js';

/* ── wire shapes ─────────────────────────────────────────────────────────── */

interface RoomMember {
  id: string;
  profileId: string | null;
  name: string;
  party?: string | null;
  side: string;
  rank?: number | null;
  role?: string | null;
}
/** `key` is derived, never fabricated — see `updateKey()`. */
interface RoomUpdate {
  key: string;
  updateType?: string;
  title?: string;
  url?: string;
  publishedAt?: string;
  inheritedFromParent?: boolean;
  previousValue?: string | null;
  newValue?: string | null;
}
interface RoomResponse {
  systemCode: string;
  thomasId?: string;
  name: string;
  chamber: string;
  isSubcommittee: boolean;
  parent?: { systemCode: string; name: string } | null;
  parentSystemCode?: string | null;
  parentName?: string | null;
  subcommittees: Array<{ systemCode: string; name: string }>;
  officialUrl?: string;
  sourceUrl?: string | null;
  jurisdiction?: string | null;
  sourceHealth: SourceHealth;
  sourceHealthInheritedFrom?: string | null;
  lastSyncedAt?: string;
  lastSourceSuccessAt?: string | null;
  nextRefreshNotBefore?: string;
  upcomingEventCount?: number;
  recentEventCount?: number;
  members: RoomMember[];
  chair?: RoomMember | null;
  rankingMember?: RoomMember | null;
  upcomingEvents: CanonicalHearingEvent[];
  recentEvents: CanonicalHearingEvent[];
  updates: RoomUpdate[];
  asOf?: string;
}

type PartyPalette = { party: string; tint: string; ring: string; ink: string };
const PARTY_R: PartyPalette = { party: 'R', tint: '#FEF3F2', ring: '#FECDCA', ink: '#B42318' };
const PARTY_D: PartyPalette = { party: 'D', tint: '#EFF8FF', ring: '#B2DDFF', ink: '#175CD3' };

function partyPalette(party: string | null | undefined): PartyPalette | null {
  const p = (party ?? '').trim().toUpperCase();
  if (p.startsWith('R')) return PARTY_R;
  if (p.startsWith('D')) return PARTY_D;
  return null;
}

function caucusName(party: string | null | undefined): string {
  const p = (party ?? '').trim().toUpperCase();
  if (p.startsWith('R')) return 'Republican';
  if (p.startsWith('D')) return 'Democratic';
  return 'Independent';
}

function initials(name: string): string {
  // "Fitzpatrick, Brian K." -> BF (surname initial + first-given initial).
  const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[0] ?? '';
    const first = (parts[1] ?? '').split(/\s+/)[0] ?? '';
    const a = first[0] ?? '';
    const b = last[0] ?? '';
    if (a && b) return (a + b).toUpperCase();
  }
  const words = name.split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '—';
}

function normalizeMemberRow(v: unknown): RoomMember | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const id =
    typeof r.id === 'string' ? r.id : typeof r.bioguideId === 'string' ? r.bioguideId : null;
  const name =
    typeof r.name === 'string' ? r.name : typeof r.fullName === 'string' ? r.fullName : null;
  if (!id || !name) return null;
  // The API's `id` belongs to congressCommitteeMembership. Only the explicit
  // Bioguide identity (or an already canonical Directory ID) can open a person.
  const bioguideId = typeof r.bioguideId === 'string' && /^[a-z]\d{6}$/i.test(r.bioguideId)
    ? r.bioguideId.toUpperCase()
    : null;
  return {
    id,
    profileId: bioguideId ?? (/^member-\d+$/.test(id) ? id : null),
    name,
    party: typeof r.party === 'string' ? r.party : null,
    side: typeof r.side === 'string' ? r.side : '',
    rank: typeof r.rank === 'number' ? r.rank : null,
    role:
      typeof r.role === 'string' ? r.role : typeof r.title === 'string' ? r.title : null,
  };
}

/**
 * A stable React key for one official-update row. The server always sends a
 * `CommitteeSiteUpdate.id`, so the compound fallback is a guard, not a source
 * of identity — it must stay DETERMINISTIC.
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

/** Short date for the provenance strip and update rows ("Sep 5"). */
function dayLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dayYearLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The ±365-day window, computed from `today`, never hardcoded (handoff §0.1). */
function windowRanges(): { upcoming: string; past: string; upcomingFrom: Date; upcomingTo: Date } {
  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const future = new Date(today.getTime() + 365 * DAY);
  const past = new Date(today.getTime() - 365 * DAY);
  const yesterday = new Date(today.getTime() - DAY);
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return {
    upcoming: `${fmt(today)} — ${fmt(future)}`,
    past: `${fmt(past)} — ${fmt(yesterday)}`,
    upcomingFrom: today,
    upcomingTo: future,
  };
}

/**
 * `updateType` rendered through a real enum-to-language map (handoff §3.6 open
 * item) — never the raw enum. Values are the `committee_site_update.update_type`
 * vocabulary declared on the Prisma model.
 */
const UPDATE_TYPE_LABEL: Record<string, string> = {
  hearing_announced: 'Hearing announced',
  date_changed: 'Date changed',
  time_changed: 'Time changed',
  room_changed: 'Room changed',
  postponed: 'Postponed',
  canceled: 'Canceled',
  witness_added: 'Witness added',
  witness_removed: 'Witness removed',
  witness_testimony_published: 'Witness testimony published',
  committee_memo_published: 'Committee memo published',
  bill_added: 'Bill added',
  amendment_added: 'Amendment added',
  livestream_posted: 'Livestream posted',
  livestream_changed: 'Livestream changed',
  archive_posted: 'Archive posted',
  official_transcript_posted: 'Official transcript posted',
  roster_change: 'Roster change',
  site_update: 'Site update',
  source_recovery: 'Source recovery',
};
function updateTypeLabel(updateType: string | undefined): string {
  if (!updateType) return 'Update';
  const key = updateType.trim().toLowerCase();
  if (key in UPDATE_TYPE_LABEL) return UPDATE_TYPE_LABEL[key] as string;
  // Humanize a snake_case enum the map does not yet know, rather than printing
  // the raw token — but never a fabricated proper noun.
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** A row that carries a previous/new value diff shows it in a disclosure. */
function UpdateDiff({ previous, next }: { previous: string; next: string }) {
  return (
    <div className="lwcr-update__diff">
      <span className="lw-mono" style={{ fontWeight: 600 }}>Was:</span> {previous}
      {'  ·  '}
      <span className="lw-mono" style={{ fontWeight: 600 }}>Now:</span> {next}
    </div>
  );
}

export function CommitteeRoomRoute() {
  const { systemCode = '' } = useParams<{ systemCode: string }>();
  const navigate = useNavigate();
  // The module's client lens travels in `?client`, so committee intelligence
  // narrows to the same client the rest of LegiWatch is scoped to.
  const [searchParams] = useSearchParams();
  const clientId = searchParams.get('client') ?? '';
  const tab = searchParams.get('tab') ?? 'overview';
  const api = useApi();

  const [followOpen, setFollowOpen] = useState(false);
  const [sideFilter, setSideFilter] = useState<'all' | 'majority' | 'minority'>('all');
  const [memberQuery, setMemberQuery] = useState('');
  const [expandedUpdate, setExpandedUpdate] = useState<string | null>(null);

  const follow = useCommitteeFollow(systemCode);
  const following = follow.data?.following ?? false;

  const room = useQuery<RoomResponse, Error>({
    queryKey: ['lw', 'committee-room', systemCode],
    enabled: Boolean(systemCode),
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const raw = (await api.get<unknown>(
        `/api/legiwatch/live-hearings/committees/${encodeURIComponent(systemCode)}`,
      )).data as Record<string, unknown>;
      const src = (raw.committee ?? raw) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
      const members = Array.isArray(raw.members)
        ? raw.members.map(normalizeMemberRow).filter((m): m is RoomMember => Boolean(m))
        : [];
      const subcommittees = Array.isArray(src.subcommittees)
        ? (src.subcommittees as Array<Record<string, unknown>>)
            .map((s) => ({ systemCode: str(s.systemCode) ?? '', name: str(s.name) ?? '' }))
            .filter((s) => s.systemCode)
        : [];
      const parent =
        src.parent && typeof src.parent === 'object'
          ? {
              systemCode: str((src.parent as Record<string, unknown>).systemCode) ?? '',
              name: str((src.parent as Record<string, unknown>).name) ?? '',
            }
          : null;
      // LW-QA-018: the room's event rows are the SAME `LiveHearingsService`
      // rows `/calendar` and `/events/:id` serve; run them through the shared
      // normalizer so day/time render identically to Schedule and Detail.
      const ev = (arr: unknown) =>
        Array.isArray(arr) ? arr.map(normalizeCanonicalHearingEvent) : [];
      const outer = (k: string) => str(raw[k]) ?? str(src[k]);
      const outerNum = (k: string) => num(raw[k]) ?? num(src[k]);
      return {
        systemCode: str(src.systemCode) ?? systemCode,
        thomasId: outer('thomasId'),
        name: str(src.name) ?? systemCode,
        chamber: str(src.chamber) ?? '',
        isSubcommittee: Boolean(src.isSubcommittee),
        parent: parent && parent.systemCode ? parent : null,
        parentSystemCode: outer('parentSystemCode') ?? null,
        parentName: outer('parentName') ?? null,
        subcommittees,
        officialUrl: str(src.officialUrl) ?? str(src.url),
        sourceUrl: outer('sourceUrl') ?? null,
        jurisdiction: str(src.jurisdiction) ?? null,
        sourceHealth: normalizeSourceHealth(outer('sourceHealth')),
        sourceHealthInheritedFrom: outer('sourceHealthInheritedFrom') ?? null,
        lastSyncedAt: outer('lastSyncedAt'),
        lastSourceSuccessAt: outer('lastSourceSuccessAt') ?? null,
        nextRefreshNotBefore: outer('nextRefreshNotBefore'),
        upcomingEventCount: outerNum('upcomingEventCount'),
        recentEventCount: outerNum('recentEventCount'),
        members,
        chair: raw.chair ? normalizeMemberRow(raw.chair) : null,
        rankingMember: raw.rankingMember ? normalizeMemberRow(raw.rankingMember) : null,
        upcomingEvents: ev(raw.upcomingEvents ?? raw.upcoming),
        recentEvents: ev(raw.recentEvents ?? raw.recent),
        updates: Array.isArray(raw.updates)
          ? (raw.updates as Array<Record<string, unknown>>).map((u, i) => ({
              key: updateKey(u, i),
              updateType: str(u.updateType),
              title: str(u.title),
              // `CommitteeSiteUpdate` publishes its link as `sourceUrl`.
              url: str(u.sourceUrl) ?? str(u.url),
              publishedAt: str(u.publishedAt),
              inheritedFromParent: Boolean(u.inheritedFromParent),
              previousValue: str(u.previousValue) ?? null,
              newValue: str(u.newValue) ?? null,
            }))
          : [],
        asOf: str(raw.asOf),
      };
    },
  });

  const leadership = useMemo(() => {
    if (!room.data) return [] as Array<{ label: string; m: RoomMember }>;
    const out: Array<{ label: string; m: RoomMember }> = [];
    if (room.data.chair) out.push({ label: 'Chair', m: room.data.chair });
    if (room.data.rankingMember) out.push({ label: 'Ranking member', m: room.data.rankingMember });
    return out;
  }, [room.data]);

  const filteredMembers = useMemo(() => {
    if (!room.data) return [] as RoomMember[];
    let rows = room.data.members;
    if (sideFilter !== 'all') {
      rows = rows.filter((m) => m.side.trim().toLowerCase() === sideFilter);
    }
    const q = memberQuery.trim().toLowerCase();
    if (q) rows = rows.filter((m) => m.name.toLowerCase().includes(q));
    // The service's order (rank asc, title asc, bioguideId asc) is authoritative;
    // filter and search are client-side over the already-loaded list, never a
    // re-sort and never a refetch.
    return rows;
  }, [room.data, sideFilter, memberQuery]);

  const majorityCount = useMemo(
    () => (room.data?.members ?? []).filter((m) => m.side.trim().toLowerCase() === 'majority').length,
    [room.data],
  );
  const minorityCount = useMemo(
    () => (room.data?.members ?? []).filter((m) => m.side.trim().toLowerCase() === 'minority').length,
    [room.data],
  );

  /* ── loading: skeleton the banner lockup, four cells, three card bodies (§5) ── */
  if (room.isLoading) {
    return (
      <div className="lwcr">
        <div className="lwcr-banner">
          <div className="lwcr-banner__inner">
            <LwSkeleton height={12} />
            <div style={{ height: 16 }} />
            <div style={{ display: 'flex', gap: 26, alignItems: 'flex-start' }}>
              <LwSkeleton height={64} />
              <div style={{ flex: 1, minWidth: 320 }}>
                <LwSkeleton height={22} />
                <div style={{ height: 9 }} />
                <LwSkeleton height={37} />
              </div>
            </div>
          </div>
        </div>
        <div className="lwcr-ledger">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="lwcr-ledger__cell">
              <LwSkeleton height={10} />
              <div style={{ height: 6 }} />
              <LwSkeleton height={13} />
              <div style={{ height: 3 }} />
              <LwSkeleton height={12} />
            </div>
          ))}
        </div>
        <div className="lwcr__grid">
          <div className="lwcr__main">
            {[0, 1, 2].map((i) => (
              <section key={i} className="lwcr-card">
                <div className="lwcr-card__head">
                  <LwSkeleton height={17} />
                </div>
                <div className="lwcr-card__body">
                  <LwSkeleton height={120} delay={i === 1 ? 2 : 3} />
                </div>
              </section>
            ))}
          </div>
          <aside className="lwcr__rail">
            <div className="lwcr-railcard">
              <LwSkeleton height={150} />
            </div>
            <div className="lwcr-railcard">
              <LwSkeleton height={110} delay={2} />
            </div>
          </aside>
        </div>
      </div>
    );
  }

  /* ── 404: committee() returns null → a 404 route, not an empty room (§5) ── */
  if (room.isError || !room.data) {
    const notFound =
      !room.isError && !room.data ? true : /not found|404/i.test(room.error?.message ?? '');
    if (notFound) {
      return (
        <div className="lwcr">
          <div className="lwcr-404">
            <h1 className="lwcr-404__title">This committee is not in the directory.</h1>
            <p className="lwcr-404__body">
              Capiro could not find a current committee or subcommittee with the code{' '}
              <span className="lw-mono" style={{ fontWeight: 600 }}>{systemCode}</span>. The room
              is shown only for a body the directory actually carries.
            </p>
            <button
              type="button"
              className="lwcr-emptycta__btn"
              onClick={() => navigate('/legiwatch?tab=hearings')}
            >
              Back to LegiWatch
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="lwcr">
        <div style={{ padding: '40px 26px' }}>
          <LwStateUnavailable
            source="Committee room"
            reason={liveHearingApiError(room.error)}
            onRetry={() => void room.refetch()}
          />
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="lwcr-emptycta__btn"
              onClick={() => navigate('/legiwatch?tab=hearings')}
            >
              Back to LegiWatch
            </button>
          </div>
        </div>
      </div>
    );
  }

  const c = room.data;
  const officialHref = safeOfficialHttpUrl(c.officialUrl);
  const sourceHref = safeOfficialHttpUrl(c.sourceUrl);
  const parentCode = c.parent?.systemCode ?? c.parentSystemCode ?? null;
  const parentDisplayName = c.parent?.name ?? c.parentName ?? null;
  const ranges = windowRanges();
  const inheritedSource = Boolean(c.sourceHealthInheritedFrom);

  const upcomingCount = c.upcomingEventCount ?? c.upcomingEvents.length;
  const recentCount = c.recentEventCount ?? c.recentEvents.length;

  const tabs: Array<{ id: string; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'proceedings', label: 'Proceedings', count: upcomingCount + recentCount },
    { id: 'members', label: 'Members', count: c.members.length },
    { id: 'updates', label: 'Updates', count: c.updates.length },
    { id: 'intelligence', label: 'Intelligence' },
  ];

  const chamberLabel = (c.chamber || 'COMMITTEE').toUpperCase();
  const levelLabel = c.isSubcommittee ? 'Subcommittee' : 'Full committee';

  return (
    <div className="lwcr" aria-label={`Committee room: ${c.name}`}>
      {/* ── banner (§3.1): metallic, light, no navy, exactly three actions ── */}
      <header className="lwcr-banner">
        <div className="lwcr-banner__inner">
          <nav className="lwcr-crumbs" aria-label="Breadcrumb">
            <button type="button" className="lwcr-crumbs__parent" onClick={() => navigate(`/legiwatch${clientId ? `?client=${encodeURIComponent(clientId)}` : ''}`)}>LegiWatch</button>
            <span>/</span>
            <button type="button" className="lwcr-crumbs__parent" onClick={() => navigate(`/legiwatch?tab=committees${clientId ? `&client=${encodeURIComponent(clientId)}` : ''}`)}>Committees</button>
            {parentCode ? (
              <>
                <span>/</span>
                <button
                  type="button"
                  className="lwcr-crumbs__parent"
                  onClick={() => navigate(`/legiwatch/committees/${encodeURIComponent(parentCode)}`)}
                >
                  {parentCode.toUpperCase()}
                </button>
              </>
            ) : null}
          </nav>

          <div className="lwcr-banner__row">
            <div className="lwcr-seal" aria-hidden="true">
              <DashboardIcon name="Building02" size={26} />
            </div>
            <div style={{ flex: 1, minWidth: 320 }}>
              <div className="lwcr-lockup">
                <span className="lwcr-chamber">{chamberLabel}</span>
                <span className="lwcr-level">{levelLabel}</span>
                <span className="lwcr-divider" aria-hidden="true" />
                <span className="lwcr-syscode">{c.systemCode.toUpperCase()}</span>
              </div>
              <h1 className="lwcr-title">{c.name}</h1>
              {parentCode && parentDisplayName ? (
                <button
                  type="button"
                  className="lwcr-parentline"
                  onClick={() => navigate(`/legiwatch/committees/${encodeURIComponent(parentCode)}`)}
                >
                  Subcommittee of the {parentDisplayName}
                  <DashboardIcon name="ArrowNarrowRight" size={15} color="var(--lw-meta)" />
                </button>
              ) : null}
            </div>
            <div className="lwcr-actions">
              {following ? (
                <button
                  type="button"
                  className="lwcr-follow lwcr-follow--edit"
                  onClick={() => setFollowOpen(true)}
                  disabled={follow.isLoading}
                >
                  <DashboardIcon name="BookmarkCheck" size={17} color="var(--lw-label)" />
                  Following · edit
                </button>
              ) : (
                <button
                  type="button"
                  className="lwcr-follow lwcr-follow--primary"
                  onClick={() => setFollowOpen(true)}
                  disabled={follow.isLoading}
                >
                  <DashboardIcon name="Bookmark" size={17} />
                  Follow committee
                </button>
              )}
              <div className="lwcr-actions__links">
                {officialHref ? (
                  <a className="lwcr-extlink" href={officialHref} target="_blank" rel="noreferrer noopener">
                    Official site
                    <DashboardIcon name="LinkExternal01" size={13} color="var(--lw-meta)" />
                  </a>
                ) : null}
                {sourceHref ? (
                  <a className="lwcr-extlink" href={sourceHref} target="_blank" rel="noreferrer noopener">
                    Monitored source
                    <DashboardIcon name="LinkExternal01" size={13} color="var(--lw-meta)" />
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* ── provenance strip (§3.2): four real fields, no invented counts ── */}
      <div className="lwcr-ledger" aria-label="Provenance">
        <div className="lwcr-ledger__cell">
          <div className="lwcr-eyebrow">Source health</div>
          <div className="lwcr-ledger__value">
            <span
              className="lwcr-dot"
              style={{
                background:
                  c.sourceHealth === 'healthy'
                    ? 'var(--lw-succ-dot)'
                    : c.sourceHealth === 'degraded'
                      ? 'var(--lw-warn-dot)'
                      : c.sourceHealth === 'failing'
                        ? 'var(--lw-error-dot)'
                        : 'var(--lw-faint)',
              }}
              aria-hidden="true"
            />
            {c.sourceHealth === 'healthy'
              ? 'Healthy'
              : c.sourceHealth === 'degraded'
                ? 'Degraded'
                : c.sourceHealth === 'failing'
                  ? 'Failing'
                  : 'Not yet read'}
          </div>
          <div className="lwcr-ledger__sub">
            {c.sourceHealthInheritedFrom
              ? `Inherited from ${c.sourceHealthInheritedFrom.toUpperCase()}`
              : sourceHref ? 'Own source' : 'No monitored source'}
          </div>
        </div>
        <div className="lwcr-ledger__cell">
          <div className="lwcr-eyebrow">Last source success</div>
          <div className="lwcr-ledger__value">
            {c.lastSourceSuccessAt ? stampLabel(c.lastSourceSuccessAt) : 'Never read'}
          </div>
          <div className="lwcr-ledger__sub">
            {inheritedSource ? 'Parent monitored source only' : 'Monitored source only'}
          </div>
        </div>
        <div className="lwcr-ledger__cell">
          <div className="lwcr-eyebrow">Committee record</div>
          <div className="lwcr-ledger__value">
            {c.lastSyncedAt ? stampLabel(c.lastSyncedAt) : '—'}
          </div>
          <div className="lwcr-ledger__sub">Identity, roster, leadership</div>
        </div>
        <div className="lwcr-ledger__cell">
          <div className="lwcr-eyebrow">Next refresh</div>
          <div className="lwcr-ledger__value">
            {c.nextRefreshNotBefore ? `Not before ${dayLabel(c.nextRefreshNotBefore)}` : '—'}
          </div>
          <div className="lwcr-ledger__sub">One directory rebuild per day</div>
        </div>
      </div>

      {/* ── tab strip (§3.3) ── */}
      <div className="lwcr-tabs" role="tablist" aria-label="Committee sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`lwcr-tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              if (t.id === 'overview') next.delete('tab');
              else next.set('tab', t.id);
              navigate({ search: `?${next.toString()}` }, { replace: true });
            }}
          >
            {t.label}
            {typeof t.count === 'number' ? <span className="lwcr-tab__count">{t.count}</span> : null}
          </button>
        ))}
      </div>

      <div className="lwcr__grid">
        <div className="lwcr__main">
          {/* ── Proceedings (§3.4) ── */}
          {(tab === 'overview' || tab === 'proceedings') && (
            <section className="lwcr-card" aria-label="Proceedings">
              <div className="lwcr-card__head">
                <h2 className="lwcr-card__title">Proceedings</h2>
                <span className="lwcr-card__meta">
                  {upcomingCount} UPCOMING · {recentCount} RECENT
                </span>
              </div>

              {c.upcomingEvents.length === 0 && c.recentEvents.length === 0 ? (
                /* An empty local result cannot establish that no official proceedings exist. */
                <>
                  <div className="lwcr-card__body">
                    <p className="lwcr-claim">No proceedings are available in Capiro for these windows.</p>
                    <p className="lwcr-provenance">
                      {inheritedSource ? (
                        <>
                          Subcommittee coverage is incomplete or unverified. The source health and last
                          success shown here belong to {c.sourceHealthInheritedFrom?.toUpperCase()},
                          the parent committee. They do not confirm a successful check of this
                          subcommittee&rsquo;s calendar.
                        </>
                      ) : c.sourceHealth === 'failing' || c.sourceHealth === 'degraded' ? (
                        <>The monitored source needs attention, so coverage may be incomplete.</>
                      ) : !c.lastSourceSuccessAt ? (
                        <>No successful check of this committee&rsquo;s monitored source is recorded.</>
                      ) : (
                        <>A successful source check does not verify complete proceedings coverage.</>
                      )}
                      {' '}An empty result does not establish that no hearings, markups or briefings
                      occurred. Check the official committee records for additional proceedings.
                    </p>
                    <div className="lwcr-windows">
                      <div className="lwcr-window">
                        <div className="lwcr-window__eyebrow">Upcoming window</div>
                        <div className="lwcr-window__count">
                          <span className="lwcr-window__num">{upcomingCount}</span>
                          <span className="lwcr-window__published">in Capiro</span>
                        </div>
                        <div className="lwcr-window__range">{ranges.upcoming}</div>
                      </div>
                      <div className="lwcr-window">
                        <div className="lwcr-window__eyebrow">Past window</div>
                        <div className="lwcr-window__count">
                          <span className="lwcr-window__num">{recentCount}</span>
                          <span className="lwcr-window__published">in Capiro</span>
                        </div>
                        <div className="lwcr-window__range">{ranges.past}</div>
                      </div>
                    </div>
                    {!following ? (
                      <div className="lwcr-emptycta">
                        <button
                          type="button"
                          className="lwcr-emptycta__btn"
                          onClick={() => setFollowOpen(true)}
                        >
                          <DashboardIcon name="Bookmark" size={16} color="var(--lw-meta)" />
                          Follow for newly discovered proceedings
                        </button>
                        <span className="lwcr-emptycta__note">
                          Notification on new hearing is on by default.
                        </span>
                      </div>
                    ) : null}
                  </div>
                  {/* parent bridge footer — only when the parent has a non-zero count */}
                  {parentCode && (c.upcomingEventCount ?? 0) === 0 && (c.recentEventCount ?? 0) === 0 ? null : null}
                </>
              ) : (
                /* proceedings exist: the event list, never both this and the empty state */
                <div className="lwcr-card__body lwcr-card__body--flush" style={{ padding: '0 20px' }}>
                  <div aria-label="Upcoming hearings">
                    {c.upcomingEvents.length > 0 ? (
                      c.upcomingEvents.map((e) => {
                        const m = momentOfCanonicalEvent(e);
                        return (
                          <button
                            key={e.id}
                            type="button"
                            className="lwcr-event"
                            onClick={() => navigate(`/legiwatch/hearings/${encodeURIComponent(e.id)}`)}
                          >
                            <span className="lwcr-event__when">
                              {formatHearingDay(m, true)} · {formatHearingTime(m)}
                            </span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <span className="lwcr-event__title">{e.title}</span>
                              <span className="lwcr-event__meta">
                                <span className="lwcr-update__type">
                                  {hearingEventLabel(e.eventStatus, e.scheduledStart, e.calendarDate)}
                                </span>
                                {e.eventType ? (
                                  <span className="lwcr-update__type">{e.eventType}</span>
                                ) : null}
                              </span>
                            </span>
                            <DashboardIcon name="ArrowNarrowRight" size={16} color="var(--lw-faint)" />
                          </button>
                        );
                      })
                    ) : (
                      <p style={{ fontSize: 13, color: 'var(--lw-meta)', margin: '13px 0 0' }}>
                        Nothing scheduled in the upcoming window.
                      </p>
                    )}
                  </div>
                  <div aria-label="Past hearings">
                    {c.recentEvents.length > 0 ? (
                      c.recentEvents.map((e) => {
                        const m = momentOfCanonicalEvent(e);
                        return (
                          <button
                            key={e.id}
                            type="button"
                            className="lwcr-event"
                            onClick={() => navigate(`/legiwatch/hearings/${encodeURIComponent(e.id)}`)}
                          >
                            <span className="lwcr-event__when">
                              {formatHearingDay(m, true)} · {formatHearingTime(m)}
                            </span>
                            <span style={{ flex: 1, minWidth: 0 }}>
                              <span className="lwcr-event__title">{e.title}</span>
                              <span className="lwcr-event__meta">
                                <span className="lwcr-update__type">
                                  {hearingEventLabel(e.eventStatus, e.scheduledStart, e.calendarDate)}
                                </span>
                                {e.eventType ? (
                                  <span className="lwcr-update__type">{e.eventType}</span>
                                ) : null}
                              </span>
                            </span>
                            <DashboardIcon name="ArrowNarrowRight" size={16} color="var(--lw-faint)" />
                          </button>
                        );
                      })
                    ) : c.upcomingEvents.length > 0 ? (
                      <p style={{ fontSize: 13, color: 'var(--lw-meta)', margin: '0 0 13px' }}>
                        No proceedings in the past window.
                      </p>
                    ) : null}
                  </div>
                </div>
              )}

              {/* parent bridge footer (§3.4): full-width button; parent rooms include
                  their subcommittees' proceedings */}
              {parentCode && parentDisplayName && (upcomingCount > 0 || recentCount > 0) ? (
                <button
                  type="button"
                  className="lwcr-bridge"
                  onClick={() => navigate(`/legiwatch/committees/${encodeURIComponent(parentCode)}`)}
                >
                  <DashboardIcon name="Building02" size={18} color="var(--lw-link)" />
                  <span className="lwcr-bridge__body">
                    <span className="lwcr-bridge__title">
                      The parent committee&rsquo;s room carries this one&rsquo;s calendar
                    </span>
                    <span className="lwcr-bridge__sub">
                      {parentCode.toUpperCase()} has {upcomingCount} upcoming and {recentCount} recent
                      proceedings, including any held by its subcommittees.
                    </span>
                  </span>
                  <DashboardIcon name="ArrowNarrowRight" size={16} color="var(--lw-link)" />
                </button>
              ) : null}
            </section>
          )}

          {/* ── Leadership + roster (§3.5) ── */}
          {(tab === 'overview' || tab === 'members') && (
            <section className="lwcr-card" aria-label="Members and leadership">
              <div className="lwcr-card__body">
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <h2 className="lwcr-card__title">Leadership</h2>
                  <span className="lwcr-card__meta">READ FROM THE STATED ROSTER TITLE</span>
                </div>

                {leadership.length > 0 ? (
                  <div className="lwcr-leaders">
                    {leadership.map(({ label, m }) => {
                      const pal = partyPalette(m.party);
                      return (
                        <button
                          key={label}
                          type="button"
                          className="lwcr-leader"
                          style={
                            pal
                              ? ({
                                  ['--lwcr-party' as string]: pal.ink,
                                  ['--lwcr-tint' as string]: pal.tint,
                                  ['--lwcr-ring' as string]: pal.ring,
                                } as React.CSSProperties)
                              : undefined
                          }
                          disabled={!m.profileId}
                          title={m.profileId ? undefined : 'A member profile identity is unavailable for this roster entry.'}
                          onClick={() => m.profileId && navigate(DIRECTORY_PROFILE_ROUTES.member(m.profileId))}
                        >
                          <span className="lwcr-mono44">{initials(m.name)}</span>
                          <span className="lwcr-leader__body">
                            <span className="lwcr-leader__role">{label}</span>
                            <span className="lwcr-leader__name">{m.name}</span>
                            <span className="lwcr-leader__sub">
                              {caucusName(m.party)} · {m.side ? m.side : 'Member'}
                            </span>
                            {!m.profileId ? <span className="lwcr-leader__sub">Profile unavailable</span> : null}
                          </span>
                          {m.profileId ? <DashboardIcon name="ArrowNarrowRight" size={16} color="var(--lw-faint)" /> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="lwcr-leader__absent">
                    {c.chair == null
                      ? 'No chair is recorded on the published roster.'
                      : 'No ranking member is recorded on the published roster.'}
                  </p>
                )}

                <div className="lwcr-rosterhead">
                  <h3 className="lwcr-rosterhead__title">Full roster</h3>
                  <div className="lwcr-sidefilter" role="group" aria-label="Filter roster by side">
                    {(
                      [
                        ['all', `All`, c.members.length],
                        ['majority', 'Majority', majorityCount],
                        ['minority', 'Minority', minorityCount],
                      ] as Array<[typeof sideFilter, string, number]>
                    ).map(([id, label, count]) => (
                      <button
                        key={id}
                        type="button"
                        className={`lwcr-sidefilter__cell${sideFilter === id ? ' is-active' : ''}`}
                        onClick={() => setSideFilter(id)}
                      >
                        {label}
                        <span className="lwcr-sidefilter__count">{count}</span>
                      </button>
                    ))}
                  </div>
                  <label className="lwcr-membersearch">
                    <DashboardIcon name="SearchLg" size={15} color="var(--lw-meta)" />
                    <input
                      type="text"
                      placeholder="Find a member"
                      aria-label="Find a member"
                      value={memberQuery}
                      onChange={(e) => setMemberQuery(e.target.value)}
                    />
                  </label>
                </div>

                {filteredMembers.length > 0 ? (
                  <div className="lwcr-roster">
                    {filteredMembers.map((m, i) => {
                      const pal = partyPalette(m.party);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className="lwcr-member"
                          disabled={!m.profileId}
                          title={m.profileId ? undefined : 'A member profile identity is unavailable for this roster entry.'}
                          onClick={() => m.profileId && navigate(DIRECTORY_PROFILE_ROUTES.member(m.profileId))}
                        >
                          <span className="lwcr-member__rank">{m.rank ?? i + 1}</span>
                          <span
                            className="lwcr-mono26"
                            style={
                              pal
                                ? ({
                                    ['--lwcr-party' as string]: pal.ink,
                                    ['--lwcr-tint' as string]: pal.tint,
                                  } as React.CSSProperties)
                                : undefined
                            }
                          >
                            {pal ? initials(m.name) : '—'}
                          </span>
                          <span className="lwcr-member__name">{m.name}</span>
                          {m.role ? <span className="lwcr-member__role">{m.role}</span> : null}
                          {!m.profileId ? <span className="lwcr-member__role">Profile unavailable</span> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p style={{ fontSize: 13, color: 'var(--lw-meta)', margin: '12px 0 0' }}>
                    {c.members.length === 0
                      ? 'Membership has not been synced for this body yet.'
                      : 'No members match the current filter.'}
                  </p>
                )}
              </div>
            </section>
          )}

          {/* ── Updates (§3.6) ── */}
          {(tab === 'overview' || tab === 'updates') && (
            <section className="lwcr-card" aria-label="What has been published">
              <div className="lwcr-card__body">
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <h2 className="lwcr-card__title">What has been published</h2>
                  <span className="lwcr-card__meta">{c.updates.length} CHANGES</span>
                </div>
                <p style={{ margin: '8px 0 0', maxWidth: 700, fontSize: 13, lineHeight: '20px', color: 'var(--lw-body)', textWrap: 'pretty' }}>
                  Official changes Capiro observed on this {c.isSubcommittee ? 'subcommittee' : 'committee'}&rsquo;s
                  pages{parentCode ? ` and, where it has none of its own, on ${parentCode.toUpperCase()}’s` : ''}.
                  Newest first.
                </p>

                {c.updates.length === 0 ? (
                  <p style={{ fontSize: 13, color: 'var(--lw-meta)', margin: '16px 0 0' }}>
                    No official site updates recorded yet.
                  </p>
                ) : (
                  <ul className="lwcr-updates" aria-label="Official updates" style={{ listStyle: 'none', margin: '16px 0 0', padding: 0 }}>
                    {c.updates.map((u) => {
                      const href = safeOfficialHttpUrl(u.url);
                      const hasDiff = Boolean(u.previousValue) && Boolean(u.newValue);
                      const open = expandedUpdate === u.key;
                      return (
                        <li key={u.key} style={{ borderBottom: '1px solid var(--lw-hover)' }}>
                          <div
                            className="lwcr-update"
                            role={hasDiff ? 'button' : undefined}
                            tabIndex={hasDiff ? 0 : undefined}
                            aria-expanded={hasDiff ? open : undefined}
                            onClick={hasDiff ? () => setExpandedUpdate(open ? null : u.key) : undefined}
                            onKeyDown={hasDiff ? (e) => { if (e.key === 'Enter' || e.key === ' ') setExpandedUpdate(open ? null : u.key); } : undefined}
                          >
                            <span className="lwcr-update__date">{u.publishedAt ? dayLabel(u.publishedAt) : '—'}</span>
                            <span className="lwcr-update__node" aria-hidden="true" />
                            <span className="lwcr-update__body">
                              {href ? (
                                <a className="lwcr-update__title" href={href} target="_blank" rel="noreferrer noopener">
                                  {u.title ?? 'Update'}
                                </a>
                              ) : (
                                <span className="lwcr-update__title">{u.title ?? 'Update'}</span>
                              )}
                              <span className="lwcr-update__meta">
                                <span className="lwcr-update__type">{updateTypeLabel(u.updateType)}</span>
                                {u.inheritedFromParent && parentCode ? (
                                  <span className="lwcr-update__from">FROM {parentCode.toUpperCase()}</span>
                                ) : null}
                              </span>
                              {hasDiff && open ? (
                                <UpdateDiff previous={u.previousValue!} next={u.newValue!} />
                              ) : null}
                            </span>
                            {href ? (
                              <DashboardIcon name="LinkExternal01" size={15} color="var(--lw-faint)" />
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          )}

          {/* ── Intelligence (§8 — route exists, not designed; render the real
              history section, never a faked one) ── */}
          {tab === 'intelligence' && (
            <CommitteeIntelligenceHistorySection systemCode={systemCode} clientId={clientId} />
          )}
          {(tab === 'overview' || tab === 'intelligence') && tab !== 'intelligence' ? null : null}
        </div>

        {/* ── rail (§3.7) ── */}
        <aside className="lwcr__rail">
          {/* Follow card — navy tint; the not-a-claim sentence is required */}
          {!following ? (
            <div className="lwcr-follow-card">
              <div className="lwcr-follow-card__eyebrow">Your follow</div>
              <p className="lwcr-follow-card__lead">
                You are not following this {c.isSubcommittee ? 'subcommittee' : 'committee'}.
              </p>
              <p className="lwcr-follow-card__body">
                Following notifies you when it schedules a new hearing, and lets you attach the
                clients you are watching it for.
              </p>
              <button
                type="button"
                className="lwcr-follow-card__cta"
                onClick={() => setFollowOpen(true)}
                disabled={follow.isLoading}
              >
                <DashboardIcon name="Bookmark" size={16} />
                Follow committee
              </button>
              <p className="lwcr-follow-card__fine">Only your workspace sees your follows.</p>
            </div>
          ) : (
            <div className="lwcr-follow-card">
              <div className="lwcr-follow-card__head">
                <div className="lwcr-follow-card__eyebrow">Your follow</div>
                <button type="button" className="lwcr-follow-card__edit" onClick={() => setFollowOpen(true)}>
                  Edit
                </button>
              </div>
              <div className="lwcr-notify-row">
                <DashboardIcon name="Bell01" size={16} color="var(--lw-link)" />
                <span className="lwcr-notify-row__label">Notify on new hearing</span>
                <span className="lwcr-notify-row__state">
                  {follow.data?.notifyOnNewHearing ? 'ON' : 'OFF'}
                </span>
              </div>
              <div className="lwcr-follow-card__eyebrow" style={{ marginTop: 11 }}>
                Clients attached
              </div>
              {(follow.data?.clients ?? []).length > 0 ? (
                <div className="lwcr-pills">
                  {(follow.data?.clients ?? []).map((cl) => (
                    <span key={cl.id} className="lwcr-clientpill">
                      {cl.name ?? 'Unnamed client'}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="lwcr-noclients">No clients attached</p>
              )}
              <p className="lwcr-follow-card__fine">
                Attaching a client records why you are watching. It is not a claim that the client is
                affected.
              </p>
            </div>
          )}

          {/* Source chain */}
          <div className="lwcr-railcard" id="source">
            <div className="lwcr-railcard__eyebrow">Source chain</div>
            <div className="lwcr-chain">
              {c.sourceHealthInheritedFrom && parentCode ? (
                <>
                  <div className="lwcr-chain__node">
                    <span className="lwcr-chain__tile lwcr-chain__tile--parent">P</span>
                    <span className="lwcr-chain__label">{parentCode.toUpperCase()} owns the source</span>
                    <span
                      className="lwcr-dot"
                      style={{
                        background:
                          c.sourceHealth === 'healthy'
                            ? 'var(--lw-succ-dot)'
                            : c.sourceHealth === 'degraded'
                              ? 'var(--lw-warn-dot)'
                              : c.sourceHealth === 'failing'
                                ? 'var(--lw-error-dot)'
                                : 'var(--lw-faint)',
                      }}
                      aria-hidden="true"
                    />
                  </div>
                  <div className="lwcr-chain__connector" aria-hidden="true" />
                  <div className="lwcr-chain__node">
                    <span className="lwcr-chain__tile lwcr-chain__tile--self">S</span>
                    <span className="lwcr-chain__label">{c.systemCode.toUpperCase()} · this room</span>
                    <span className="lwcr-chain__tag">INHERITED</span>
                  </div>
                </>
              ) : (
                <div className="lwcr-chain__node">
                  <span className="lwcr-chain__tile lwcr-chain__tile--self">S</span>
                  <span className="lwcr-chain__label">{c.systemCode.toUpperCase()} · this room</span>
                  <span
                    className="lwcr-dot"
                    style={{
                      background:
                        c.sourceHealth === 'healthy'
                          ? 'var(--lw-succ-dot)'
                          : c.sourceHealth === 'degraded'
                            ? 'var(--lw-warn-dot)'
                            : c.sourceHealth === 'failing'
                              ? 'var(--lw-error-dot)'
                              : 'var(--lw-faint)',
                    }}
                    aria-hidden="true"
                  />
                </div>
              )}
            </div>
            {c.sourceHealthInheritedFrom ? (
              <p className="lwcr-chain__note">
                This room uses its parent committee&rsquo;s source health. No independent check of
                this subcommittee&rsquo;s calendar is recorded, and child-committee coverage remains
                unverified.
              </p>
            ) : null}
            {sourceHref ? (
              <a className="lwcr-chain__link" href={sourceHref} target="_blank" rel="noreferrer noopener">
                Open the monitored source
                <DashboardIcon name="LinkExternal01" size={14} color="var(--lw-link)" />
              </a>
            ) : null}
          </div>

          {/* Identity */}
          <div className="lwcr-railcard">
            <div className="lwcr-railcard__eyebrow">Identity</div>
            <div className="lwcr-identity">
              <div className="lwcr-identity__row">
                <span className="lwcr-identity__label">System code</span>
                <span className="lwcr-identity__value">{c.systemCode.toUpperCase()}</span>
              </div>
              {c.thomasId ? (
                <div className="lwcr-identity__row">
                  <span className="lwcr-identity__label">Thomas ID</span>
                  <span className="lwcr-identity__value">{c.thomasId}</span>
                </div>
              ) : null}
              <div className="lwcr-identity__row">
                <span className="lwcr-identity__label">Chamber</span>
                <span className="lwcr-identity__value">{chamberLabel}</span>
              </div>
              {c.isSubcommittee && parentCode ? (
                <div className="lwcr-identity__row">
                  <span className="lwcr-identity__label">Parent</span>
                  <span className="lwcr-identity__value">{parentCode.toUpperCase()}</span>
                </div>
              ) : null}
              <div className="lwcr-identity__row">
                <span className="lwcr-identity__label">Subcommittees</span>
                <span className="lwcr-identity__value">{c.subcommittees.length}</span>
              </div>
            </div>
            {c.subcommittees.length > 0 ? (
              <div aria-label="Subcommittees" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {c.subcommittees.map((s) => (
                  <button
                    key={s.systemCode}
                    type="button"
                    className="lwcr-chain__link"
                    style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => navigate(`/legiwatch/committees/${encodeURIComponent(s.systemCode)}`)}
                  >
                    {s.name}
                    <DashboardIcon name="ArrowNarrowRight" size={13} color="var(--lw-link)" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* Jurisdiction */}
          <div className="lwcr-railcard">
            <div className="lwcr-railcard__eyebrow">Jurisdiction</div>
            {c.jurisdiction ? (
              <p className="lwcr-jurisdiction">{c.jurisdiction}</p>
            ) : (
              <p className="lwcr-jurisdiction lwcr-jurisdiction--null">
                No jurisdiction statement is published for this {c.isSubcommittee ? 'subcommittee' : 'committee'}.
                Capiro shows nothing rather than describing the body on its behalf.
              </p>
            )}
          </div>
        </aside>
      </div>

      {followOpen ? (
        <CommitteeFollowDialog
          systemCode={systemCode}
          committeeName={c.name}
          onClose={() => setFollowOpen(false)}
        />
      ) : null}
    </div>
  );
}
