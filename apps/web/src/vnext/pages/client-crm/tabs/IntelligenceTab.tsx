import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { resolveUsStateCode } from '@capiro/shared';
import { useClientFacilities } from '../../../../pages/clients/use-client-facilities.js';
import {
  Card,
  CardHead,
  Pill,
  SegmentedTabs,
  TabPageHead,
  Tile,
  Avatar,
  GRADIENT_DARK,
  type PillTone,
} from '../portfolio-primitives.js';
import { lazy, Suspense } from 'react';
import { formatDateShort, formatMoney, formatNumber, ldaPeriodLabel, partyLabel, titleCaseName } from '../../../lib/labels.js';
import {
  bandOf,
  type ScoreBand,
} from '../../../../pages/intelligence/district-nexus/district-nexus-format.js';
import {
  getClientDistrictNexusV2,
  type ClientDistrictNexusV2,
  type DistrictNexusDistrictDetail,
} from '../../../../pages/clients/intelligence-v1/district-nexus-api.js';
import { PastPerformanceCard } from '../PastPerformanceCard.js';
import { ManageFacilitiesModal } from '../ManageFacilitiesModal.js';
import { AddBillModal } from './LegislativeAddBill.js';
import { BillUpdatesDrawer } from './BillUpdatesDrawer.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { IntelligenceView } from '../client-crm-routing.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  trackerKeys,
  trackerPaths,
  type BoardBill,
  type BoardResponse,
} from '../../../../pages/clients/tracker/tracker-api.js';
import { adaptBoard, intelTrackerPaths } from '../../../../pages/clients/tracker/intel-tracker-api.js';
import {
  getClientFacilities,
  formatFacilityDistrict,
  type ClientFacility,
} from '../../../../pages/clients/facilities-api.js';
import {
  getClientDistrictNexus,
  type DistrictNexusRow,
} from '../../../../pages/clients/intelligence-v1/district-nexus-api.js';
import { getClientLdaFilings } from '../../../../pages/clients/intelligence-v1/lda-filings-api.js';
import {
  getClientFecMoneyFlow,
  pacGivingAmount,
  pacGivingPeriod,
  pacGivingStatus,
  topPacRecipients,
} from '../../../../pages/clients/intelligence-v1/fec-money-flow-api.js';
import {
  getClientRepresentation,
  type RepresentationResult,
} from '../../../../pages/clients/intelligence-v1/representation-api.js';
import { getClientRegulatoryProfile, regulatoryProfileKey } from '../../../../pages/clients/intelligence-v1/regulatory-profile-api.js';
import { summarizeLdaPeriods } from '../../../../pages/clients/intelligence-v1/lda-periods.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import './intelligence-tab.css';
import { FacilityVerification } from '../FacilityVerification.js';

/**
 * Intelligence tab (spec §10). Three domains, stacked on one page: Legislative
 * & Regulatory · Federal Footprint · District Nexus. Every domain opens with
 * the 5-cell domain stats strip. Funding & Budget (the former fourth domain)
 * moved out into its own top-level client directory, "Opportunities" — see
 * tabs/OpportunitiesTab.tsx — since it read as a distinct workflow (pursuits
 * to go after) rather than a fourth lens on the same client-intelligence
 * surface the other three share.
 *
 * Overview is gone: its pulse band and domain list restated the same figures
 * each domain panel already reads from the same query keys, so a client's
 * numbers were rendered twice and Intelligence now opens on Legislative.
 * Past performance moved in from Capabilities §7.3 and sits under Federal
 * Footprint, with the rest of the client's federal delivery record.
 *
 * Every section distinguishes loading, unavailable and empty sources.
 * Only returned client data is shown.
 */


/** MapLibre choropleth, lazy so the WebGL engine stays out of this chunk (see
 * bundle-boundaries.test.ts) for users who never open the District subtab.
 * Shared with the native District Nexus page since the Phase 2 port — its
 * default props reproduce this tab's original behavior exactly. */
const DistrictNexusMapLibreLazy = lazy(() => import('../../../components/district-map/DistrictNexusMapLibre.js'));


/**
 * District Nexus v2 — the scored, district-keyed model the canonical
 * District Nexus module renders. Deliberately NOT the legacy widget's
 * `['client-district-nexus-v2']` key: this query resolves a 404 to `null`
 * (fall back to v1) while that one throws, and two contracts must not share
 * one cache entry. `null` data = the endpoint is dark for this tenant.
 */
function useDistrictNexusV2(client: Client, active: boolean) {
  const api = useApi();
  const { enabled, ready } = useIntelFeature('district_nexus_v2');
  return useQuery<ClientDistrictNexusV2 | null>({
    queryKey: ['pf-district-nexus-v2', client.id],
    queryFn: async () => {
      try {
        return await getClientDistrictNexusV2(api, client.id);
      } catch (error) {
        const status = (error as { response?: { status?: number } } | null)?.response?.status;
        if (status === 404) return null; // configuration answer, not an outage
        throw error;
      }
    },
    enabled: active && ready && enabled && Boolean(client.id),
    staleTime: 2 * 60_000,
    retry: false,
  });
}

export function ClientCrmIntelligenceProto({ client, view, headless = false }: { client: Client; view: IntelligenceView; /** Rendered inside the Intelligence accordion panel: the accordion header already carries the domain title/stat, so the in-panel TabPageHead drops to an actions-only row. */ headless?: boolean }) {
  const navigate = useNavigate();
  const api = useApi();
  const domain = DOMAIN_META[view] ?? DOMAIN_META.legislative!;
  const [facilitiesOpen, setFacilitiesOpen] = useState(false);
  // Lifted here so the Legislative domain header's "Track bill" button and the
  // LegislativePanel below (which owns the track mutation + AddBill modal) drive
  // the same modal — the button lives in the header, the write in the panel.
  const [addBillOpen, setAddBillOpen] = useState(false);
  // Federal Footprint's header "Export profile" — same defect class as
  // Configure/Manage facilities/Sync sources: a static <SecondaryBtn> in
  // DOMAIN_META with no onClick at all did nothing on click. The real
  // destination is the report-card export route, which used to return the
  // exact same JSON as the plain GET (no file); it now renders a real .docx
  // (report-card-docx.ts, apps/api). Same blob-fetch-then-download pattern
  // already proven in this app for the Artifacts export
  // (useExportArtifactDocx, apps/web/src/pages/actions/artifacts-api.ts).
  const exportProfile = useMutation({
    mutationFn: async () => {
      const res = await api.get<Blob>(`/api/intelligence/clients/${client.id}/report-card/export`, {
        responseType: 'blob',
      });
      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${client.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-report-card.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  });
  // Actions that need the client are computed here rather than in the static
  // map below: District's "Manage facilities" (item 3, wire-audit "2 Wire
  // existing APIs"), Legislative's "Configure" (item 4, "3 Compose extend")
  // and Footprint's "Export profile" — a static <SecondaryBtn> in DOMAIN_META
  // with no onClick at all did nothing on click.
  const actions =
    view === 'district' ? (
      // This used to `navigate('?tab=facilities')`, which client-crm-routing maps
      // straight back to intelligence/district — the very view this button sits
      // on. It therefore did nothing. The editor is now in-place, on the real
      // /api/clients/:id/facilities CRUD.
      <SecondaryBtn onClick={() => setFacilitiesOpen(true)}>Manage facilities</SecondaryBtn>
    ) : view === 'legislative' ? (
      <>
        {/* Q07 (evidence #58/#65): the real source/alert configuration for a
            client's legislative intelligence is the tracker's Configure panel —
            watchlist topics and terms, per-trigger alert toggles, channels. It
            used to navigate to /radar?tab=watchlist, but on os.capiro.ai /radar
            is a query-preserving redirect straight to /legiwatch, and vNext's
            LegiWatch module treats `watchlist` as a REMOVED tab (see
            REMOVED_TABS in legiwatch/lib/types.ts) — it silently redirects to
            Hearings, losing both the intended Bills/watchlist view and the
            client filter. LegiWatch's own Bills tab (?tab=bills) is the real,
            still-live watchlist/tracked-bill destination — see the sibling
            "Open full board" button below, which already targets it — and it
            keeps the client scope via ?client=. There is no second config store
            for this domain to open instead. */}
        <SecondaryBtn onClick={() => navigate(`/legiwatch?tab=bills&client=${encodeURIComponent(client.id)}`)}>
          Configure
        </SecondaryBtn>
        {/* Header "Track bill" opens the bill-search modal — the same
            capability app.capiro.ai has (legacy AddBillModal). The track write
            itself is owned by LegislativePanel's trackMutation; this button just
            opens the shared modal via the lifted `addBillOpen` state. */}
        <PrimaryBtn onClick={() => setAddBillOpen(true)}>Track bill</PrimaryBtn>
      </>
    ) : view === 'footprint' ? (
      <SecondaryBtn onClick={() => exportProfile.mutate()} disabled={exportProfile.isPending}>
        {exportProfile.isPending ? 'Exporting…' : 'Export profile'}
      </SecondaryBtn>
    ) : (
      domain.actions
    );

  // Compute real domain-stats-strip values from the queries each panel
  // already runs. react-query dedupes by key — these are the exact same
  // queries the panels below issue, so no extra network requests.
  const realStats = useDomainStats(client, view, api);

  return (
    <div className="cap-pf-anim-rise capiro-intel capiro-intel-stack-24">
      {headless ? (
        // Accordion panel: the domain header (title + compact stat + chevron)
        // sits in IntelligenceDomainStack; keep the domain's real actions
        // reachable inside the open panel.
        <div className="capiro-intel-actions-row">{actions}</div>
      ) : (
        <TabPageHead title={domain.title} sub={domain.sub} actions={actions} />
      )}
      {view === 'footprint' && exportProfile.isError ? (
        // The Export mutation previously had no visible failure at all — the
        // button just returned from "Exporting…" to "Export profile" with no
        // message, reading as "nothing happened" (the same silent class as a
        // missing onError elsewhere in this module).
        <p role="alert" className="capiro-intel-export-error">
          The report could not be exported.{' '}
          {exportProfile.error instanceof Error && exportProfile.error.message
            ? exportProfile.error.message
            : 'Try again in a moment.'}
        </p>
      ) : null}
      <DomainStatsStrip view={view} realValues={realStats} />
      {view === 'legislative' ? (
        <>
          <LegislativePanel
            client={client}
            addBillOpen={addBillOpen}
            onAddBillOpenChange={setAddBillOpen}
          />
          {/* Regulatory used to be its own segmented-tab view; its content
              (active matters + deadline rail) now renders right below
              Legislative's, under one merged "Legislative & Regulatory"
              domain — the two were always read from the same client-
              intelligence surface. */}
          <RegulatorySectionHead />
          <RegulatoryPanel client={client} />
        </>
      ) : null}
      {view === 'footprint' ? <FootprintPanel client={client} /> : null}
      {view === 'district' ? <DistrictPanel client={client} /> : null}

      <ManageFacilitiesModal
        open={facilitiesOpen}
        clientId={client.id}
        clientName={client.name}
        onClose={() => setFacilitiesOpen(false)}
      />
    </div>
  );
}

/**
 * Resolve real domain-stats-strip cells from live queries, falling back to
 * undefined (which makes DomainStatsStrip render dashes) when a query is not
 * ready or not applicable. Each case reuses the same query key the panel
 * below uses so cache is shared — zero extra network calls.
 */
export function useDomainStats(client: Client, view: IntelligenceView, api: ReturnType<typeof useApi>): Array<[string, string]> | undefined {
  const { enabled: trackerV2, ready: trackerReady } = useIntelFeature('tracker_v2');
  const boardQ = useQuery<BoardResponse>({
    queryKey: trackerKeys.board(client.id),
    queryFn: async () => {
      if (trackerV2) {
        const raw = (await api.get<Parameters<typeof adaptBoard>[0]>(intelTrackerPaths.board(client.id))).data;
        return adaptBoard(raw);
      }
      return (await api.get<BoardResponse>(trackerPaths.board(client.id))).data;
    },
    enabled: trackerReady && view === 'legislative',
    staleTime: 60_000,
  });
  const aggQ = useQuery({
    queryKey: regulatoryProfileKey(client.id),
    queryFn: () => getClientRegulatoryProfile(api, client.id),
    enabled: view === 'legislative',
    staleTime: 2 * 60_000,
    retry: 1,
  });

  const ldaQ = useQuery({
    queryKey: ['client-lda-filings', client.id],
    queryFn: () => getClientLdaFilings(api, client.id),
    enabled: view === 'footprint',
    staleTime: 2 * 60_000,
  });
  const nexusQ = useQuery({
    queryKey: ['client-district-nexus', client.id],
    queryFn: () => getClientDistrictNexus(api, client.id),
    enabled: view === 'footprint' || view === 'district',
    staleTime: 2 * 60_000,
  });
  const fecQ = useQuery({
    queryKey: ['client-fec-money-flow', client.id],
    queryFn: () => getClientFecMoneyFlow(api, client.id),
    enabled: view === 'footprint',
    staleTime: 5 * 60_000,
  });
  const facilitiesQ = useQuery({
    queryKey: ['client-facilities', client.id],
    queryFn: () => getClientFacilities(api, client.id),
    enabled: view === 'district',
    staleTime: 60_000,
  });
  const nexusV2Q = useDistrictNexusV2(client, view === 'district');
  // The v1 fallback below keys on the v2 QUERY's outcome, but when the
  // district_nexus_v2 flag is off the query never runs at all (data stays
  // `undefined` forever) — the strip then rendered dashes even though v1
  // facilities/nexus had real answers. Treat "flag off" as the same
  // fallback signal as "v2 answered 404/dark".
  const { enabled: nexusV2Enabled, ready: nexusV2FlagReady } = useIntelFeature('district_nexus_v2');
  const v2Unavailable =
    nexusV2Q.data === null || nexusV2Q.isError || (nexusV2FlagReady && !nexusV2Enabled);

  // Legislative & Regulatory is one merged view: tracked bills alongside
  // active regulatory matters + upcoming deadlines. Each source renders its
  // own real cells as soon as IT resolves — this used to be two separate
  // 4/5-cell strips (Legislative view, Regulatory view); now it is one
  // 5-cell strip that fills in from whichever query answers first.
  if (view === 'legislative' && ((trackerReady && boardQ.isSuccess) || aggQ.isSuccess)) {
    const trackedBills = trackerReady && boardQ.isSuccess ? String(boardQ.data.total) : '—';
    const rails = aggQ.isSuccess ? aggQ.data?.regulatoryLifecycle?.rails ?? [] : null;
    const activeMatters = rails ? String(rails.length) : '—';
    const deadlineSoon = rails
      ? String(
          rails.filter((r) => {
            if (!r.deadline) return false;
            const on = deadlineDay(r.deadline);
            if (!on) return false;
            const days = Math.ceil((on.getTime() - Date.now()) / 86_400_000);
            return days >= 0 && days < 14;
          }).length,
        )
      : '—';
    return [
      [trackedBills, 'Tracked bills'],
      [activeMatters, 'Active matters'],
      [deadlineSoon, 'Deadline < 14 days'],
      ['—', 'Material changes'],
      ['—', 'Watchlist coverage'],
    ];
  }

  // Federal Footprint reads three INDEPENDENT sources (LDA filings,
  // district-nexus spend, FEC money flow), and each of the five cells below
  // maps to EXACTLY ONE of them — none needs more than one source to answer.
  // Requiring all three to succeed before showing ANY of them (the previous
  // behavior) meant one slow or failed source blanked cells that already had
  // a real, ready answer. Same "fill in from whichever query answers first"
  // rule Legislative & Regulatory already applies above; this domain simply
  // never followed it.
  if (view === 'footprint' && (ldaQ.isSuccess || nexusQ.isSuccess || fecQ.isSuccess)) {
    const lda = ldaQ.isSuccess ? ldaQ.data : null;
    const ldaAmount = lda?.matched && !lda.truncated ? summarizeLdaPeriods(lda.filings).amount : null;
    const pac = fecQ.isSuccess ? fecQ.data.pacGiving : null;
    return [
      [lda ? (lda.matched ? formatNumber(lda.totalFilings) : '0') : '—', 'LDA filings'],
      // Compact labels: the reference stats strip is single-line 10.5px.
      [lda ? formatMoney(ldaAmount) : '—', 'Lobbying · 4 quarters'],
      // Unlinked is "no confirmed mapping", never $0 — formatMoney(null) = '—'.
      [
        nexusQ.isSuccess ? formatMoney(nexusQ.data.linked ? nexusQ.data.totalAmount : null) : '—',
        'Federal contracts',
      ],
      [
        fecQ.isSuccess ? formatMoney(pac ? pacGivingAmount(pac) : null) : '—',
        pac && pac.tracked && pacGivingStatus(pac) !== 'complete'
          ? 'PAC contributions · incomplete'
          : 'PAC contributions',
      ],
      [lda ? (lda.matched ? formatNumber(lda.registrants.length) : '0') : '—', 'Registrants'],
    ];
  }

  // District — prefer the scored v2 model (real districtKeys, real coverage);
  // fall back to the v1 facility view when v2 is dark for this tenant.
  if (view === 'district' && nexusV2Q.data) {
    const v2 = nexusV2Q.data;
    return [
      [formatNumber(v2.districts.length), 'Districts'],
      [formatMoney(v2.awarded.contractObligations), 'Contract obligations'],
      [formatMoney(v2.awarded.grantObligations), 'Grant obligations'],
      // employeeCount null = no facility reported a headcount. NEVER render 0.
      [v2.facilityFootprint.employeeCount != null ? formatNumber(v2.facilityFootprint.employeeCount) : '—', 'Employees mapped'],
      [`${Math.round(v2.coveragePercent)}%`, 'Coverage'],
    ];
  }
  if (
    view === 'district' &&
    facilitiesQ.isSuccess &&
    nexusQ.isSuccess &&
    v2Unavailable
  ) {
    const linkedNexus = nexusQ.data.linked ? nexusQ.data.districts.length : 0;
    const totalAmount = nexusQ.data.linked
      ? nexusQ.data.districts.reduce((s, d) => s + d.totalAmount, 0)
      : null;
    const knownEmployees = facilitiesQ.data.filter((f) => f.employeeCount != null);
    const empCount = knownEmployees.reduce((s, f) => s + (f.employeeCount ?? 0), 0);
    return [
      [String(linkedNexus), 'Districts'],
      [formatMoney(totalAmount), 'Contract obligations'],
      ['—', 'Grant obligations'],
      [knownEmployees.length ? formatNumber(empCount) : '—', 'Employees mapped'],
      ['—', 'Coverage'],
    ];
  }

  return undefined; // still loading — the strip renders dashes, never a fixture
}

const DOMAIN_META: Record<string, { title: string; sub: string; actions?: ReactNode }> = {
  legislative: {
    title: 'Legislative & Regulatory',
    sub: 'Tracked bills, hearings, and material changes from LegiWatch, plus Federal Register matters shown as decision-oriented lifecycle rails with client deadlines.',
    // actions computed in ClientCrmIntelligenceProto — see the comment there.
  },
  footprint: {
    title: 'Federal footprint',
    sub: 'Lobbying activity, federal contracts, political giving, past performance, and the government entities connected to the client.',
    // actions computed in ClientCrmIntelligenceProto — see the comment there.
  },
  district: {
    title: 'District Nexus',
    sub: 'Facilities, employees, contracts, grants, and representatives translated into a defensible congressional footprint.',
    // actions computed in ClientCrmIntelligenceProto — see the comment there.
  },
};

/* ── shared buttons ───────────────────────────────────────────────────────── */

export function SecondaryBtn({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="capiro-intel-btn-secondary">
      {children}
    </button>
  );
}
function PrimaryBtn({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  // GRADIENT_DARK is imported from portfolio-primitives.js (not owned by this
  // file); it lands as a CSS custom property rather than a straight `background`
  // inline style so the class's own `:hover` rule (a different gradient) can
  // still win — an inline `background` would block `:hover` from ever applying.
  return (
    <button
      type="button"
      onClick={onClick}
      className="capiro-intel-btn-primary"
      style={{ '--capiro-intel-btn-bg': GRADIENT_DARK } as CSSProperties}
    >
      {children}
    </button>
  );
}
export function LinkBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} {...(title ? { title } : {})}
      className="capiro-intel-btn-link">
      {children}
    </button>
  );
}

/**
 * Honest replacement for a design fixture on a CONFIRMED query error — never
 * used for the loading state, only `<query>.isError`. Every fixture fallback
 * in this file that used to render on "not yet successful" (which conflates
 * loading with error) now checks this explicitly instead; see the module
 * doc-comment at the top of this file.
 */
function LoadingSource({ what }: { what: string }) {
  return <p className="capiro-intel-note" role="status" aria-busy="true">Loading {what}…</p>;
}

export function CouldNotLoad({ what, error, onRetry }: { what: string; error?: unknown; onRetry?: () => void }) {
  const detail = error instanceof Error && error.message ? error.message : `The service did not answer.`;
  return (
    <div className="capiro-intel-error">
      <p className="capiro-intel-error-text">{what} could not be loaded. {detail}</p>
      {onRetry ? <SecondaryBtn onClick={onRetry}>Retry</SecondaryBtn> : null}
    </div>
  );
}

/* ── Domain stats strip (§10 — all domains except Overview) ──────────────── */

/**
 * The strip renders five summary cells per domain. Until the real queries
 * answer, the value slots hold muted dashes under the domain's real labels —
 * the design fixture's invented figures ("8 districts · 92% coverage") never
 * stand in for a client's numbers.
 */
export function DomainStatsStrip({ view, realValues }: { view: string; realValues?: Array<[string, string]> }) {
  const labels: Record<string, string[]> = {
    legislative: ['Tracked bills', 'Active matters', 'Deadline < 14 days', 'Material changes', 'Watchlist coverage'],
    footprint: ['LDA filings', 'Lobbying · 4 quarters', 'Federal contracts', 'PAC contributions', 'Registrants'],
    district: ['Districts', 'Contract obligations', 'Grant obligations', 'Employees mapped', 'Coverage'],
  };
  const labelSource = (labels[view] ?? []).map((label): [string, string] => ['—', label]);
  const cells: Array<[string, string]> =
    realValues && realValues.length > 0 ? realValues : labelSource.map(([, label]) => ['—', label]);
  const loading = !realValues || realValues.length === 0;
  return (
    <section className="capiro-intel-stats" data-source={loading ? 'loading' : 'live'} aria-busy={loading}>
      {cells.map(([value, label]) => (
        <span key={label} className="capiro-intel-stats-cell">
          <span className={loading ? 'capiro-intel-stats-value capiro-intel-stats-value--loading' : 'capiro-intel-stats-value'}>{value}</span>
          <span className="capiro-intel-stats-label">{label}</span>
        </span>
      ))}
    </section>
  );
}

/* ═══════════════════════════ §10.2 Legislative ═════════════════════════════ */

function LegislativePanel({
  client,
  addBillOpen,
  onAddBillOpenChange,
}: {
  client: Client;
  addBillOpen: boolean;
  onAddBillOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Reference opens the tracked-bill list as the TABLE; the board columns
  // remain one toggle away ("Board view" in the card header).
  const [boardView, setBoardView] = useState(false);
  // The tracked bill the "latest updates" drawer is showing, or null.
  const [openBill, setOpenBill] = useState<BoardBill | null>(null);

  // Same tracker_v2 feature-detection dance as the currently-live TrackerTab.tsx
  // (the source this mirrors).
  const { enabled: trackerV2, ready } = useIntelFeature('tracker_v2');

  // The tracked-bill board. The server already groups by stage and its
  // four stage ids match the design's own STAGES exactly, so columns are used
  // as returned rather than re-derived client-side.
  const boardQ = useQuery<BoardResponse>({
    queryKey: trackerKeys.board(client.id),
    queryFn: async () => {
      if (trackerV2) {
        // `IntelBoard` isn't exported; take its shape from the adapter itself.
        const raw = (
          await api.get<Parameters<typeof adaptBoard>[0]>(intelTrackerPaths.board(client.id))
        ).data;
        return adaptBoard(raw);
      }
      return (await api.get<BoardResponse>(trackerPaths.board(client.id))).data;
    },
    enabled: ready,
    staleTime: 60_000,
  });
  const realBoard = ready && boardQ.isSuccess ? boardQ.data : null;
  // Distinct from "not yet successful": a confirmed error must never fall
  // back to the BILLS/STAGES design fixture — see CouldNotLoad.
  const boardFailed = ready && boardQ.isError;

  // Bill ids already on the board — the AddBill modal shows these as "On board".
  const boardBillIds = useMemo(
    () => new Set((realBoard?.columns ?? []).flatMap((c) => c.bills.map((b) => b.billId))),
    [realBoard],
  );

  /**
   * Track bill (header "Track bill" → AddBill modal). This is the SAME manual
   * track path the live app.capiro.ai uses (TrackerTab's `trackManual`):
   * `source: 'manual_search'` on the same track endpoint, invalidating the
   * board/summary cache so the new bill appears in its stage column at once.
   * Returns the promise so the modal row only flips to "On board" once the
   * write actually succeeds (legacy P2-06).
   */
  const trackMutation = useMutation({
    mutationFn: (billId: string) =>
      api.post(trackerV2 ? intelTrackerPaths.track(client.id) : trackerPaths.track(client.id), {
        billId,
        source: 'manual_search',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackerKeys.summary(client.id) });
      qc.invalidateQueries({ queryKey: trackerKeys.board(client.id) });
    },
  });

  return (
    <div className="capiro-intel-stack-24">
      {/* Recommendations was removed (user request): the Legislative surface is
          now a single full-width tracked-bill board. */}
      <Card>
        <CardHead
          title="Tracked bills"
          action={
            <LinkBtn onClick={() => setBoardView((v) => !v)}>
              {boardView ? 'Table view' : 'Board view'}
            </LinkBtn>
          }
        />
        {realBoard ? (
          realBoard.total === 0 ? (
            <p className="capiro-intel-note">
              No bills are on this client&apos;s board yet. Use{' '}
              <button
                type="button"
                onClick={() => onAddBillOpenChange(true)}
                className="capiro-intel-note-link"
              >
                Track bill
              </button>{' '}
              to add one.
            </p>
          ) : boardView ? (
            <RealBillBoard board={realBoard} onOpenBill={setOpenBill} />
          ) : (
            <RealBillTable board={realBoard} onOpenBill={setOpenBill} />
          )
        ) : boardFailed ? (
          <CouldNotLoad what="The tracked-bill board" error={boardQ.error} onRetry={() => void boardQ.refetch()} />
        ) : (
          // Loading: render an honest skeleton, never the BILLS/STAGES design
          // fixture. A fixture here reads as a fabricated board that "changes"
          // once the real data lands (§14 / §11 — a missing value is never a
          // stand-in record). Mirrors DomainStatsStrip's dash-while-loading.
          <div className="capiro-intel-board" aria-busy="true" aria-label="Loading tracked bills">
            <div className="capiro-intel-board-grid">
              {[0, 1, 2, 3].map((col) => (
                <span key={col} className="capiro-intel-board-col">
                  <span className="capiro-crm__skeleton" style={{ display: 'block', height: 18, width: '60%', marginBottom: 12 }} />
                  <span className="capiro-crm__skeleton" style={{ display: 'block', height: 72, marginBottom: 8 }} />
                  <span className="capiro-crm__skeleton" style={{ display: 'block', height: 72 }} />
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="capiro-intel-card-foot">
          {/* `withheld` must be stated when > 0 — a bounded board that stays
              silent about it is less honest than an unbounded one. On a
              confirmed error or while loading there is no real count to state. */}
          {realBoard ? (
            <span className="capiro-intel-eyebrow">
              {realBoard.withheld
                ? `${realBoard.withheld} more tracked bill${realBoard.withheld === 1 ? '' : 's'} not shown`
                : `${realBoard.total} tracked bill${realBoard.total === 1 ? '' : 's'}`}
            </span>
          ) : null}
          <span className="capiro-intel-spacer" />
          <LinkBtn onClick={() => navigate(`/legiwatch?tab=bills&client=${encodeURIComponent(client.id)}`)}>Open full board →</LinkBtn>
        </div>
        {/* The "Upcoming hearing" footer that used to live here (relocated from
            the removed Recommendations card) always read a single hardcoded
            hearing regardless of client or query state — no hearings endpoint
            is read anywhere in this file. Removed rather than left permanently
            fake; a real hearings feed would restore it as a wired card. */}
      </Card>

      <AddBillModal
        open={addBillOpen}
        clientId={client.id}
        boardBillIds={boardBillIds}
        onTrack={(billId) => trackMutation.mutateAsync(billId)}
        onClose={() => onAddBillOpenChange(false)}
      />
      <BillUpdatesDrawer
        open={Boolean(openBill)}
        clientId={client.id}
        bill={openBill}
        onClose={() => setOpenBill(null)}
      />
    </div>
  );
}

/**
 * `BoardBill.probability` is PASSAGE probability (0..1, occasionally already
 * 0-100 — `probClass` in tracker-api.ts tolerates both, so this does too).
 * It is NOT the fixture's client-"fit" score, so it is never rendered in the
 * bare `FitChip` the fixture uses — the label always says what the number is.
 */
function passagePct(probability: number): number {
  return Math.round(probability > 1 ? probability : probability * 100);
}

const CHANGE_TONE: Record<string, PillTone> = {
  critical: 'error',
  notable: 'warning',
  info: 'blue',
  success: 'success',
};

function RealBillBoard({ board, onOpenBill }: { board: BoardResponse; onOpenBill: (b: BoardBill) => void }) {
  return (
    <div className="capiro-intel-board">
      <div className="capiro-intel-board-grid">
        {board.columns.map((col) => (
          <span key={col.id} className="capiro-intel-board-col">
            <span className="capiro-intel-board-col-head">
              <span className="capiro-intel-board-col-title">{col.label}</span>
              <span className="capiro-intel-count-badge" style={{ background: GRADIENT_DARK }}>{col.count}</span>
            </span>
            {col.bills.map((b) => (
              <RealBillCard key={b.billId} b={b} onOpen={() => onOpenBill(b)} />
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

function RealBillCard({ b, onOpen }: { b: BoardBill; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View latest updates for ${b.displayNum}`}
      className="capiro-intel-bill-card"
    >
      <span className="capiro-intel-bill-card-top">
        {b.unread ? <span aria-label="Unread" className="capiro-intel-unread-dot" /> : null}
        <span className="capiro-intel-bill-num">{b.displayNum}</span>
        <Pill tone="gray" dotless>{passagePct(b.probability)}% pass</Pill>
      </span>
      <span className="capiro-intel-bill-title">{b.title}</span>
      {/* The real status label, when the board carries one — the coarse stage
          lane the card sits in is already shown by its column header. */}
      {b.canonicalStatus ? (
        <span className="capiro-intel-bill-meta">{b.canonicalStatus}</span>
      ) : null}
      {b.latestActionText ? (
        <span className="capiro-intel-bill-meta">{b.latestActionText}</span>
      ) : null}
      {b.change ? (
        <span className="capiro-intel-align-start">
          <Pill tone={CHANGE_TONE[b.change.tone] ?? 'gray'} dotless={!b.change.dot}>{b.change.label}</Pill>
        </span>
      ) : null}
      {b.terminalRisk ? (
        <span className="capiro-intel-align-start">
          <Pill tone="error">Terminal risk</Pill>
        </span>
      ) : null}
    </button>
  );
}

function RealBillTable({ board, onOpenBill }: { board: BoardResponse; onOpenBill: (b: BoardBill) => void }) {
  const rows = board.columns.flatMap((col) => col.bills.map((b) => ({ bill: b, stageLabel: col.label })));
  return (
    <div>
      {/* Reference table head: BILL / TITLE / LATEST ACTION / PASS, with the
          existing board-stage chip retained as a fifth column. */}
      <div className="capiro-intel-table-head" aria-hidden>
        <span className="capiro-intel-table-num">Bill</span>
        <span className="capiro-intel-table-main">Title</span>
        <span className="capiro-intel-table-action">Latest action</span>
        <span className="capiro-intel-table-stage">Stage</span>
        <span className="capiro-intel-table-end-76">Pass</span>
      </div>
      {rows.map(({ bill: r, stageLabel }) => (
        <button
          key={r.billId}
          type="button"
          onClick={() => onOpenBill(r)}
          aria-label={`View latest updates for ${r.displayNum}`}
          className="capiro-intel-table-row"
        >
          <span className="capiro-intel-table-num">{r.displayNum}</span>
          <span className="capiro-intel-table-main">
            <span className="capiro-intel-table-title">{r.title}</span>
          </span>
          <span className="capiro-intel-table-action">
            {r.latestActionText ?? r.canonicalStatus ?? 'No action recorded'}
          </span>
          <span className="capiro-intel-table-stage">{stageLabel}</span>
          <span className="capiro-intel-table-end-76">
            <Pill tone="gray" dotless>{passagePct(r.probability)}% pass</Pill>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ═══════════════════════════ §10.3 Regulatory ══════════════════════════════ */

/**
 * A comment deadline is a calendar DAY, but the API serializes it as an
 * instant (midnight UTC). Reading that back with local getters moves it to the
 * previous day for every viewer west of UTC — the rail would show a deadline a
 * day early and the .ics would put the event on the wrong date. So the UTC
 * calendar day is re-anchored to local midnight once, here, and everything
 * downstream (label, urgency band, DTSTART) reads that one value.
 */
function deadlineDay(value: string | Date): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
}

/** A deadline derived from a loaded regulatory source. */
interface DeadlineView {
  key: string;
  date: string;
  title: string;
  ask: string;
  urgent: boolean;
  /** Present only on real rows; what the .ics is built from. */
  on?: Date;
  documentNumber?: string;
}

/** A regulatory matter derived from a loaded regulatory source. */
interface MatterView {
  key: string;
  title: string;
  agency: string;
  docket: string;
  stage: string;
  tone: PillTone;
  /** null on real data with no dated deadline — the row omits the line rather than inventing one. */
  detail: string | null;
  /** null on real data with no linked bills — the row omits "Linked …" rather than rendering it empty. */
  linked: string | null;
  /** null when the rail's currentStage can't be confidently matched into its own stages list — the
   * rail then renders as a plain stage pill with no fabricated progress state. */
  steps: Array<[string, string]> | null;
  /** Sort key only (mirrors DeadlineView's own `on`) — never rendered directly; null on fixture rows and on real rows with no dated deadline. */
  on: Date | null;
  /** The real Federal Register document link. Null on fixture rows (nothing
   * real to link to) and never fabricated on real rows — "Open matter" only
   * renders when this is present. */
  htmlUrl: string | null;
}

/**
 * Divider between the Legislative content above and Regulatory below —
 * both now render on the same "Legislative & Regulatory" domain view. Not a
 * Card of its own; just a labeled section break, the same idiom
 * `ClientProfileCard`'s `SectionHead` uses on the Overview tab.
 */
function RegulatorySectionHead() {
  return (
    <div className="capiro-intel-section-head">
      <h3 className="capiro-intel-title-sm">Regulatory</h3>
      <span className="capiro-intel-section-rule" />
    </div>
  );
}

function RegulatoryPanel({ client }: { client: Client }) {
  const api = useApi();

  const aggregate = useQuery({
    queryKey: regulatoryProfileKey(client.id),
    queryFn: () => getClientRegulatoryProfile(api, client.id),
    staleTime: 2 * 60_000,
    retry: 1,
  });
  const lifecycle = aggregate.data?.regulatoryLifecycle;
  const aggFailed = aggregate.isError;
  const loaded = aggregate.data !== undefined;

  const realDeadlines: DeadlineView[] = useMemo(() => {
    const rails = lifecycle?.rails ?? [];
    return rails
      .flatMap((rail) => {
        if (!rail.deadline) return [];
        const on = deadlineDay(rail.deadline);
        if (!on) return [];
        const days = Math.ceil((on.getTime() - Date.now()) / 86_400_000);
        return [
          {
            key: rail.documentNumber,
            date: on
              .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              .toUpperCase(),
            title: rail.title,
            // Same "≤ 3 days is critical" band the canonical
            // LegislativeRegulatorySection applies to these very rails.
            urgent: days <= 3,
            ask: [rail.agencyNames.join(' · '), rail.currentStage].filter(Boolean).join(' · '),
            on,
            documentNumber: rail.documentNumber,
          },
        ];
      })
      .sort((a, b) => a.on.getTime() - b.on.getTime());
  }, [lifecycle]);

  const realMatters: MatterView[] = useMemo(() => {
    const rails = lifecycle?.rails ?? [];
    return rails
      .map((rail) => {
        const on = rail.deadline ? deadlineDay(rail.deadline) : null;
        const days = on ? Math.ceil((on.getTime() - Date.now()) / 86_400_000) : null;
        // Same urgency band the deadline rail uses — a matter with a deadline
        // inside 3 days is 'warning', any other dated matter is 'blue', an
        // undated one (final/enacted, or simply no comment window) is 'gray'.
        const tone: PillTone = days != null && days <= 3 ? 'warning' : on ? 'blue' : 'gray';
        // `currentStage` is a display string; only render progress through the
        // 4-step rail when it can be matched (by key, then by label) into the
        // rail's own `stages` list — otherwise the stage pill alone is shown,
        // never a guessed-at progress state.
        const stageIdx = rail.stages.findIndex((s) => s.key === rail.currentStage);
        const matchedIdx = stageIdx >= 0 ? stageIdx : rail.stages.findIndex((s) => s.label === rail.currentStage);
        const steps: Array<[string, string]> | null =
          matchedIdx >= 0
            ? rail.stages.map((s, i): [string, string] => [s.label, i < matchedIdx ? 'done' : i === matchedIdx ? 'now' : 'pending'])
            : null;
        return {
          key: rail.documentNumber,
          title: rail.title,
          agency: rail.agencyNames.join(' · '),
          docket: rail.documentNumber,
          stage: rail.currentStage,
          tone,
          detail: on ? `Comment deadline ${on.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : null,
          linked: rail.linkedBills.length ? rail.linkedBills.join(' · ') : null,
          steps,
          on,
          htmlUrl: rail.htmlUrl ?? null,
        };
      })
      .sort((a, b) => (a.on?.getTime() ?? Infinity) - (b.on?.getTime() ?? Infinity));
  }, [lifecycle]);

  const deadlines = realDeadlines;
  const matters = realMatters;
  return (
    <div className="cap-pf-grid-intel">
      {aggregate.data?.partial ? (
        <div role="alert" className="capiro-intel-note" style={{ gridColumn: '1 / -1' }}>
          Regulatory coverage is incomplete. Unavailable: {aggregate.data.sources.filter((source) => source.status === 'unavailable').map((source) => source.name).join(', ')}.
          <SecondaryBtn onClick={() => void aggregate.refetch()}>Retry regulatory sources</SecondaryBtn>
        </div>
      ) : null}
      {/* Active matters */}
      <Card>
        {/* "View all" was removed: there is no "all regulatory matters for
            this client" destination anywhere in the routed app to send it to
            (unlike Funding's "View all N", which navigates to a real route).
            A control that promises a page that doesn't exist is worse than no
            control, per this file's own convention (see the removed Pursuit
            pipeline pills and hardcoded hearing footer above). */}
        <CardHead title="Active matters" />
        {aggFailed ? (
          <CouldNotLoad what="Active regulatory matters" error={aggregate.error} onRetry={() => void aggregate.refetch()} />
        ) : !loaded ? (
          <LoadingSource what="regulatory matters" />
        ) : matters.length === 0 ? (
          <p className="capiro-intel-note">{aggregate.data?.partial ? 'No matters returned by the available regulatory sources.' : 'No active regulatory matters on record for this client right now.'}</p>
        ) : (
          <div className="capiro-intel-panel-body-16" data-testid="capiro-intel-active-matters">
            {matters.map((m) => (
              <MatterCard key={m.key} m={m} />
            ))}
          </div>
        )}
      </Card>

      {/* Deadline rail */}
      <Card>
        <CardHead
          title="Deadline rail"
          action={
            <LinkBtn
              disabled={aggFailed || !loaded || realDeadlines.length === 0}
              title={
                realDeadlines.length === 0
                  ? aggFailed
                    ? 'Deadline data could not be loaded'
                    : 'No dated comment deadlines to export for this client'
                  : undefined
              }
              onClick={() => downloadDeadlineIcs(client.name, realDeadlines)}
            >
              Calendar
            </LinkBtn>
          }
        />
        {aggFailed ? (
          <CouldNotLoad what="The deadline rail" error={aggregate.error} onRetry={() => void aggregate.refetch()} />
        ) : !loaded ? (
          <LoadingSource what="regulatory deadlines" />
        ) : (
          <div className="capiro-intel-panel-body-16" data-testid="capiro-intel-deadline-rail">
            {deadlines.length === 0 ? (
              <p className="capiro-intel-note capiro-intel-note-inset">
                {aggregate.data?.partial ? 'No deadlines returned by the available regulatory sources.' : 'No open comment deadlines for this client right now.'}
              </p>
            ) : null}
            {deadlines.map((d) => (
              <span key={d.key} className={d.urgent ? 'capiro-intel-deadline capiro-intel-deadline--urgent' : 'capiro-intel-deadline'}>
                <span className="capiro-intel-deadline-main">
                  <span className={d.urgent ? 'capiro-intel-deadline-date capiro-intel-deadline-date--urgent' : 'capiro-intel-deadline-date'}>{d.date}</span>
                  <span className="capiro-intel-deadline-title">{d.title}</span>
                  <span className="capiro-intel-deadline-ask">{d.ask}</span>
                </span>
              </span>
            ))}
            <div className="capiro-intel-source-evidence">
              <div className="capiro-intel-eyebrow">Source &amp; evidence</div>
              <p className="capiro-intel-body" style={{ marginTop: 8 }}>
                Federal Register records loaded {aggregate.data?.generatedAt ? new Date(aggregate.data.generatedAt).toLocaleString() : 'for this view'}. Source publication and deadline dates are shown on each linked record.
              </p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ── Calendar export (§10.3 Deadline rail) ────────────────────────────────── */

/** RFC 5545 escaping for TEXT values. Backslash first, or it double-escapes. */
function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** `YYYYMMDD` in local time — a comment deadline is a calendar day, not an instant. */
function icsDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Export the real comment deadlines as an all-day .ics. Never called with
 * fixture rows — the button is disabled unless real dated rails exist.
 */
function downloadDeadlineIcs(clientName: string, deadlines: DeadlineView[]) {
  if (deadlines.length === 0) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Capiro//Client regulatory deadlines//EN',
    'CALSCALE:GREGORIAN',
    ...deadlines.flatMap((d) => {
      // DTEND is exclusive for all-day events, so it is the day after.
      const end = new Date(d.on!.getTime() + 86_400_000);
      return [
        'BEGIN:VEVENT',
        `UID:capiro-reg-${icsText(d.documentNumber ?? d.key)}@capiro.ai`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(d.on!)}`,
        `DTEND;VALUE=DATE:${icsDate(end)}`,
        `SUMMARY:${icsText(`Comment deadline · ${d.title}`)}`,
        `DESCRIPTION:${icsText([clientName, d.ask, d.documentNumber].filter(Boolean).join(' · '))}`,
        'END:VEVENT',
      ];
    }),
    'END:VCALENDAR',
  ];
  const url = URL.createObjectURL(
    new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${clientName.replace(/[^\w-]+/g, '-').toLowerCase()}-regulatory-deadlines.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function MatterCard({ m }: { m: MatterView }) {
  return (
    <div className="capiro-intel-matter">
      <div className="capiro-intel-matter-top">
        <span style={{ flex: 1, minWidth: 180 }}>
          <span className="capiro-intel-matter-title">{m.title}</span>
          <span className="capiro-intel-matter-meta">
            <span className="capiro-intel-matter-agency">{m.agency}</span>
            <span className="capiro-intel-matter-docket">{m.docket}</span>
          </span>
        </span>
        <Pill tone={m.tone} size="lg">{m.stage}</Pill>
      </div>
      {m.steps ? <MatterRail steps={m.steps} /> : null}
      <div className="capiro-intel-matter-foot">
        {m.detail ? <span className="capiro-intel-matter-detail">{m.detail}</span> : <span className="capiro-intel-spacer" />}
        {m.linked ? <span className="capiro-intel-matter-linked">Linked {m.linked}</span> : null}
        {/* Real Federal Register link, same pattern as the legacy
            RegulationsPanel.tsx (Data Explorer's Regulations tab) — never a
            button with no destination. Fixture rows and real rows with no
            known URL render nothing here rather than a dead control. */}
        {m.htmlUrl ? (
          <a href={m.htmlUrl} target="_blank" rel="noreferrer" className="capiro-intel-btn-link">
            Open matter →
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** Four-step regulatory lifecycle rail (§2.14 at 24px nodes). */
function MatterRail({ steps }: { steps: Array<[string, string]> }) {
  return (
    <div className="capiro-intel-rail">
      <span className="capiro-intel-rail-line" />
      <span className="capiro-intel-rail-steps">
        {steps.map(([label, st]) => {
          const done = st === 'done';
          const now = st === 'now';
          const nodeClass = done
            ? 'capiro-intel-rail-node capiro-intel-rail-node--done'
            : now
              ? 'capiro-intel-rail-node capiro-intel-rail-node--now'
              : 'capiro-intel-rail-node';
          return (
            <span key={label} className="capiro-intel-rail-step">
              <span className={nodeClass} style={done ? { background: GRADIENT_DARK } : undefined}>{done ? '✓' : now ? '!' : '·'}</span>
              <span className={done || now ? 'capiro-intel-rail-label capiro-intel-rail-label--active' : 'capiro-intel-rail-label'}>
                {label}
              </span>
            </span>
          );
        })}
      </span>
    </div>
  );
}

/* ══════════════════════════ §10.5 Federal Footprint ════════════════════════ */

function FootprintPanel({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();

  const ldaQ = useQuery({
    queryKey: ['client-lda-filings', client.id],
    queryFn: () => getClientLdaFilings(api, client.id),
    staleTime: 2 * 60_000,
  });
  const realLda = ldaQ.isSuccess ? ldaQ.data : null;
  const ldaFailed = ldaQ.isError;
  const ldaPeriods = useMemo(() => realLda ? summarizeLdaPeriods(realLda.filings) : null, [realLda]);
  const ldaAmount = realLda?.truncated ? null : ldaPeriods?.amount;
  const ldaYoy = realLda?.truncated ? null : ldaPeriods?.yoy;
  const filingsRef = useRef<HTMLDivElement>(null);

  // Same real district-nexus query DistrictPanel already fetches under this
  // exact key — react-query dedupes rather than double-fetching.
  const nexusQ = useQuery({
    queryKey: ['client-district-nexus', client.id],
    queryFn: () => getClientDistrictNexus(api, client.id),
    staleTime: 2 * 60_000,
  });
  const realNexus = nexusQ.isSuccess && nexusQ.data.linked ? nexusQ.data : null;
  const nexusFailed = nexusQ.isError;

  // Item 20: the client's own PAC disbursements (Schedule B).
  const fecQ = useQuery({
    queryKey: ['client-fec-money-flow', client.id],
    queryFn: () => getClientFecMoneyFlow(api, client.id),
    staleTime: 5 * 60_000,
  });
  const realPac = fecQ.isSuccess ? (fecQ.data.pacGiving ?? null) : null;
  const fecFailed = fecQ.isError;
  const pacStatus = realPac ? pacGivingStatus(realPac) : null;
  const pacAmount = realPac ? pacGivingAmount(realPac) : null;


  return (
    <div className="capiro-intel-stack-24">
      <div className="cap-pf-grid-3">
        {/* Lobbying activity */}
        <FootCard title="Lobbying activity" action={<LinkBtn onClick={() => { filingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); filingsRef.current?.focus({ preventScroll: true }); }}>Jump to filings</LinkBtn>}>
          {ldaFailed ? (
            <CouldNotLoad what="Lobbying activity" error={ldaQ.error} onRetry={() => void ldaQ.refetch()} />
          ) : realLda ? (
            realLda.matched && realLda.totalFilings > 0 ? (
              <>
                <div className="capiro-intel-headline">
                  <span className="capiro-intel-value-xl">
                    {ldaAmount != null ? `$${ldaAmount.toLocaleString()}` : '—'}
                  </span>
                  {ldaYoy != null ? (
                    <Pill tone={ldaYoy >= 0 ? 'success' : 'error'}>{ldaYoy >= 0 ? '▲' : '▼'} {Math.abs(ldaYoy)}% · {ldaPeriods?.comparisonLabel}</Pill>
                  ) : null}
                </div>
                <div className="capiro-intel-eyebrow capiro-intel-headline-caption">
                  Reported amounts · {ldaPeriods?.windowLabel}
                  <br />Latest filing per registrant, client and quarter; superseded amendments excluded.
                  {ldaPeriods?.needsReview || realLda.truncated ? ' Period totals unavailable: incomplete or ambiguous filing data.' : ''}
                </div>
              </>
            ) : (
              <p className="capiro-intel-note" style={{ padding: 0, marginTop: 16 }}>
                No LDA filings are on record for this client. Absent filings are not the same as no federal
                lobbying activity.
              </p>
            )
          ) : (
            <LoadingSource what="lobbying activity" />
          )}
        </FootCard>

        {/* Federal contracts in the imported award source. */}
        <FootCard
          title="Federal contracts"
          action={<LinkBtn onClick={() => navigate(`/intelligence/federal-spending?tab=contracts&clientId=${client.id}`)}>View contracts</LinkBtn>}
        >
          {nexusFailed ? (
            <CouldNotLoad what="Federal contracts" error={nexusQ.error} onRetry={() => void nexusQ.refetch()} />
          ) : realNexus ? (
            <>
              <div className="capiro-intel-headline">
                <span className="capiro-intel-value-xl">
                  ${realNexus.totalAmount.toLocaleString()}
                </span>
                <Pill tone="gray" dotless>{realNexus.totalAwards} award{realNexus.totalAwards === 1 ? '' : 's'}</Pill>
              </div>
              <div className="capiro-intel-eyebrow capiro-intel-headline-caption">
                Matched contractor identity · {realNexus.districtCount} district{realNexus.districtCount === 1 ? '' : 's'}
                <br />Imported Department of Defense contracts; source history may be incomplete.
              </div>
              {realNexus.totalAwards === 0 ? (
                <p className="capiro-intel-note" style={{ padding: 0 }}>
                  No matching contracts are in the imported records. This does not establish that the client has no federal contracts.
                </p>
              ) : null}
              {/* No real per-agency breakdown source exists yet — dropped rather than fabricated (was Army/Navy/DARPA %). */}
            </>
          ) : nexusQ.isSuccess ? (
            <p className="capiro-intel-note" style={{ padding: 0, marginTop: 16 }}>
              No confirmed contractor mapping exists for this client, so federal contract totals cannot be attributed yet.
            </p>
          ) : (
            <LoadingSource what="federal contracts" />
          )}
        </FootCard>

        {/* Political giving — the client's OWN PAC disbursements (item 20). */}
        <FootCard title="Political giving" action={realPac?.tracked ? (
          <span>{realPac.committees.map((committee) => (
            <a key={committee.committeeId} href={`https://www.fec.gov/data/committee/${encodeURIComponent(committee.committeeId)}/`} target="_blank" rel="noreferrer" className="capiro-intel-btn-link">
              Open {committee.committeeName || committee.committeeId} on FEC
            </a>
          ))}</span>
        ) : undefined}>
          {fecFailed ? (
            <CouldNotLoad what="Political giving" error={fecQ.error} onRetry={() => void fecQ.refetch()} />
          ) : realPac ? (
            !realPac.tracked ? (
              /* "No committee mapped" is not "$0 given" — never render it as one. */
              <p className="capiro-intel-note" style={{ padding: 0, marginTop: 16 }}>
                No FEC committee is mapped to this client, so its PAC giving cannot be reported.
                <br /><LinkBtn onClick={() => navigate(`/settings/intelligence-mappings?clientId=${client.id}&source=fec_committee`)}>Map a PAC committee</LinkBtn>
              </p>
            ) : (
              <>
                <div className="capiro-intel-headline-solo">
                  {pacAmount != null ? `$${pacAmount.toLocaleString()}` : '—'}
                </div>
                <div className="capiro-intel-eyebrow capiro-intel-headline-caption">
                  PAC political contributions
                  {realPac.summary && pacAmount != null
                    ? ` · ${realPac.summary.disbursementCount} contribution${realPac.summary.disbursementCount === 1 ? '' : 's'}`
                    : ''}
                  <br /><span>{pacGivingPeriod(realPac)}</span>
                  {realPac.coverage?.lastSyncedAt ? <><br />Source updated {new Date(realPac.coverage.lastSyncedAt).toLocaleString()}</> : null}
                </div>
                {pacStatus !== 'complete' ? (
                  <p className="capiro-intel-note" role="status" style={{ padding: 0 }}>
                    <strong>{pacStatus === 'error' ? 'Source update failed.' : pacStatus === 'pending' ? 'Awaiting source import.' : 'Partial source coverage.'}</strong>{' '}
                    {realPac.coverage?.message ?? 'A complete source import has not been verified for every mapped committee and reporting cycle.'}
                    {pacAmount != null ? ' The amount shown reflects the available records.' : ' A giving total is not yet available.'}
                  </p>
                ) : null}
                <div className="capiro-intel-bars">
                  {/* Real top recipients. The fixture's Incumbent/Leadership/Party
                      buckets have no equivalent in the data — recipients are named
                      rows, not categories — so they are not reproduced. */}
                  {topPacRecipients(realPac).length === 0 && pacStatus === 'complete' && realPac.summary?.disbursementCount === 0 ? (
                    <p className="capiro-intel-note" style={{ padding: 0 }}>
                      No political contributions were reported for the mapped committees in these completed source imports.
                    </p>
                  ) : (
                    topPacRecipients(realPac).map((r, i, all) => (
                      <span key={`${r.recipientName}-${r.candidateName ?? ''}`} style={{ display: 'block' }}>
                        <span className="capiro-intel-bar-row">
                          <span className="capiro-intel-bar-label">
                            {r.candidateName ?? r.recipientName}
                          </span>
                          <span className="capiro-intel-bar-value">${r.totalAmount.toLocaleString()}</span>
                        </span>
                        <span className="capiro-intel-bar-track">
                          <span
                            className="capiro-intel-bar-fill"
                            style={{
                              // Bars are relative to the largest recipient, so the
                              // width is a real comparison rather than a designed %.
                              width: (all[0]?.totalAmount ?? 0) > 0 ? `${Math.max(0, Math.min(100, Math.round((r.totalAmount / all[0]!.totalAmount) * 100)))}%` : '0%',
                            }}
                          />
                        </span>
                      </span>
                    ))
                  )}
                </div>
              </>
            )
          ) : fecQ.isSuccess ? (
            <CouldNotLoad what="Political giving" error={new Error('The source response did not include PAC giving.')} onRetry={() => void fecQ.refetch()} />
          ) : (
            <LoadingSource what="political giving" />
          )}
        </FootCard>
      </div>

      {/* Lobbying disclosure history */}
      <div ref={filingsRef} tabIndex={-1} aria-label="Lobbying disclosure history">
      <Card>
        <CardHead title="Lobbying disclosure history" />
        {ldaFailed ? (
          <CouldNotLoad what="Lobbying disclosure history" error={ldaQ.error} onRetry={() => void ldaQ.refetch()} />
        ) : !realLda ? (
          <LoadingSource what="lobbying filings" />
        ) : (
          <div className="capiro-intel-table-wrap">
            <div className="capiro-intel-table-inner">
              <div className="capiro-intel-thead">
                <span className="capiro-intel-col-84">Period</span>
                <span className="capiro-intel-col-64">Type</span>
                <span className="capiro-intel-col-flex">Registrant</span>
                <span className="capiro-intel-col-84" style={{ textAlign: 'right' }}>Amount</span>
                <span className="capiro-intel-col-148">Issues</span>
                <span className="capiro-intel-col-196">Entities contacted</span>
                <span className="capiro-intel-col-56">Source</span>
              </div>
              {realLda
                ? realLda.filings.map((r) => (
                    <div key={r.filingUuid} className="capiro-intel-lda-row">
                      <span className="capiro-intel-col-84 capiro-intel-lda-period">
                        {[ldaPeriodLabel(r.filingPeriod), r.filingYear].filter(Boolean).join(' ') || '—'}
                      </span>
                      <span className="capiro-intel-col-64 capiro-intel-lda-type">{r.filingType ? String(r.filingType).toUpperCase() : '—'}</span>
                      <span className="capiro-intel-col-flex capiro-intel-lda-registrant">{titleCaseName(r.registrantName)}</span>
                      <span className="capiro-intel-col-84 capiro-intel-lda-amount">{formatMoney(r.amount)}</span>
                      <span className="capiro-intel-col-148 capiro-intel-lda-meta">{r.issueCodes.join(' · ') || '—'}</span>
                      <span className="capiro-intel-col-196 capiro-intel-lda-meta-trunc">{r.governmentEntities.join(' · ') || '—'}</span>
                      {r.documentUrl ? (
                        <a href={r.documentUrl} target="_blank" rel="noreferrer" className="capiro-intel-lda-view">
                          View
                        </a>
                      ) : (
                        <span className="capiro-intel-col-56 capiro-intel-faint" style={{ fontSize: 13 }}>—</span>
                      )}
                    </div>
                  ))
                : null}
              {realLda && realLda.filings.length === 0 ? (
                <p className="capiro-intel-note" style={{ padding: '16px 24px' }}>No LDA filings on record.</p>
              ) : null}
            </div>
          </div>
        )}
      </Card>

      </div>

      {/* Past performance — moved here from Capabilities §7.3. What the client
          has actually delivered belongs with its lobbying, awards and giving,
          not beside the roster of what it says it can do. Same real
          `ClientSubmissionHistory` reader; nothing about the card changed. */}
      <PastPerformanceCard client={client} />
    </div>
  );
}

function FootCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="capiro-intel-foot-card">
      <div className="capiro-intel-foot-card-head">
        <h3 className="capiro-intel-title-md">{title}</h3>
        <span className="capiro-intel-spacer" />
        {action}
      </div>
      {children}
    </section>
  );
}

/* ═══════════════════════════ §10.6 District Nexus ══════════════════════════ */

interface RealDistrictModel {
  code: string;
  lat: number;
  lon: number;
  facilityNames: string[];
  employeeCount: number | null;
  totalAmount: number | null;
  awardCount: number | null;
  repName: string | null;
  repParty: string | null;
  repChamber: string | null;
  score: number;
  strength: 'Strong' | 'Moderate' | 'Developing';
  ui: PillTone;
}

function tierOf(score: number): { strength: RealDistrictModel['strength']; ui: PillTone } {
  if (score >= 80) return { strength: 'Strong', ui: 'success' };
  if (score >= 60) return { strength: 'Moderate', ui: 'blue' };
  return { strength: 'Developing', ui: 'gray' };
}

/**
 * v1 (`getClientDistrictNexus`) reports real award dollars/counts per district
 * but has no normalized 0-100 nexus score — that scoring model belongs to
 * District Nexus v2, which is feature-flagged and dark for most tenants today.
 * Rather than inventing a precise-looking score this app has no real basis
 * for, real districts get one of two disclosed, coarse tiers (confirmed
 * federal award activity vs. facility presence only); the real dollar/count
 * figures are always shown alongside, never replaced by this tier.
 */
function scoreOf(nexusRow: DistrictNexusRow | undefined): number {
  return nexusRow && nexusRow.totalAmount > 0 ? 75 : 40;
}

function buildRealDistricts(
  facilities: ClientFacility[],
  nexusByDistrict: Map<string, DistrictNexusRow>,
  repByFacilityId: Map<string, RepresentationResult>,
): RealDistrictModel[] {
  const byCode = new Map<string, ClientFacility[]>();
  for (const facility of facilities) {
    const code = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
    if (!code) continue;
    const group = byCode.get(code) ?? [];
    group.push(facility);
    byCode.set(code, group);
  }

  const models: RealDistrictModel[] = [];
  for (const [code, group] of byCode) {
    const geocoded = group.find((f) => f.latitude != null && f.longitude != null);
    if (!geocoded) continue; // no coordinates to plot — still listed in the facilities table below

    const nexusRow = nexusByDistrict.get(code);
    const knownEmployees = group.filter((f): f is ClientFacility & { employeeCount: number } => f.employeeCount != null);

    let repName: string | null = null;
    let repParty: string | null = null;
    let repChamber: string | null = null;
    for (const facility of group) {
      const rep = repByFacilityId.get(facility.id);
      if (rep && !rep.unresolved && rep.federal.house) {
        repName = rep.federal.house.fullName;
        repParty = rep.federal.house.party;
        repChamber = 'House';
        break;
      }
    }

    const score = scoreOf(nexusRow);
    models.push({
      code,
      lat: geocoded.latitude as number,
      lon: geocoded.longitude as number,
      facilityNames: group.map((f) => f.name),
      employeeCount: knownEmployees.length ? knownEmployees.reduce((sum, f) => sum + f.employeeCount, 0) : null,
      totalAmount: nexusRow?.totalAmount ?? null,
      awardCount: nexusRow?.awardCount ?? null,
      repName,
      repParty,
      repChamber,
      score,
      ...tierOf(score),
    });
  }

  return models.sort((a, b) => {
    const byAmount = (b.totalAmount ?? -1) - (a.totalAmount ?? -1);
    if (byAmount !== 0) return byAmount;
    return (b.employeeCount ?? 0) - (a.employeeCount ?? 0);
  });
}

export function facilityStatus(facility: ClientFacility, representation: RepresentationResult | undefined): { label: string; tone: PillTone } {
  const district = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
  if (!district) return { label: 'U.S. House district missing', tone: 'warning' };
  if (representation && !representation.unresolved && representation.federal.house) {
    const house = representation.federal.house;
    const houseDistrict = house.district == null ? '' : formatFacilityDistrict(resolveUsStateCode(house.state), String(house.district));
    if (houseDistrict !== district) return { label: 'Representation mismatch', tone: 'warning' };
    return { label: 'Matches saved district', tone: 'success' };
  }
  return { label: 'Representative not resolved', tone: 'warning' };
}

function DistrictPanel({ client }: { client: Client }) {
  const api = useApi();
  const [selected, setSelected] = useState<string | null>(null);

  const v2Q = useDistrictNexusV2(client, true);
  const facilitiesQ = useClientFacilities(client.id);
  const nexusQ = useQuery({
    queryKey: ['client-district-nexus', client.id],
    queryFn: () => getClientDistrictNexus(api, client.id),
    staleTime: 2 * 60_000,
  });
  const representationQ = useQuery({
    queryKey: ['client-representation', client.id],
    queryFn: () => getClientRepresentation(api, client.id),
    staleTime: 2 * 60_000,
  });

  const facilitiesLoaded = facilitiesQ.data !== undefined && !facilitiesQ.isError;
  const v2 = v2Q.data ?? null;
  const v2Settled = v2Q.data !== undefined || v2Q.isError || !v2Q.isLoading;
  // Two distinct v2 failure modes, previously conflated: (a) request ERROR
  // (500, timeout) was silently treated like the 404-disabled path, so a real
  // outage looked exactly like "the feature is off"; (b) feature-disabled→404
  // is a configuration answer and falls through to v1 quietly.
  const v2Failed = v2Q.isError;

  const nexusByDistrict = useMemo(() => {
    const map = new Map<string, DistrictNexusRow>();
    if (nexusQ.data?.linked) for (const row of nexusQ.data.districts) map.set(row.district, row);
    return map;
  }, [nexusQ.data]);
  const repByFacilityId = useMemo(
    // A failed representation fetch used to degrade to `new Map([])` — every
    // facility then honestly-rendered as "unmatched", which reads as data,
    // not outage. `representationQ.isError` is now surfaced in the v1 list
    // header instead (below), and unresolved rows stay out of the mismatch
    // vocabulary entirely until the request answers.
    () => new Map((representationQ.data ?? []).map((r) => [r.facility.id, r.representation])),
    [representationQ.data],
  );
  const v1List = useMemo(
    () =>
      facilitiesLoaded && facilitiesQ.data!.length > 0
        ? buildRealDistricts(facilitiesQ.data!, nexusByDistrict, repByFacilityId)
        : [],
    [facilitiesLoaded, facilitiesQ.data, nexusByDistrict, repByFacilityId],
  );
  const ungeocodedCount = facilitiesLoaded
    ? facilitiesQ.data!.filter((f) => f.latitude == null || f.longitude == null).length
    : 0;

  /** House rep for a v2 districtKey, resolved through the facility pipeline. */
  const repForDistrict = useMemo(() => {
    const out = new Map<string, { name: string; party: string | null }>();
    for (const facility of facilitiesQ.data ?? []) {
      const code = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
      if (!code) continue;
      const [state, no] = code.split('-');
      const key = `${state}-${(no ?? '').padStart(2, '0')}`;
      if (out.has(key)) continue;
      const rep = repByFacilityId.get(facility.id);
      if (rep && !rep.unresolved && rep.federal.house) {
        out.set(key, { name: rep.federal.house.fullName, party: rep.federal.house.party });
      }
    }
    return out;
  }, [facilitiesQ.data, repByFacilityId]);

  // ── loading / error / empty gates (no design fixture, ever) ──────────────
  if (!v2Settled || (!v2 && !facilitiesLoaded && !facilitiesQ.isError)) {
    return (
      <Card>
        <div className="capiro-intel-skeleton-wrap" aria-busy="true">
          <div className="capiro-intel-skeleton-block" style={{ height: 18, width: 220 }} />
          <div className="capiro-intel-skeleton-panel" style={{ marginTop: 16, height: 380 }} />
        </div>
      </Card>
    );
  }

  if (!v2 && facilitiesQ.isError) {
    return (
      <Card>
        <div className="capiro-intel-error-wrap">
          <h3 className="capiro-intel-title-md">District data could not be loaded</h3>
          <p className="capiro-intel-body" style={{ margin: '8px 0 16px', lineHeight: '20px' }}>
            {facilitiesQ.error instanceof Error ? facilitiesQ.error.message : 'The facilities service did not answer.'}
          </p>
          <SecondaryBtn onClick={() => void facilitiesQ.refetch()}>Retry</SecondaryBtn>
        </div>
      </Card>
    );
  }

  // A v2 REQUEST failure (not the 404 feature-off answer) must say so above
  // whichever view ends up rendering — the v1 fallback below is real data,
  // but the user asked for the scored view and it failed, not vanished.
  const v2FailureNotice = v2Failed ? (
    <p role="alert" className="capiro-intel-v2-error">
      Scored district data is unavailable right now — showing the facility view instead.{' '}
      {v2Q.error instanceof Error && v2Q.error.message ? v2Q.error.message : null}{' '}
      <button type="button" className="capiro-intel-v2-error__retry" onClick={() => void v2Q.refetch()}>
        Retry
      </button>
    </p>
  ) : null;

  const v2Districts = v2 ? [...v2.districts].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : [];

  if (v2 && (v2Districts.length > 0 || (facilitiesQ.data ?? []).some((f) => f.latitude != null && f.longitude != null))) {
    const effectiveSelected =
      selected && v2Districts.some((d) => d.districtKey === selected)
        ? selected
        : (v2.bestDistrictKey ?? v2Districts[0]?.districtKey ?? null);
    const sel = v2Districts.find((d) => d.districtKey === effectiveSelected) ?? null;
    const selBand = sel ? bandOf(sel.score) : null;
    const selRep = sel ? repForDistrict.get(sel.districtKey) : undefined;

    return (
      <div className="capiro-intel-stack-24">
        {v2FailureNotice}
        <Card>
          <div className="capiro-intel-panel-head">
            <span className="capiro-intel-panel-head-copy">
              <span className="capiro-intel-title-md" style={{ display: 'block' }}>District footprint</span>
              <span className="capiro-intel-body" style={{ display: 'block', marginTop: 4 }}>
                Verified client footprint, public funding, and representation by congressional district — the same scoring District Nexus uses. Select a district on the map or in the list.
              </span>
            </span>
            <Pill tone="gray" dotless>
              {v2Districts.length} district{v2Districts.length === 1 ? '' : 's'} · {Math.round(v2.coveragePercent)}% coverage
            </Pill>
          </div>
          <div className="cap-pf-map-cols">
            <div className="cap-pf-map-frame">
              <Suspense fallback={<div className="cap-pf-dn-loading" aria-busy="true" aria-label="Loading map" />}>
                <DistrictNexusMapLibreLazy
                  districts={v2Districts}
                  facilities={facilitiesQ.data ?? []}
                  selectedDistrictKey={effectiveSelected}
                  onSelectDistrict={setSelected}
                />
              </Suspense>
            </div>
            <div className="capiro-intel-rail-col">
              {v2Districts.map((d) => (
                <V2DistrictRailRow
                  key={d.districtKey}
                  d={d}
                  selected={effectiveSelected === d.districtKey}
                  onSelect={() => setSelected(d.districtKey)}
                />
              ))}
            </div>
          </div>
          {ungeocodedCount > 0 ? (
            <p className="capiro-intel-note" style={{ padding: '14px 24px 18px' }}>
              {ungeocodedCount} location{ungeocodedCount === 1 ? ' needs' : 's need'} an address match before appearing on the map. Open Manage facilities to review and resolve the address.
            </p>
          ) : null}
        </Card>

        {sel ? (
          <div className="cap-pf-grid-dist">
            <Card>
              <CardHead title="Selected district" />
              <div className="capiro-intel-district-body">
                <div className="capiro-intel-row-wrap">
                  <span className="capiro-intel-value-xl">{sel.districtKey}</span>
                  {selBand ? (
                    <Pill tone={selBand.id === 'strong' ? 'success' : selBand.id === 'moderate' ? 'blue' : 'gray'} size="lg">
                      {selBand.label} nexus · {sel.score}
                    </Pill>
                  ) : (
                    <Pill tone="gray" size="lg" dotless>
                      Unscored — below the coverage floor
                    </Pill>
                  )}
                </div>
                <div className="capiro-intel-eyebrow" style={{ marginTop: 14 }}>Federal representative</div>
                <div className="capiro-intel-rep-line">
                  {selRep ? `${selRep.name}${partyLabel(selRep.party) ? ` (${partyLabel(selRep.party)})` : ''} · House` : 'Not yet resolved'}
                </div>
                <div className="capiro-intel-tiles">
                  {(
                    [
                      ['Contract obligations', formatMoney(sel.awarded.contractObligations)],
                      ['Grant obligations', formatMoney(sel.awarded.grantObligations)],
                      ['Employees', sel.employeeCount != null ? formatNumber(sel.employeeCount) : sel.employeesUnreported ? 'Not reported' : '—'],
                      ['Evidence coverage', `${Math.round(sel.coveragePercent)}%`],
                    ] as const
                  ).map(([label, tileValue]) => (
                    <span key={label} className="capiro-intel-tile">
                      <span className="capiro-intel-eyebrow-xs">{label}</span>
                      <span className="capiro-intel-tile-value">{tileValue}</span>
                    </span>
                  ))}
                </div>
              </div>
            </Card>

            <FacilitiesRepresentationCard
              facilities={facilitiesQ.data ?? []}
              repByFacilityId={repByFacilityId}
            />
          </div>
        ) : null}
      </div>
    );
  }

  // ── v2 present but empty, or v2 dark — the v1 facility view ──────────────
  const genuinelyEmpty = facilitiesLoaded && facilitiesQ.data!.length === 0;
  if (genuinelyEmpty) {
    return (
      <Card>
        <div className="capiro-intel-empty">
          <h3 className="capiro-intel-title-md">No facilities recorded for this client</h3>
          <p className="capiro-intel-body" style={{ margin: '8px 0 0', lineHeight: '20px' }}>
            District Nexus builds on this client&apos;s recorded facility addresses. Add a facility to see its
            congressional district, representative, and any confirmed federal award activity here.
          </p>
        </div>
      </Card>
    );
  }

  const effectiveSelected = selected && v1List.some((d) => d.code === selected) ? selected : (v1List[0]?.code ?? null);
  const sel = v1List.find((d) => d.code === effectiveSelected) ?? null;

  return (
    <div className="capiro-intel-stack-24">
      {v2FailureNotice}
      {representationQ.isError ? (
        // Without this the failed representation fetch silently read as
        // "every facility unmatched" — data, not outage.
        <p role="alert" className="capiro-intel-v2-error">
          Representation for these facilities could not be resolved — district rows below show location and award data only.{' '}
          <button type="button" className="capiro-intel-v2-error__retry" onClick={() => void representationQ.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      <Card>
        <div className="capiro-intel-panel-head">
          <span className="capiro-intel-panel-head-copy">
            <span className="capiro-intel-title-md" style={{ display: 'block' }}>District footprint</span>
            <span className="capiro-intel-body" style={{ display: 'block', marginTop: 4 }}>
              Real facility locations and confirmed federal award activity by congressional district. Select a district on the map or in the list.
            </span>
          </span>
          <Pill tone="gray" dotless>{v1List.length} district{v1List.length === 1 ? '' : 's'}</Pill>
        </div>
        {v1List.length === 0 && !(facilitiesQ.data ?? []).some((f) => f.latitude != null && f.longitude != null) ? (
          <p className="capiro-intel-note" style={{ padding: '0 24px 20px' }}>
            {ungeocodedCount > 0
              ? `${ungeocodedCount} facilit${ungeocodedCount === 1 ? 'y is' : 'ies are'} recorded but not yet geocoded, so no district can be plotted yet.`
              : 'No facility has resolved to a congressional district yet.'}
          </p>
        ) : (
          <div className="cap-pf-map-cols">
            <div className="cap-pf-map-frame">
              <Suspense fallback={<div className="cap-pf-dn-loading" aria-busy="true" aria-label="Loading map" />}>
                <DistrictNexusMapLibreLazy
                  facilities={facilitiesQ.data ?? []}
                  metric="clients"
                  districts={v1List.map((d) => ({
                    districtKey: d.code, state: d.code.split('-')[0]!, districtCode: d.code.split('-')[1]!,
                    name: d.code, status: 'C' as const, clientCount: 1,
                    // The legacy response has no normalized nexus score.
                    score: null, coveragePercent: 0, employeeCount: d.employeeCount,
                    employeesUnreported: d.employeeCount == null, warnings: [],
                    awarded: { contractObligations: d.totalAmount, grantObligations: null, grantOutlays: null },
                    opportunities: { opportunityEstimatedFunding: null, opportunityAwardCeiling: null },
                  }))}
                  selectedDistrictKey={effectiveSelected}
                  onSelectDistrict={setSelected}
                />
              </Suspense>
            </div>
            <div className="capiro-intel-rail-col">
              {v1List.map((d) => (
                <RealDistrictRailRow key={d.code} d={d} selected={effectiveSelected === d.code} onSelect={() => setSelected(d.code)} />
              ))}
            </div>
          </div>
        )}
        {ungeocodedCount > 0 && v1List.length > 0 ? (
          <p className="capiro-intel-caption-muted" style={{ margin: 0, padding: '0 24px 18px' }}>
            {ungeocodedCount} more facilit{ungeocodedCount === 1 ? 'y is' : 'ies are'} recorded but not yet geocoded.
          </p>
        ) : null}
        {nexusQ.data && !nexusQ.data.linked ? (
          <p className="capiro-intel-caption-muted" style={{ margin: 0, padding: '0 24px 18px' }}>{nexusQ.data.disclaimer}</p>
        ) : null}
      </Card>

      {sel ? (
        <div className="cap-pf-grid-dist">
          <Card>
            <CardHead title="Selected district" />
            <div className="capiro-intel-district-body">
              <div className="capiro-intel-row-wrap">
                <span className="capiro-intel-value-xl">{sel.code}</span>
                <Pill tone={sel.ui} size="lg">{sel.strength} nexus</Pill>
              </div>
              <div className="capiro-intel-eyebrow" style={{ marginTop: 14 }}>Federal representative</div>
              <div className="capiro-intel-rep-line">
                {sel.repName ? `${sel.repName}${partyLabel(sel.repParty) ? ` (${partyLabel(sel.repParty)})` : ''} · ${sel.repChamber}` : 'Not yet resolved'}
              </div>
              <div className="capiro-intel-tiles">
                {(
                  [
                    ['Facilities', sel.facilityNames.join(', ') || '—'],
                    ['Employees', sel.employeeCount != null ? formatNumber(sel.employeeCount) : 'Needs count'],
                    ['Federal awards', sel.totalAmount != null ? formatMoney(sel.totalAmount) : 'No confirmed awards'],
                    ['Awards on record', sel.awardCount != null ? formatNumber(sel.awardCount) : '—'],
                  ] as const
                ).map(([label, tileValue]) => (
                  <span key={label} className="capiro-intel-tile">
                    <span className="capiro-intel-eyebrow-xs">{label}</span>
                    <span className="capiro-intel-tile-value">{tileValue}</span>
                  </span>
                ))}
              </div>
            </div>
          </Card>

          <FacilitiesRepresentationCard
            facilities={facilitiesQ.data ?? []}
            repByFacilityId={repByFacilityId}
          />
        </div>
      ) : (
        <FacilitiesRepresentationCard facilities={facilitiesQ.data ?? []} repByFacilityId={repByFacilityId} />
      )}
    </div>
  );
}

function RealDistrictRailRow({ d, selected, onSelect }: { d: RealDistrictModel; selected: boolean; onSelect: () => void }) {
  // Data-driven (varies per row by score), so it stays inline — but points at
  // the same tokens the rest of the file's text hierarchy uses, never a raw hex.
  const dot = d.score >= 80
    ? 'var(--capiro-color-text-primary)'
    : d.score >= 60
      ? 'var(--capiro-color-text-body-secondary)'
      : 'var(--capiro-color-text-faint)';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={selected ? 'capiro-intel-district-row capiro-intel-district-row--selected' : 'capiro-intel-district-row'}
    >
      <span className="capiro-intel-district-dot" style={{ background: dot }} />
      <span className="capiro-intel-district-main">
        <span className="capiro-intel-district-top">
          <span className="capiro-intel-district-code">{d.code}</span>
          <span className="capiro-intel-district-tag">
            {d.facilityNames[0]}
            {d.facilityNames.length > 1 ? ` +${d.facilityNames.length - 1}` : ''}
          </span>
        </span>
        <span className="capiro-intel-district-sub">
          {d.totalAmount != null ? formatMoney(d.totalAmount) : 'No confirmed awards'}
          {d.employeeCount != null ? ` · ${formatNumber(d.employeeCount)} employees` : ''}
        </span>
      </span>
    </button>
  );
}

/** Rail row for a v2 (scored) district — band-colored dot, real obligations. */
function V2DistrictRailRow({
  d,
  selected,
  onSelect,
}: {
  d: DistrictNexusDistrictDetail;
  selected: boolean;
  onSelect: () => void;
}) {
  const band: ScoreBand | null = bandOf(d.score);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={selected ? 'capiro-intel-district-row capiro-intel-district-row--selected' : 'capiro-intel-district-row'}
    >
      <span
        title={band ? `${band.label} nexus` : 'Unscored'}
        className="capiro-intel-district-dot"
        style={{ background: band?.color ?? 'var(--capiro-color-border-control)' }}
      />
      <span className="capiro-intel-district-main">
        <span className="capiro-intel-district-top">
          <span className="capiro-intel-district-code">{d.districtKey}</span>
          <span className="capiro-intel-district-tag">
            {band ? band.label : 'Unscored'}
          </span>
        </span>
        <span className="capiro-intel-district-sub">
          {d.awarded.contractObligations != null || d.awarded.grantObligations != null
            ? `${formatMoney(d.awarded.contractObligations)} contracts · ${formatMoney(d.awarded.grantObligations)} grants`
            : 'No confirmed awards'}
          {d.employeeCount != null ? ` · ${formatNumber(d.employeeCount)} employees` : ''}
        </span>
      </span>
      <span className="capiro-intel-district-score">{d.score ?? '—'}</span>
    </button>
  );
}

/** Facilities table shared by the v1 and v2 layouts — always real rows. */
function FacilitiesRepresentationCard({
  facilities,
  repByFacilityId,
}: {
  facilities: ClientFacility[];
  repByFacilityId: Map<string, RepresentationResult>;
}) {
  return (
    <Card>
      <CardHead title="Facilities & representation" />
      <div>
        {facilities.length === 0 ? (
          <p className="capiro-intel-caption-muted" style={{ margin: 0, padding: '18px 24px', fontSize: 14 }}>No facilities recorded.</p>
        ) : (
          facilities.map((f) => {
            const representation = repByFacilityId.get(f.id);
            const { label, tone } = facilityStatus(f, representation);
            const repName = representation && !representation.unresolved ? representation.federal.house?.fullName : null;
            return (
              <div key={f.id} className="capiro-intel-fac-row">
                <div className="capiro-intel-fac-location">
                  <span className="capiro-intel-fac-name">{f.name}</span>
                  <FacilityVerification facility={f} />
                </div>
                <div className="capiro-intel-fac-representation">
                  <span className="capiro-intel-fac-emp">{f.employeeCount != null ? `${formatNumber(f.employeeCount)} employees` : 'Employee count not reported'}</span>
                  <span className="capiro-intel-fac-rep">U.S. House representative: {repName ?? 'Not resolved'}</span>
                  <Pill tone={tone}>{label}</Pill>
                </div>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
