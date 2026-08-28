/**
 * vNext Meeting Library — Engagement navy reskin (Library phase, 2026-08-16).
 *
 * A genuinely new surface (design README §8 / `Capiro Engagement - Untitled
 * UI.dc.html`'s `isLibrary` block / `screenshots/05-meeting-library.png`),
 * NOT a re-skin of the canonical `MeetingLibraryView.tsx`: that component is
 * built on a THIRD, unrelated "redesign v2" design system (Hanken Grotesk,
 * JetBrains Mono, accent #2a57ce) with essentially no visual overlap with
 * this module's literal navy, so there's no CSS-variable-override shortcut
 * here (unlike the drawer phase's reuse of the canonical MeetingDetailPanel).
 * This is genuinely new markup, matching the pattern VNextMeetingsWorkspace
 * already established for this reskin.
 *
 * Reused as-is (canonical data layer, none of it Library-page-specific
 * layout):
 *   - meetings-api.ts — useMeetingLibrary/useClientOptions (the real query:
 *     clientId/artifactType/visibility/from/to/page/limit).
 *   - meetings-types.ts — Meeting, ArtifactKind, and the approvedPrep/
 *     approvedDebrief helpers (see libraryMaterialsLabel below for why this
 *     phase needs the APPROVED helpers specifically, not the "completed"
 *     ones MaterialBadges/meetingStatus use elsewhere in Meetings).
 *   - meetings-format.ts — formatDateShort, the same Date-column formatter
 *     the canonical MeetingLibraryView already uses for this exact field.
 *
 * Dropdown-button filters: the design mockup's own three filter buttons are
 * DECORATIVE in the prototype itself — literally `libFilters:[['client','All
 * clients'],['type','All · Prep · Notes · Debrief'],['vis','All · Shared ·
 * Private']].map(([k,label]) => ({label, go:()=>{}}))` in
 * `Capiro Engagement - Untitled UI.dc.html` (a no-op `go` handler). The
 * mockup only ever shows their unfiltered default labels and never
 * demonstrates a "filtered" visual state. This phase makes them genuinely
 * functional (wired to the real query), and — since there's no mockup pixel
 * to match for the filtered state — shows the literal default label
 * ("All clients" / "All · Prep · Notes · Debrief" / "All · Shared ·
 * Private") when unset, and the selected option's own short label once a
 * specific filter is chosen, so the control gives real feedback instead of
 * silently keeping its "All ..." text while actually filtering.
 *
 * URL contract: `q` (search), `client`, `type` (artifact kind), `vis`
 * (visibility), `from`/`to` (date range, YYYY-MM-DD), `page` — the same
 * "only serialize non-default" minimalism and dual-ref-guarded-effects
 * pattern VNextMeetingsWorkspace.tsx established for `view`/`date`/
 * `meeting`/`tab`. Fixes a real usability gap: today (canonical
 * MeetingLibraryView) a reload silently loses every filter.
 *
 * Date-range + pagination are real controls the mockup gives no visual
 * treatment to. This phase lands the date range as an always-visible
 * secondary row directly under the primary (pixel-precise) filter row —
 * rather than folding it into that row or making it click-to-expand, so nothing
 * pushes the mockup's own 4-control row out of its literal shape, and the
 * range stays discoverable without an extra click. Pagination is a footer
 * below the table (Previous / Page X of Y / Next), shown only once there's
 * more than one page — matching the phase brief's own suggested placements.
 *
 * The client-scope selector in the module header above (uui-client-scope) is
 * NOT wired to this component's own client dropdown: Meetings has no
 * client-picker UI of its own and so must inherit that shell scope directly,
 * but Library's mockup gives it an independent "All clients" control with
 * its own URL param, so — for the same reason its search/type/visibility
 * filters are independent, URL-owned state — its client filter defaults
 * purely from the URL (else "All clients") rather than being seeded from or
 * coupled to the shell scope, avoiding a two-sources-of-truth conflict for
 * one field.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Search } from 'lucide-react';
import { useClientOptions, useMeetingLibrary } from '../../../pages/engagement/meetings/meetings-api.js';
import { formatDateShort } from '../../../pages/engagement/meetings/meetings-format.js';
import {
  approvedDebrief,
  approvedPrep,
  type ArtifactKind,
  type Meeting,
} from '../../../pages/engagement/meetings/meetings-types.js';

const PAGE_SIZE = 25;

type LibraryTypeFilter = 'all' | ArtifactKind;
type LibraryVisibilityFilter = 'all' | 'shared' | 'private';

function parseTypeFilter(raw: string | null): LibraryTypeFilter {
  return raw === 'prep' || raw === 'notes' || raw === 'debrief' ? raw : 'all';
}

function parseVisibilityFilter(raw: string | null): LibraryVisibilityFilter {
  return raw === 'shared' || raw === 'private' ? raw : 'all';
}

function parsePage(raw: string | null): number {
  const n = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * The Materials cell (design README §8: "the materials string (e.g.
 * `Prep · Notes`)") is plain text, not the MaterialBadges 3-badge grid
 * MaterialBadges/meetingStatus render elsewhere in Meetings. It also can't
 * reuse meetingStatus()'s semantics: that helper counts Prep/Debrief as
 * "done" once merely GENERATED (see completedPrep/completedDebrief's own doc
 * comments in meetings-types.ts), but Library's entire premise — its own
 * subline, both here and in the shell header — is that ONLY APPROVED/SAVED
 * material appears here. So this asks the stricter, real question per kind:
 *   - Prep: approvedPrep(m) — the current prep with status === 'approved'.
 *   - Notes: m.notesApproved — the decorated Meeting's own top-level "at
 *     least one note is approved" field (Phase 2 §d's notes lifecycle).
 *   - Debrief: approvedDebrief(m) — the debrief with status === 'approved'.
 * All three are real, already-decorated Meeting fields — nothing fabricated.
 * Joined with the same " · " and prep/notes/debrief order the design
 * prototype's own LIBRARY fixture rows use (e.g. "Prep · Notes").
 */
function libraryMaterialsLabel(m: Meeting): string {
  const parts: string[] = [];
  if (approvedPrep(m)) parts.push('Prep');
  if (m.notesApproved) parts.push('Notes');
  if (approvedDebrief(m)) parts.push('Debrief');
  return parts.length > 0 ? parts.join(' · ') : '—';
}

interface DropdownOption {
  value: string;
  label: string;
}

const TYPE_OPTIONS: DropdownOption[] = [
  { value: '', label: 'All' },
  { value: 'prep', label: 'Prep' },
  { value: 'notes', label: 'Notes' },
  { value: 'debrief', label: 'Debrief' },
];

const VISIBILITY_OPTIONS: DropdownOption[] = [
  { value: '', label: 'All' },
  { value: 'shared', label: 'Shared' },
  { value: 'private', label: 'Private' },
];

/**
 * A real dropdown-button (design README §8: "three dropdown buttons, each
 * 40px white with a ChevronDown") — explicitly NOT a native `<select>` and
 * NOT a segmented toggle per the phase brief. Shows `defaultLabel` (the
 * mockup's literal closed-state text) until a non-"All" option is chosen,
 * then shows that option's own short label — see the file header for why.
 */
function LibraryDropdown({
  ariaLabel,
  defaultLabel,
  options,
  selectedValue,
  onSelect,
}: {
  ariaLabel: string;
  defaultLabel: string;
  options: DropdownOption[];
  selectedValue: string;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const selected = options.find((option) => option.value === selectedValue);
  const label = selected && selected.value !== '' ? selected.label : defaultLabel;

  return (
    <div className="uui-library-dropdown" ref={rootRef}>
      <button
        type="button"
        className="uui-library-dropdown__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{label}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="uui-library-dropdown__menu">
          {options.map((option) => (
            <button
              key={option.value || 'all'}
              type="button"
              data-selected={option.value === selectedValue || undefined}
              onClick={() => {
                onSelect(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function VNextMeetingLibrary() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const [q, setQ] = useState('');
  const [clientId, setClientId] = useState<string | undefined>(undefined);
  const [type, setType] = useState<LibraryTypeFilter>('all');
  const [vis, setVis] = useState<LibraryVisibilityFilter>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);

  const clients = useClientOptions();

  // Same durable URL⇄state pattern VNextMeetingsWorkspace.tsx established
  // for view/cursor/selected-meeting/tab — two guarded effects, each skipping
  // the other's own write via a ref, serializing only non-default values.
  const syncingFromUrlRef = useRef(false);
  const lastProcessedUrlRef = useRef('');

  useEffect(() => {
    const urlKey = searchParams.toString();
    if (lastProcessedUrlRef.current === urlKey) return;
    lastProcessedUrlRef.current = urlKey;

    const nextQ = searchParams.get('q') ?? '';
    const nextClient = searchParams.get('client') ?? undefined;
    const nextType = parseTypeFilter(searchParams.get('type'));
    const nextVis = parseVisibilityFilter(searchParams.get('vis'));
    const nextFrom = searchParams.get('from') ?? '';
    const nextTo = searchParams.get('to') ?? '';
    const nextPage = parsePage(searchParams.get('page'));

    const hasChange =
      nextQ !== q ||
      nextClient !== clientId ||
      nextType !== type ||
      nextVis !== vis ||
      nextFrom !== fromDate ||
      nextTo !== toDate ||
      nextPage !== page;
    if (!hasChange) return;

    syncingFromUrlRef.current = true;
    setQ(nextQ);
    setClientId(nextClient);
    setType(nextType);
    setVis(nextVis);
    setFromDate(nextFrom);
    setToDate(nextTo);
    setPage(nextPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (syncingFromUrlRef.current) {
      syncingFromUrlRef.current = false;
      return;
    }
    // openMeeting() below navigates AWAY to /engagement/meetings on a real
    // row click. In the shipped app that swaps VNextEngagementRoutes' render
    // switch to a different component (this one unmounts), so the scenario
    // below never arises there — but nothing stops this effect from firing
    // one more time first if this component is still mounted when the
    // pathname changes (confirmed by this component's own test harness,
    // which — unlike the real router — keeps it mounted across a navigate()
    // call). Without this guard it would rewrite the URL right back to a
    // bare /engagement/meeting-library, stomping the real navigation.
    if (location.pathname !== '/engagement/meeting-library') return;
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (clientId) params.set('client', clientId);
    if (type !== 'all') params.set('type', type);
    if (vis !== 'all') params.set('vis', vis);
    if (fromDate) params.set('from', fromDate);
    if (toDate) params.set('to', toDate);
    if (page !== 1) params.set('page', String(page));

    const nextSearch = params.toString();
    if (nextSearch === searchParams.toString()) return;

    lastProcessedUrlRef.current = nextSearch;
    navigate(
      { pathname: '/engagement/meeting-library', search: nextSearch ? `?${nextSearch}` : '' },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, clientId, type, vis, fromDate, toDate, page, navigate, location.pathname]);

  const library = useMeetingLibrary({
    // `undefined`, not '': the params object is part of the react-query key, so
    // `search: ''` is a different key from "no search" and clearing the box
    // would refetch instead of reusing the unfiltered result.
    search: q.trim() || undefined,
    clientId,
    artifactType: type === 'all' ? undefined : type,
    visibility: vis === 'all' ? undefined : vis,
    from: fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined,
    to: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined,
    page,
    limit: PAGE_SIZE,
  });

  /*
   * No client-side text filter any more. `search` is a real server parameter, so
   * the server has already applied it — and `total` below reflects it, which is
   * what makes pagination correct. Re-filtering here would be a no-op on the
   * happy path and actively wrong on the unhappy one: it would hide rows the
   * server counted, so page N could render empty while the pager claimed
   * results existed.
   */
  const rows = library.data?.data ?? [];
  const total = library.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function openMeeting(meeting: Meeting) {
    // Same `meeting` param VNextMeetingsWorkspace.tsx's URL contract already
    // owns; landing there with no `tab` defaults to Prep, matching the
    // mockup's own row click (`sel:r.meeting, tab:'prep'`).
    navigate(`/engagement/meetings?meeting=${encodeURIComponent(meeting.id)}`);
  }

  function handleFromDateChange(value: string) {
    setFromDate(value);
    if (value && toDate && value > toDate) setToDate(value);
    setPage(1);
  }

  function handleToDateChange(value: string) {
    setToDate(value);
    if (value && fromDate && value < fromDate) setFromDate(value);
    setPage(1);
  }

  function clearDates() {
    setFromDate('');
    setToDate('');
    setPage(1);
  }

  const clientOptions: DropdownOption[] = [
    { value: '', label: 'All clients' },
    ...(clients.data ?? []).map((client) => ({ value: client.id, label: client.name })),
  ];

  return (
    <div className="uui-library-page">
      <div className="uui-library-breadcrumb" aria-label="Meeting Library breadcrumb">
        <button type="button" onClick={() => navigate('/engagement/meetings')}>
          Meetings
        </button>
        <span>/</span>
        <span>Library</span>
      </div>

      <h2 className="uui-library-heading">Meeting Library</h2>
      {/*
        Scope corrected 2026-08-28. This previously read "Tenant-wide: this shows
        every approved or saved material in the firm, not only your own", on the
        strength of the handoff's claim that the Library is tenant-scoped.
        The code says otherwise: `listMeetingLibrary` applies
        `ownMeetingWhere(ctx.userId)`, which is
        `createdByUserId = me OR connection.createdByUserId = me`. It is
        OWNER-scoped. Claiming firm-wide coverage told users an empty result
        meant "the firm has nothing", when it actually means "you have nothing".
      */}
      <p className="uui-library-subline">
        Your meetings — ones you created, or that came from a calendar you connected —
        with at least one approved prep, note or debrief. Searchable by subject and
        client; filter by client, date, artifact type and visibility.
      </p>

      <div className="uui-library-filters">
        {/*
          A real server-side search now. `MeetingLibraryQueryDto` declares a
          `search` field, and `listMeetingLibrary` AND-s it into the query as an
          OR over meeting subject and client name.
          
          It was briefly labelled "Filter this page" because no server search
          existed and the box only narrowed the loaded page of a paginated list
          — which made a page-local miss look like "nothing matches". That
          caveat is gone: this reaches every page.
        */}
        <div className="uui-search-field">
          <Search size={18} />
          <input
            type="text"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            aria-label="Search your meeting library by subject or client"
            placeholder="Search by meeting or client…"
          />
        </div>
        <LibraryDropdown
          ariaLabel="Filter by client"
          defaultLabel="All clients"
          options={clientOptions}
          selectedValue={clientId ?? ''}
          onSelect={(value) => {
            setClientId(value || undefined);
            setPage(1);
          }}
        />
        <LibraryDropdown
          ariaLabel="Filter by artifact type"
          defaultLabel="All · Prep · Notes · Debrief"
          options={TYPE_OPTIONS}
          selectedValue={type === 'all' ? '' : type}
          onSelect={(value) => {
            setType((value || 'all') as LibraryTypeFilter);
            setPage(1);
          }}
        />
        <LibraryDropdown
          ariaLabel="Filter by visibility"
          defaultLabel="All · Shared · Private"
          options={VISIBILITY_OPTIONS}
          selectedValue={vis === 'all' ? '' : vis}
          onSelect={(value) => {
            setVis((value || 'all') as LibraryVisibilityFilter);
            setPage(1);
          }}
        />
      </div>

      {/* Real, useful controls with no mockup treatment (see file header) —
          an always-visible secondary row rather than folded into the primary
          filter row, so the pixel-precise 4-control row above stays intact. */}
      <div className="uui-library-daterow">
        <label>
          From
          <input
            type="date"
            value={fromDate}
            max={toDate || undefined}
            onChange={(event) => handleFromDateChange(event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={toDate}
            min={fromDate || undefined}
            onChange={(event) => handleToDateChange(event.target.value)}
          />
        </label>
        {(fromDate || toDate) && (
          <button type="button" onClick={clearDates}>
            Clear dates
          </button>
        )}
      </div>

      <div className="uui-library-card">
        <div className="uui-library-table__head">
          <span>Date</span>
          <span>Meeting</span>
          <span>Materials</span>
          <span>Visibility</span>
        </div>
        {library.isLoading ? (
          <div className="uui-library-empty">Loading…</div>
        ) : library.isError ? (
          <div className="uui-library-error">
            <span>The Meeting Library could not be reached.</span>
            <button type="button" onClick={() => void library.refetch()}>
              Retry
            </button>
          </div>
        ) : rows.length === 0 ? (
          /*
           * One message, because there is only one case left. The search now runs
           * server-side across every page, so "no rows" can no longer mean
           * "matches exist but not on the page you are looking at" — the split
           * empty state that distinction required is gone with it.
           *
           * A plain block comment, not the braced JSX form: this sits in a
           * ternary's expression slot, not a JSX children slot, where the braced
           * form is a syntax error.
           */
          <div className="uui-library-empty">
            {q.trim() ? (
              <>
                Nothing in your meeting library matches “{q.trim()}”
                {clientId || type !== 'all' || vis !== 'all' || fromDate || toDate
                  ? ' with the current filters applied'
                  : ''}
                . This searches meetings you own that have an approved prep, note or
                debrief — a colleague’s meeting will not appear here.
              </>
            ) : (
              <>
                No approved or saved materials match these filters. This covers only
                meetings you own, so an empty result means nothing of yours matches —
                not that the firm has nothing.
              </>
            )}
          </div>
        ) : (
          rows.map((meeting) => {
            const shared = meeting.visibility === 'shared';
            return (
              <button
                key={meeting.id}
                type="button"
                className="uui-library-row"
                onClick={() => openMeeting(meeting)}
              >
                <span className="uui-library-date">{formatDateShort(meeting.startsAt)}</span>
                <span className="uui-library-title">
                  <strong>{meeting.subject}</strong>
                  <small>{meeting.client?.name ?? 'No client'}</small>
                </span>
                <span className="uui-library-materials">{libraryMaterialsLabel(meeting)}</span>
                <span className={`eng-pill ${shared ? 'eng-pill--navy' : 'eng-pill--gray'}`}>
                  {shared && <span className="eng-pill__dot" />}
                  {shared ? 'Shared' : 'Private'}
                </span>
              </button>
            );
          })
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="uui-library-pagination">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      )}

      <p className="uui-library-note">
        A colleague&apos;s shared material appears alongside yours; sharing is per artifact and
        never replaces an existing share.
      </p>
    </div>
  );
}
